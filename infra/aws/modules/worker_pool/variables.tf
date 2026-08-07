variable "name" {
  description = "Name prefix for the worker pool resources."
  type        = string
  default     = "agentscale-workers"
}

variable "image" {
  description = "Container image for the agent worker."
  type        = string
}

variable "desired_count" {
  description = "Number of worker tasks to run."
  type        = number
  default     = 1
}

variable "cpu" {
  description = "Fargate task CPU units."
  type        = number
  default     = 512
}

variable "memory" {
  description = "Fargate task memory (MiB)."
  type        = number
  default     = 1024
}

variable "subnet_ids" {
  description = "Subnets to run worker tasks in."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security groups attached to worker tasks."
  type        = list(string)
}

variable "agentscale_url" {
  description = "Base URL of the agentscale API the worker polls."
  type        = string
}

variable "worker_token_secret_arn" {
  description = "ARN of a Secrets Manager secret holding the bearer token the worker authenticates to the API with. The execution role is granted read access to exactly this ARN."
  type        = string
}

variable "task_role_arn" {
  description = "IAM role granting the worker container its own AWS permissions (e.g. for an agent runtime that calls other AWS services). Left unset, the container gets none."
  type        = string
  default     = null
}

variable "min_capacity" {
  description = "Minimum worker task count the autoscaler holds the pool to."
  type        = number
  default     = 1
}

variable "max_capacity" {
  description = "Maximum worker task count the autoscaler holds the pool to."
  type        = number
  default     = 10
}

variable "cpu_target_value" {
  description = "Target average CPU utilization (%) the autoscaler scales the pool to hold."
  type        = number
  default     = 70
}
