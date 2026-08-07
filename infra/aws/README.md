# AWS infra

Terraform module for the agent worker pool: `modules/worker_pool` provisions an ECS Fargate
cluster/service that runs the agent worker container, with an Application Auto Scaling target
tracking CPU utilization — `desired_count` only sets the starting size.

## Usage

```hcl
module "worker_pool" {
  source                  = "./modules/worker_pool"
  image                   = "<account>.dkr.ecr.<region>.amazonaws.com/agentscale-worker:latest"
  desired_count           = 3
  min_capacity            = 1
  max_capacity            = 10
  subnet_ids              = ["subnet-xxxx"]
  security_group_ids      = ["sg-xxxx"]
  agentscale_url          = "https://api.example.com"
  worker_token_secret_arn = aws_secretsmanager_secret.worker_token.arn
}
```

`image` is built from the `Dockerfile` at the repo root. The module overrides its default
`CMD ["node", "src/index.js"]` with `["node", "src/worker.js"]` on the task definition, and sets
`AGENTSCALE_URL` in the container environment — the same two things `docker-compose.yml`'s
`worker` service does. `WORKER_TOKEN` is pulled from Secrets Manager at task start instead
(`secrets`, not `environment`) — create the secret yourself and pass its ARN; the module grants
the execution role read access to exactly that ARN. Pass `task_role_arn` if your agent runtime
needs AWS permissions of its own (S3, Bedrock, etc.); left unset, the container gets none beyond
the execution role.

Scaling reacts to CPU, not queue depth — the queue lives in the API process, not a CloudWatch
metric, so ECS Application Auto Scaling can't read it directly. `POST /orchestrator/scale`
(`src/orchestrator/`) still only computes a target count and doesn't call AWS; see
`WAYFINDER.md` for what queue-depth-driven scaling needs first.

Still missing before this is deployable: a provider/region/backend block, a root module, and a
service and load balancer for the API itself (this module provisions workers only). Root-level
environment stacks (e.g. `envs/prod`) come with those.
