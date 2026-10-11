# Network Load Balancer (docs/07): TLS listener :443 (ACM) → 8080, TCP listener :80 →
# 8080 for /v1/captive; Route 53 alias when a hosted zone for `domain` exists.

variable "vpc_id" {}
variable "subnet_ids" { type = list(string) }
variable "domain" {}
variable "target_port" {}
variable "tg_arn" {}

resource "aws_lb" "cairn" {
  name               = "cairn"
  load_balancer_type = "network"
  subnets            = var.subnet_ids
}

resource "aws_lb_listener" "tls" {
  load_balancer_arn = aws_lb.cairn.arn
  port              = 443
  protocol          = "TLS"
  certificate_arn   = data.aws_acm_certificate.cairn.arn
  alpn_policy       = "None"
  default_action {
    type             = "forward"
    target_group_arn = var.tg_arn
  }
}

resource "aws_lb_listener" "tcp80" {
  load_balancer_arn = aws_lb.cairn.arn
  port              = 80
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = var.tg_arn
  }
}

data "aws_acm_certificate" "cairn" {
  domain      = var.domain
  statuses    = ["ISSUED"]
  most_recent = true
}

data "aws_route53_zone" "cairn" {
  name = var.domain
}

resource "aws_route53_record" "cairn" {
  zone_id = data.aws_route53_zone.cairn.zone_id
  name    = var.domain
  type    = "A"
  alias {
    name                   = aws_lb.cairn.dns_name
    zone_id                = aws_lb.cairn.zone_id
    evaluate_target_health = true
  }
}

output "dns_name" { value = aws_lb.cairn.dns_name }
