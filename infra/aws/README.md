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

Root-level environment stacks (e.g. `envs/prod`) are added as the deployment story grows.
