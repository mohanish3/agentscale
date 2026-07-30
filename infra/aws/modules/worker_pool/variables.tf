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
