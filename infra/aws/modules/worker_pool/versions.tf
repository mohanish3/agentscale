terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Pinned to v6 because main.tf reads `data.aws_region.current.region`, which arrived with
      # v6's enhanced region support. On v5 that attribute does not exist and the plan fails.
      version = "~> 6.0"
    }
  }
}
