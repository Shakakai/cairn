# GCP Cairn Pool (docs/07): Cloud Run (session affinity, request timeout 3600s,
# CPU always allocated) + global external HTTPS LB with an HTTP :80 backend that does
# NOT redirect (for /v1/captive) + Memorystore for Valkey via Direct VPC egress.
#
#   terraform init && terraform apply -var project=<gcp project> -var domain=cairn-staging.example.net

terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}

variable "project" {}
variable "region" { default = "us-central1" }
variable "domain" {}
variable "image" { description = "Artifact Registry image URI" }

provider "google" {
  project = var.project
  region  = var.region
}

resource "google_memorystore_instance" "cairn" {
  instance_id             = "cairn"
  shard_count             = 1
  node_type               = "SHARED_CORE_NANO"
  location                = "${var.region}-a"
  transit_encryption_mode = "TRANSIT_ENCRYPTION_MODE_SERVER_AUTHENTICATION"
  authorization_mode      = "AUTH_MODE_DISABLED"
  persistence_config {
    mode = "DISABLED"
  }
  # Reachable from Cloud Run via Direct VPC egress: peer `default` or use
  # network_config once the provider exposes it for this resource version.
}

locals {
  relay_config = jsonencode({
    access = { mode = "open" }
    region = "gcp"
    router = { kind = "redis", redis = { url = "redis://${google_memorystore_instance.cairn.endpoints[0].connections[0].psc_auto_connection[0].ip_address}:${google_memorystore_instance.cairn.endpoints[0].connections[0].psc_auto_connection[0].port}" } }
    caps   = { maxConnectionMs = 3600000 }
    drainWindowMs = 8000
    ports = { relay = 8080, admin = 9090 }
  })
}

resource "google_cloud_run_v2_service" "cairn" {
  name                = "cairn"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.cairn.email
    max_instance_request_concurrency = 1000
    session_affinity                 = true
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    scaling {
      min_instance_count = 1
    }
    containers {
      image = var.image
      ports { container_port = 8080 }
      env {
        name  = "RELAY_CONFIG"
        value = local.relay_config
      }
      resources {
        cpu_idle = false # CPU always allocated: WebSockets must not be throttled
      }
      startup_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
      }
      liveness_probe {
        http_get {
          path = "/healthz?ready=1"
          port = 8080
        }
      }
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY" # Direct VPC egress to Memorystore
    }
  }
  # Requests end after 3600s: the core recycles connections before the cut
  # (caps.maxConnectionMs = 3600000, docs/07).
  timeouts {
    create = "10m"
  }
}

resource "google_service_account" "cairn" {
  account_id = "cairn-sa"
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.cairn.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_compute_region_network_endpoint_group" "cairn" {
  name                  = "cairn"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.cairn.name
  }
}

resource "google_compute_backend_service" "cairn" {
  name                  = "cairn"
  protocol              = "HTTPS"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  backend {
    group = google_compute_region_network_endpoint_group.cairn.id
  }
}

resource "google_compute_url_map" "cairn" {
  name            = "cairn"
  default_service = google_compute_backend_service.cairn.id
  # No host/path redirect: HTTP :80 forwards straight to the backend so
  # /v1/captive works without an HTTPS redirect (docs/07).
}

resource "google_compute_target_https_proxy" "cairn" {
  name    = "cairn"
  url_map = google_compute_url_map.cairn.id
  ssl_certificates = [google_compute_managed_ssl_certificate.cairn.id]
}

resource "google_compute_managed_ssl_certificate" "cairn" {
  name = "cairn"
  managed {
    domains = [var.domain]
  }
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "cairn-https"
  target                = google_compute_target_https_proxy.cairn.id
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.cairn.address
}

resource "google_compute_target_http_proxy" "cairn" {
  name    = "cairn-http"
  url_map = google_compute_url_map.cairn.id
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "cairn-http"
  target                = google_compute_target_http_proxy.cairn.id
  port_range            = "80"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.cairn.address
}

resource "google_compute_global_address" "cairn" {
  name = "cairn"
}

output "cairn_url" { value = "wss://${var.domain}" }
output "cloud_run_uri" { value = google_cloud_run_v2_service.cairn.uri }
