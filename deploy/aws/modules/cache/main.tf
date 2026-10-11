# ElastiCache for Valkey (docs/07): single-node with a Multi-AZ replica.

variable "vpc_id" {}
variable "subnet_ids" { type = list(string) }
variable "node_type" {}

resource "aws_security_group" "redis" {
  name   = "cairn-redis"
  vpc_id = var.vpc_id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.allow_redis.id]
  }
}

# SG attached to the ECS tasks so the cache can restrict ingress to the pool.
resource "aws_security_group" "allow_redis" {
  name   = "cairn-tasks"
  vpc_id = var.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_elasticache_subnet_group" "cairn" {
  name       = "cairn"
  subnet_ids = var.subnet_ids
}

resource "aws_elasticache_replication_group" "cairn" {
  replication_group_id       = "cairn"
  description                = "Cairn Pool router (Valkey)"
  engine                     = "valkey"
  engine_version             = "7.2"
  node_type                  = var.node_type
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  subnet_group_name          = aws_elasticache_subnet_group.cairn.name
  security_group_ids         = [aws_security_group.redis.id]
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
}

output "primary_endpoint" { value = aws_elasticache_replication_group.cairn.primary_endpoint_address }
output "port" { value = aws_elasticache_replication_group.cairn.port }
output "tasks_security_group_id" { value = aws_security_group.allow_redis.id }
output "connection_secret_hint" {
  value = "REDIS auth token: set router.redis.url to rediss://:<password>@<endpoint>:6379 via ECS secrets"
}
