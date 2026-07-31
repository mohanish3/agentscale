# agentscale

On-demand cloud infrastructure for agent workers, built for scaled orgs running many concurrent AI agents.

`agentscale` provisions and manages AWS-backed worker pools for agent execution, and exposes a single
integration surface — webhooks, inbound events, n8n workflows, and custom LangChain servers all dispatch
into the same worker pool.

## What it does

- **On-demand AWS worker pools** — ECS Fargate-backed agent workers, scaled by queue depth (see `infra/aws/`).
- **Native integrations** — inbound webhooks with per-provider signature verification (see `src/integrations/`).
- **n8n workflow ingestion** — accepts n8n workflow JSON exports and runs them as agent task graphs (see `src/n8n/`).
- **Custom LangChain servers** — register an existing LangChain server as a worker backend (see `src/langchainWorkers/`).
- **Orchestration API** — scale the worker pool and check worker health (see `src/orchestrator/`).

Everything dispatches into one in-process queue (`src/queue.js`); workers pull from it with
`POST /tasks/next` and the orchestrator sizes the pool off its depth.

## Quickstart

```bash
npm install
npm start
```

```bash
curl http://localhost:8000/health
```

Run tests: `npm test` (Node's built-in test runner, no extra dependencies).

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness. |
| `POST /integrations/:provider/webhook` | Verified inbound webhook. `provider` is `github`, `stripe` or `generic`. |
| `POST /n8n/workflows` | Ingest an n8n workflow export; returns its dependency-ordered steps. |
| `POST /langchain/servers` | Register a LangChain server: `{ "name": "...", "url": "https://..." }`. |
| `GET /langchain/servers` | List registered servers. |
| `POST /langchain/servers/:name/dispatch` | Invoke a registered server with `{ "input": ... }`. |
| `POST /orchestrator/scale` | Recompute desired worker count from queue depth. Optional body: `tasksPerWorker`, `min`, `max`. |
| `GET /orchestrator/workers` | Desired count, queue depth and per-worker health. |
| `POST /orchestrator/workers/:id/heartbeat` | Worker liveness ping (workers are unhealthy after 30s of silence). |
| `POST /tasks/next` | Worker pulls the next queued task; `204` when the queue is empty. |

### Webhook secrets

Signatures are verified against the raw request bytes with a constant-time compare. A webhook
whose secret is unset is **rejected** (`503`), never accepted unverified.

| Provider | Env var | Header |
| --- | --- | --- |
| `github` | `GITHUB_WEBHOOK_SECRET` | `X-Hub-Signature-256` |
| `stripe` | `STRIPE_WEBHOOK_SECRET` | `Stripe-Signature` |
| `generic` | `GENERIC_WEBHOOK_SECRET` | `X-Signature-256` |

## Project layout

```
src/
  index.js                 Express app entrypoint
  queue.js                 Shared task queue every surface dispatches into
  integrations/            Webhook receivers + native integration connectors
  n8n/                     n8n workflow ingestion
  langchainWorkers/        Custom LangChain server registration + dispatch
  orchestrator/            Worker pool scaling + health API
infra/aws/                 Terraform for the AWS worker pool
test/                      Test suite (node --test)
```

## Status

All modules above are implemented and tested. Two deliberate limits, marked with `ponytail:`
comments in the source:

- The task queue and LangChain server registry are **in-process** — they do not survive a restart
  or span replicas. Move to SQS and a shared store when workers run outside this process.
- `POST /orchestrator/scale` computes and records the target worker count but does not call AWS;
  the Fargate service still takes its `desired_count` from Terraform. Wiring it to ECS
  `UpdateService` needs `@aws-sdk/client-ecs` and a real pool to scale against.
