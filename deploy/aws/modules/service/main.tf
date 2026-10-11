# ECS on Fargate (ARM64, Graviton) running the Cairn container (docs/07).

variable "vpc_id" {}
variable "subnet_ids" { type = list(string) }
variable "redis_url" {}
variable "image" {}
variable "desired_count" {}
variable "drain_window_ms" {}
variable "stop_timeout" {}
variable "tasks_security_group_id" {}

locals {
  relay_config = jsonencode({
    access = { mode = "open" }
    region = "aws"
    router = { kind = "redis", redis = { url = var.redis_url } }
    drainWindowMs = var.drain_window_ms
    ports = { relay = 8080, admin = 9090 }
  })
}

resource "aws_ecs_cluster" "cairn" {
  name = "cairn"
}

resource "aws_iam_role" "task_execution" {
  name = "cairn-task-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  managed_policy_arns = ["arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"]
}

resource "aws_ecs_task_definition" "cairn" {
  family             = "cairn"
  cpu                = "1024"
  memory             = "2048"
  network_mode       = "awsvpc"
  execution_role_arn = aws_iam_role.task_execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name      = "cairn"
    image     = var.image
    essential = true
    portMappings = [
      { containerPort = 8080, hostPort = 8080 },
      { containerPort = 9090, hostPort = 9090 },
    ]
    environment = [
      { name = "RELAY_CONFIG", value = local.relay_config },
      { name = "PORT", value = "8080" },
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:8080/healthz?ready=1 || exit 1"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
    stopTimeout = var.stop_timeout
  }])
}

resource "aws_lb_target_group" "cairn" {
  name                 = "cairn"
  port                 = 8080
  protocol             = "TCP"
  vpc_id               = var.vpc_id
  deregistration_delay = 60
  health_check {
    protocol = "HTTP"
    path     = "/healthz?ready=1"
    port     = "8080"
  }
}

resource "aws_ecs_service" "cairn" {
  name            = "cairn"
  cluster         = aws_ecs_cluster.cairn.id
  task_definition = aws_ecs_task_definition.cairn.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  enable_execute_command             = false
  network_configuration {
    subnets          = var.subnet_ids
    assign_public_ip = true
    security_groups  = [var.tasks_security_group_id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.cairn.arn
    container_name   = "cairn"
    container_port   = 8080
  }
}

output "target_group_arn" { value = aws_lb_target_group.cairn.arn }
