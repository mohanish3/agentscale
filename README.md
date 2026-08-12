# agentscale

On-demand cloud infrastructure for agent workers, built for scaled orgs running many concurrent AI agents.

`agentscale` provisions and manages AWS-backed worker pools for agent execution, and exposes a single
integration surface — webhooks, inbound events, n8n workflows, and custom LangChain servers all dispatch
into the same worker pool.

## What it does

- **On-demand AWS worker pools** — ECS Fargate-backed agent workers, autoscaled on CPU utilization (see `infra/aws/`).
- **Native integrations** — inbound webhooks with per-provider signature verification (see `src/integrations/`).
- **n8n workflow ingestion** — accepts n8n workflow JSON exports and runs them as agent task graphs (see `src/n8n/`).
- **Custom LangChain servers** — register an existing LangChain server as a worker backend (see `src/langchainWorkers/`).
- **Orchestration API** — scale the worker pool and check worker health (see `src/orchestrator/`).

Two processes: an **API** (`src/index.js`) that receives work, and a **worker** (`src/worker.js`)
that executes it. Everything dispatches into one queue (`src/queue.js`); workers pull from it
with `POST /tasks/next`, run the task, and report the outcome to `POST /tasks/:id/result`.

## Delivery guarantees

Tasks are delivered **at least once**. A worker leases a task rather than removing it, and the
lease expires unless the worker reports back — so a worker that crashes mid-task doesn't take
the task with it. A reported failure is retried the same way. After `TASK_MAX_ATTEMPTS`
deliveries (default 3) a task is given up on, marked `failed`, and dead-lettered — so one poison
task can't cycle forever, and `GET /tasks/dead-letter` / `POST /tasks/:id/replay` are how you
look at it and put it back once whatever it was tripping over is fixed.

Two consequences worth designing around:

- **Your agent must tolerate running twice.** At-least-once means a redelivery can duplicate work
  that already partly happened.
- **A long agent run holds its lease by renewing it.** Workers renew every half of
  `TASK_VISIBILITY_MS` (default 5 min) while `handle()` runs, so a slow task isn't handed to a
  second worker just for taking a while — you don't need to raise the visibility window to cover
  your slowest run. Renewal is capped at `TASK_MAX_LEASE_MS` (default 1h) per delivery: a worker
  wedged on something that never returns keeps renewing, and without a ceiling the task would
  never come back at all. Past the cap the lease lapses as if the worker had died, so the
  worst case for one task is roughly `TASK_MAX_LEASE_MS` × `TASK_MAX_ATTEMPTS`.

Webhook redeliveries are deduplicated by the provider's delivery id (`X-GitHub-Delivery`,
Stripe's event `id`, or `X-Idempotency-Key` for `generic`), so a provider retrying doesn't run
the agent a second time. A retry returns `202` with the original task id — which may name a task
that has already succeeded, or one that exhausted its attempts and failed. The delivery is
treated as handled either way; check `GET /tasks/:id` rather than assuming `202` means running.

Reports carry the `leaseToken` handed out with the task. A worker whose lease expired mid-run
gets `409` when it finally reports, and its result is discarded rather than overwriting the
worker that took the task over.

**Results don't live forever.** A finished task — succeeded, failed, or dead-lettered — is kept
for `TASK_RETENTION_MS` (default 24h) and then dropped, so a long-running API doesn't accumulate
every task it has ever seen. `GET /tasks/:id` on an aged-out task returns `404`, and its webhook
dedupe key goes with it, so a redelivery arriving after the window runs the agent again. Keep the
window comfortably longer than your senders' retry schedules. Work that hasn't finished is never
dropped, however long it sits queued.

## Quickstart

```bash
cp .env.example .env     # set WORKER_TOKEN
docker compose up --build
```

That brings up the API on `:8000` and a worker polling it. Submit a workflow and read the result:

