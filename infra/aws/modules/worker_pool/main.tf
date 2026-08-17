resource "aws_ecs_cluster" "this" {
  name = var.name
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-task"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                       = var.cpu
  memory                    = var.memory
  execution_role_arn        = aws_iam_role.execution.arn
  task_role_arn             = var.task_role_arn

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = var.image
      essential = true
      # The image's default CMD starts the API (src/index.js) — this is what makes the
      # container run the worker (src/worker.js) instead, same as docker-compose's worker
      # service does with its own `command:` override.
      command = ["node", "src/worker.js"]
      environment = [
        { name = "AGENTSCALE_URL", value = var.agentscale_url },
      ]
      # Pulled by the ECS agent via the execution role at task start, not baked into the task
      # definition or visible in `environment` — unlike AGENTSCALE_URL, this one's a secret.
      secrets = [
        { name = "WORKER_TOKEN", valueFrom = var.worker_token_secret_arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = data.aws_region.current.region
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "worker" {
  name            = "${var.name}-service"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = true
  }

  # Once aws_appautoscaling_target below takes over, desired_count is the autoscaler's to move —
  # without this, every `terraform apply` snaps it back to var.desired_count and fights the policy.
  lifecycle {
    ignore_changes = [desired_count]
  }
}

resource "aws_appautoscaling_target" "worker" {
  min_capacity       = var.min_capacity
  max_capacity       = var.max_capacity
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

# Target-tracking on CPU rather than queue depth: queue depth lives in the API process, not in
# a CloudWatch metric, so it isn't something ECS Application Auto Scaling can read natively.
# This is what makes the pool actually move; POST /orchestrator/scale still only computes a
# number today (see the status section in the repo README).
resource "aws_appautoscaling_policy" "worker_cpu" {
  name               = "${var.name}-cpu-target-tracking"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value = var.cpu_target_value
  }
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/agentscale/${var.name}"
  retention_in_days = 14
}

resource "aws_iam_role" "execution" {
  name = "${var.name}-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Scoped to exactly the one secret the task definition references above — the execution role
# otherwise has no Secrets Manager access at all.
resource "aws_iam_role_policy" "worker_token_secret" {
  name = "${var.name}-worker-token-secret"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action   = "secretsmanager:GetSecretValue"
      Effect   = "Allow"
      Resource = var.worker_token_secret_arn
    }]
  })
}

data "aws_region" "current" {}
