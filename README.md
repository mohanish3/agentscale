# agentscale

On-demand cloud infrastructure for agent workers, built for scaled orgs running many concurrent AI agents.

`agentscale` provisions and manages AWS-backed worker pools for agent execution, and exposes a single
integration surface — webhooks, inbound events, n8n workflows, and custom LangChain servers all dispatch
into the same worker pool.

## What it does

- **On-demand AWS worker pools** — ECS Fargate-backed agent workers, scaled by queue depth (see `infra/aws/`).
- **Native integrations** — inbound webhooks with per-provider signature verification (see `app/integrations/`).
- **n8n workflow ingestion** — accepts n8n workflow JSON exports and runs them as agent task graphs (see `app/n8n/`).
- **Custom LangChain servers** — register an existing LangChain server as a worker backend (see `app/langchain_workers/`).
- **Orchestration API** — scale the worker pool and check worker health (see `src/orchestrator/`).

## Quickstart

```bash
npm install
npm start
```

```bash
curl http://localhost:8000/health
```

Run tests: `npm test` (Node's built-in test runner, no extra dependencies).

## Project layout

```
src/
  index.js                Express app entrypoint
  integrations/            Webhook receivers + native integration connectors
  n8n/                     n8n workflow ingestion
  langchainWorkers/        Custom LangChain server registration + dispatch
  orchestrator/            Worker pool scaling + health API
infra/aws/                 Terraform for the AWS worker pool
test/                      Test suite (node --test)
```

## Status

Early scaffold. Modules are being built out incrementally — see open PRs for in-progress work.