```bash
TOKEN=local-dev-token
curl -s localhost:8000/n8n/workflows -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "name": "demo",
    "nodes": [{"name": "fetch"}, {"name": "summarize"}],
    "connections": {"fetch": {"main": [[{"node": "summarize"}]]}}
  }'
# {"taskId":"1","steps":["fetch","summarize"]}

curl -s localhost:8000/tasks/1 -H "authorization: Bearer $TOKEN"
# {"status":"succeeded","result":{...},"completedAt":"..."}
```

Add workers with `docker compose up --scale worker=8`.

CI (`.github/workflows/ci.yml`) builds the image and drives a task through compose end to end on
every PR, so this path stays proven rather than assumed.

### Without Docker

```bash
npm install
WORKER_TOKEN=local-dev-token npm start     # API
WORKER_TOKEN=local-dev-token npm run worker # worker, in a second shell
```

Run tests: `npm test` (Node's built-in test runner, no extra dependencies).

## Writing your agent

`handle(task)` in `src/worker.js` is the plug point. It receives a task and returns the result
that lands on `GET /tasks/:id`; throwing marks the task failed. The shipped default resolves
what it was handed so the pipeline runs end to end before you have an agent runtime attached.

However long `handle()` takes, the worker renews the lease underneath it — you don't have to
report progress or tune a timeout per agent. What you do have to handle is being run twice; see
delivery guarantees above.

## API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | public | Liveness. |
| `POST /integrations/:provider/webhook` | signature | Verified inbound webhook. `provider` is `github`, `stripe` or `generic`. |
| `POST /n8n/workflows` | token | Ingest an n8n workflow export; returns its dependency-ordered steps. |
| `POST /langchain/servers` | token | Register a LangChain server: `{ "name": "...", "url": "https://..." }`. |
| `GET /langchain/servers` | token | List registered servers. |
| `POST /langchain/servers/:name/dispatch` | token | Invoke a registered server with `{ "input": ... }`. |
| `POST /orchestrator/scale` | token | Recompute desired worker count from queue depth. Optional body: `tasksPerWorker`, `min`, `max`. |
| `GET /orchestrator/workers` | token | Desired count, queue depth and per-worker health. |
| `POST /orchestrator/workers/:id/heartbeat` | token | Worker liveness ping (unhealthy after 30s of silence, dropped from the list after 5 min). |
| `POST /tasks/next` | token | Worker leases the next task; `204` when nothing is waiting. |
| `POST /tasks/:id/result` | token | Release the lease with `{ status: "succeeded", result }` or `{ status: "failed", error }`. |
| `POST /tasks/:id/renew` | token | Extend the lease on a task still running: `{ "leaseToken": "..." }`. `409` once the lease is gone — superseded, or held past `TASK_MAX_LEASE_MS`. |
| `GET /tasks/:id` | token | Task state: `queued`, `running`, `succeeded` or `failed`. `404` for an unknown id, or one whose record has aged out past `TASK_RETENTION_MS`. |
| `GET /tasks/dead-letter` | token | Tasks that exhausted `TASK_MAX_ATTEMPTS`, for inspection. In-process, like the queue — gone on restart. |
| `POST /tasks/:id/replay` | token | Re-queue a dead-lettered task with a clean attempt count. `404` if it isn't dead-lettered. |

### Worker/control auth

Everything marked `token` above requires `Authorization: Bearer $WORKER_TOKEN` — draining the
queue exposes every task payload, and registering a LangChain server decides where task input
gets sent. `WORKER_TOKEN` accepts a comma-separated list, so callers can hold distinct tokens
instead of one secret shared across the whole pool. As with the webhook secrets, an unset
`WORKER_TOKEN` **refuses** (`503`) rather than serving these open.

### Webhook secrets

Signatures are verified against the raw request bytes with a constant-time compare. A webhook
whose secret is unset is **rejected** (`503`), never accepted unverified.

| Provider | Env var | Header |
| --- | --- | --- |
| `github` | `GITHUB_WEBHOOK_SECRET` | `X-Hub-Signature-256` |
| `stripe` | `STRIPE_WEBHOOK_SECRET` | `Stripe-Signature` |
| `generic` | `GENERIC_WEBHOOK_SECRET` | `X-Signature-256` |

Stripe signatures are additionally rejected outside a 5-minute tolerance window, so a captured
request cannot be replayed indefinitely.

### Registering a LangChain server

`POST /langchain/servers` tells the API a URL to POST to, and `dispatch` returns the response
body to the caller — so the registry is a request primitive aimed at whatever the API process can
reach. The link-local range (`169.254.0.0/16`: EC2 IMDS and the ECS task-role credential
endpoint) is refused by default, and dispatch won't follow redirects. Set
`LANGCHAIN_ALLOWED_HOSTS` to a comma-separated allowlist anywhere the API holds credentials worth
reading — it replaces the default block entirely, and it's the only check that covers a DNS name
resolving into that range.

### Shutdown

Both roles stop on `SIGTERM`/`SIGINT`: the API stops accepting connections and lets in-flight
requests finish, and the worker finishes its current task before exiting. Neither preserves the
queue — it lives in the API process, so anything still queued or leased is lost on restart. Drain
your senders before a deploy, or wait for `GET /orchestrator/workers` to report a queue depth of
zero.

## Project layout

```
src/
  index.js                 Express API entrypoint
  worker.js                Worker loop — pulls, executes, reports
  queue.js                 Shared task queue every surface dispatches into
  integrations/            Webhook receivers + native integration connectors
  n8n/                     n8n workflow ingestion
  langchainWorkers/        Custom LangChain server registration + dispatch
  orchestrator/            Worker pool scaling + health API
Dockerfile                 One image, both roles (worker overrides the command)
docker-compose.yml         Local API + workers
infra/aws/                 Terraform for the AWS worker pool
test/                      Test suite (node --test)
```

Configuration is documented in `.env.example`.

## Status

Runs end to end locally: submit work, a worker executes it, read the result back. Known limits,
in the order they'll bite you.

**The queue lives in the API process.** Workers scale horizontally — run as many as you like
against one API — but the **API does not**. Two API replicas means two disjoint queues, and a
webhook landing on one is invisible to workers polling the other. This is the ceiling on
everything below, and it makes "scaled by queue depth" true only for a single API instance.
Fixing it means SQS (or Redis/Postgres), keeping the in-memory queue as the driver that lets
tests and `docker compose up` run without cloud credentials.

Also outstanding:

- **No deployment for the API.** `infra/aws` provisions the *worker pool* only — there's no
  load balancer and no service for `src/index.js`, so nothing receives webhooks in AWS yet. The
  Terraform also has no provider/backend/root module, and expects you to bring your own VPC.
- **`POST /orchestrator/scale` records a number and calls nothing.** The worker pool does scale
  now — `infra/aws` wires an ECS Application Auto Scaling target-tracking policy on the
  service — but it tracks CPU utilization, not queue depth, because queue depth lives in this
  process rather than a CloudWatch metric ECS can read. This endpoint is still informational
  only until the queue itself moves out of process.
- **Long agent runs can double-execute.** No lease renewal, so a task outliving
  `TASK_VISIBILITY_MS` is handed to a second worker while the first still holds it.
- Task records, results and the LangChain registry are in-memory, so they clear on restart.
  Task records are no longer unbounded — anything finished ages out after `TASK_RETENTION_MS`
  (24h default), which also drops its webhook dedupe key, so a redelivery older than that window
  runs the agent again. The LangChain registry still has no expiry. Dead-lettered tasks (`GET
  /tasks/dead-letter`) are inspectable and replayable within the retention window, but they're
  not a durable DLQ until the queue is.
- **A registered LangChain server is a URL the API will POST to and return the body from.**
  The link-local range is blocked by default so a leaked `WORKER_TOKEN` isn't also an AWS
  credential read, but that check is hostname-only — a DNS name resolving there, or a redirect,
  still gets through. Set `LANGCHAIN_ALLOWED_HOSTS` anywhere the API holds real credentials.
