# Shared networking for the Cairn Pool (docs/07): one VPC, public subnets for the
# containers/NLB, private subnets for ElastiCache.

variable "region" {}
variable "azs" { type = list(string) }

resource "aws_vpc" "cairn" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = "cairn" }
}

resource "aws_subnet" "public" {
  count                   = length(var.azs)
  vpc_id                  = aws_vpc.cairn.id
  cidr_block              = "10.42.${count.index}.0/24"
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "cairn-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.cairn.id
  cidr_block        = "10.42.${count.index + 100}.0/24"
  availability_zone = var.azs[count.index]
  tags              = { Name = "cairn-private-${count.index}" }
}

resource "aws_internet_gateway" "cairn" {
  vpc_id = aws_vpc.cairn.id
  tags   = { Name = "cairn" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.cairn.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.cairn.id
  }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

output "vpc_id" { value = aws_vpc.cairn.id }
output "public_subnet_ids" { value = aws_subnet.public[*].id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
