# AWS infra

Terraform module for the agent worker pool: `modules/worker_pool` provisions an ECS Fargate
cluster/service that runs the agent worker container, scaled by `desired_count`.

## Usage

```hcl
module "worker_pool" {
  source              = "./modules/worker_pool"
  image               = "<account>.dkr.ecr.<region>.amazonaws.com/agentscale-worker:latest"
  desired_count       = 3
  subnet_ids          = ["subnet-xxxx"]
  security_group_ids  = ["sg-xxxx"]
}
```

`image` is built from the `Dockerfile` at the repo root, run with the worker command:

```dockerfile
CMD ["node", "src/worker.js"]
```

The worker needs `AGENTSCALE_URL` and `WORKER_TOKEN` in its task definition environment.

Still missing before this is deployable: a provider/region/backend block, a root module, a
service and load balancer for the API itself (this module provisions workers only), and a task
role — the task definition sets `execution_role_arn` only, so the worker container has no AWS
permissions of its own. Root-level environment stacks (e.g. `envs/prod`) come with those.
