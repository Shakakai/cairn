# Azure Cairn Pool (docs/07): Container Apps (workload profile, VNet-integrated) with
# external HTTP ingress on 8080, allowInsecure for /v1/captive on plain HTTP, plus Azure
# Managed Redis (or Azure Cache for Redis) as the router.
#
#   terraform init && terraform apply -var image=<acr>.azurecr.io/cairn:tag

terraform {
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}

variable "location" { default = "eastus" }
variable "image" {}
variable "min_replicas" { default = 2 }

provider "azurerm" {
  features {}
}

resource "azurerm_resource_group" "cairn" {
  name     = "cairn-pool"
  location = var.location
}

resource "azurerm_log_analytics_workspace" "cairn" {
  name                = "cairn"
  location            = var.location
  resource_group_name = azurerm_resource_group.cairn.name
  sku                 = "PerGB2018"
}

resource "azurerm_container_app_environment" "cairn" {
  name                               = "cairn"
  location                           = var.location
  resource_group_name                = azurerm_resource_group.cairn.name
  log_analytics_workspace_id         = azurerm_log_analytics_workspace.cairn.id
  infrastructure_subnet_id           = azurerm_subnet.cairn.id
  internal_load_balancer_enabled     = false
  workload_profile {
    name                  = "cairn-wp"
    workload_profile_type = "D4"
    minimum_count         = 1
    maximum_count         = 3
  }
}

resource "azurerm_virtual_network" "cairn" {
  name                = "cairn"
  location            = var.location
  resource_group_name = azurerm_resource_group.cairn.name
  address_space       = ["10.43.0.0/16"]
}

resource "azurerm_subnet" "cairn" {
  name                 = "cairn-infra"
  resource_group_name  = azurerm_resource_group.cairn.name
  virtual_network_name = azurerm_virtual_network.cairn.name
  address_prefixes     = ["10.43.0.0/21"]
}

# Azure Managed Redis (memorystore). For Azure Cache for Redis (classic) swap in
# azurerm_redis_cache — either speaks the Redis protocol with Lua (docs/06).
resource "azurerm_redis_enterprise_cluster" "cairn" {
  name                = "cairn"
  resource_group_name = azurerm_resource_group.cairn.name
  location            = var.location
  sku_name            = "Enterprise_E5-4"
}

resource "azurerm_redis_enterprise_database" "cairn" {
  name               = "default"
  cluster_id         = azurerm_redis_enterprise_cluster.cairn.id
  client_protocol    = "Encrypted"
  clustering_policy  = "EnterpriseCluster"
  eviction_policy    = "NoEviction"
  port               = 10000
}

locals {
  relay_config = jsonencode({
    access = { mode = "open" }
    region = "azure"
    router = { kind = "redis", redis = { url = "rediss://${azurerm_redis_enterprise_cluster.cairn.hostname}:10000" } }
    ports = { relay = 8080, admin = 9090 }
  })
}

resource "azurerm_container_app" "cairn" {
  name                         = "cairn"
  container_app_environment_id = azurerm_container_app_environment.cairn.id
  resource_group_name          = azurerm_resource_group.cairn.name
  revision_mode                = "Single"
  workload_profile_name        = "cairn-wp"

  template {
    min_replicas = var.min_replicas
    max_replicas = 10
    container {
      name   = "cairn"
      image  = var.image
      cpu    = 1.0
      memory = "2Gi"
      env {
        name  = "RELAY_CONFIG"
        value = local.relay_config
      }
      readiness_probe {
        transport = "HTTP"
        path      = "/healthz?ready=1"
        port      = 8080
      }
      liveness_probe {
        transport = "HTTP"
        path      = "/healthz"
        port      = 8080
      }
    }
  }

  ingress {
    external_enabled           = true
    target_port                = 8080
    transport                  = "http"
    allow_insecure_connections = true # port 80 serves /v1/captive without a redirect
    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }
}

# M6 open question (docs/decisions.md): verify Container Apps ingress idle timeout and
# any max request duration for WebSockets; set caps.maxConnectionMs if one exists.
output "cairn_url" { value = "wss://${azurerm_container_app.cairn.ingress[0].fqdn}" }
output "redis_hostname" { value = azurerm_redis_enterprise_cluster.cairn.hostname }
