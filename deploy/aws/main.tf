# AWS Cairn Pool (docs/07): ECS on Fargate (ARM64) behind an NLB, ElastiCache for
# Valkey as the router. Staging only; `terraform apply` needs AWS credentials and the
# container image pushed to ECR.
#
#   terraform init && terraform apply \
#     -var domain=cairn-staging.example.net -var image=<account>.dkr.ecr.<region>.amazonaws.com/cairn:tag

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

variable "region" { default = "us-east-1" }
variable "domain" { description = "Hostname for the relay (Route 53 zone must exist)" }
variable "image" { description = "Cairn container image URI" }
variable "redis_node_type" { default = "cache.t4g.micro" }
variable "desired_count" { default = 2 }
variable "drain_window_ms" { default = 45000 }
variable "stop_timeout" { default = 60 }

provider "aws" { region = var.region }

data "aws_availability_zones" "available" { state = "available" }

module "network" {
  source = "./modules/network"
  region = var.region
  azs    = slice(data.aws_availability_zones.available.names, 0, 2)
}

module "cache" {
  source       = "./modules/cache"
  vpc_id       = module.network.vpc_id
  subnet_ids   = module.network.private_subnet_ids
  node_type    = var.redis_node_type
}

module "service" {
  source          = "./modules/service"
  vpc_id          = module.network.vpc_id
  subnet_ids      = module.network.public_subnet_ids
  redis_url       = "rediss://${module.cache.primary_endpoint}:${module.cache.port}"
  image           = var.image
  desired_count   = var.desired_count
  drain_window_ms         = var.drain_window_ms
  stop_timeout            = var.stop_timeout
  tasks_security_group_id = module.cache.tasks_security_group_id
}

module "lb" {
  source       = "./modules/lb"
  vpc_id       = module.network.vpc_id
  subnet_ids   = module.network.public_subnet_ids
  domain       = var.domain
  target_port  = 8080
  tg_arn       = module.service.target_group_arn
}

output "cairn_url" { value = "wss://${var.domain}" }
output "redis_url" { value = module.cache.connection_secret_hint }
