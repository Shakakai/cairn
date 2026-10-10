# 12 — Future work (do not start unprompted)

Ideas deliberately left out of v1, with enough context to pick them up later.

| Idea | Why later | Notes |
| --- | --- | --- |
| **Browser/WASM endpoints** | Browsers can't set WebSocket headers or send pings | Auth already supports `?auth=`. Keepalive would need an application-level ping frame that the Worker answers locally (never forwarded to a DO). |
| **Multi-region container deployments** | Single region is simpler; Cloudflare already covers global latency | Global entry (Global Accelerator / Front Door / global LB); presence via a *home region per EndpointId* (hash of id → region that owns its Redis keys) so lookups stay strongly consistent; `ConnRef.host` carries the region. |
| **Regional mailboxes on Cloudflare** | Durable Objects never move; roaming users keep a far-away mailbox | Name mailboxes `<id>@<region>` and keep a small pointer object `<id>` that records the current region; senders cache the pointer. |
| **Federation between deployments** | v1 requires all endpoints on one deployment | Deployments forward frames for endpoints they don't know to peer deployments using a shared presence index. |
| **Cloudflare TURN fallback data path** | Only pays off for media/bulk apps | Cloudflare Realtime TURN: anycast, $0.05/GB delivered, first 1 000 GB free, IPv4 relay addresses only, ~50–100 Mbps per allocation. Integrate as a custom QUIC transport in the client. |
| **Discovery records** | Not needed when every endpoint uses one relay URL | Signed records (user data, last-seen, capabilities) stored in the mailbox / Redis; lookup op over the relay socket. |
| **Host-to-host mesh in pools** | Redis pub/sub is simpler | Direct WebSocket mesh between instances with private IPs (ECS, Container Apps, k8s; not Cloud Run) behind the same `Router` interface. |
| **Multi-destination batch frames** | Optimization | One client frame carrying datagrams for several destinations, to cut per-message cost further. |
