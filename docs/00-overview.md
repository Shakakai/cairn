# 00 — Overview

## Names

| Name | What it is |
| --- | --- |
| **Switchback** | The peer-to-peer protocol and client stack. A switchback is the hairpin turn on a mountain trail: traffic starts on the relay detour, then switches back to a direct path. |
| **Switchback v1** (`switchback.v1`) | The first and only protocol version (doc 01). |
| **`switchback-endpoint`** | The client crate apps embed; 1.0.0 is the first release. |
| **Cairn** | The relay and discovery infrastructure. A cairn is a stack of stones hikers leave to mark a route and a meeting point; each online endpoint has a mailbox in Cairn marking where it can be reached. |
| **Cairn Edge** | Cairn on Cloudflare (Workers + Durable Objects). |
| **Cairn Pool** | Cairn as Node containers with Redis/Valkey on AWS, GCP, Azure or VMs. |
| **`@cairn/*`** | The TypeScript server packages. |

Run a trademark/domain check before public launch (ADR-009).

## What we are building

Endpoints are identified by an Ed25519 public key (**EndpointId**). Every endpoint keeps one
WebSocket to Cairn. To reach a peer, an endpoint sends encrypted QUIC datagrams to Cairn addressed
by the peer's EndpointId; Cairn forwards them to the peer's WebSocket. The peers complete a QUIC
handshake over Cairn, exchange address candidates, and holepunch a direct UDP path. Once direct,
Cairn hears nothing more from that connection. Pairs that can't go direct (~10%) keep using Cairn.

## Goals

1. **Fast first dial.** No discovery lookup: every endpoint uses the same anycast Cairn URL, and
   Cairn knows who is online. Auth happens in the WebSocket upgrade (no extra round trip).
2. **Cheap on per-message-billed platforms.** No keepalive traffic crosses a Durable Object; relay
   paths go quiet once a direct path works.
3. **No servers to run on Cloudflare.** Address discovery uses Cloudflare's free anycast STUN.
4. **Portable.** One pure TypeScript core; Cairn Edge first, then Cairn Pool on AWS, GCP and Azure.

## Non-goals

- **Any compatibility** with earlier or foreign clients, relays or protocols, including any
  other production peer-to-peer network. Switchback v1 is the first version; the server accepts
  nothing else (ADR-008).
- Managed WebSocket gateways (API Gateway WebSockets, Web PubSub).
- Storing application data. Cairn keeps only live connection state.
- A separate discovery service in v1. Presence is Cairn's registry (ADR-005).

## Where the design comes from

Switchback takes proven ideas from existing peer-to-peer relay architectures (QUIC multipath,
holepunching, relays addressed by key) and changes what doesn't fit our deployments. The client
reimplements these from scratch under our own crates; no foreign stack's code is in this
repository (ADR-010).

| Idea from prior P2P relay designs | Switchback v1 | Why |
| --- | --- | --- |
| Challenge-response handshake after the upgrade | Signed auth blob in the upgrade request | No extra round trip; works behind Cloudflare and load balancers; reject before accepting |
| Relay-protocol ping frames | WebSocket control pings | Answered by the platform; never billed on Cloudflare |
| QUIC address discovery on the relay's UDP port | STUN to `stun.cloudflare.com` | Workers can't receive UDP; no servers of ours |
| Many regional relays, latency probes, DNS/pkarr publishing | One anycast Cairn URL, no probes, no publishing | The platform already routes to the nearest PoP/region |
| Relay path kept alive every 5 s for the connection's life | Relay path goes quiet once direct | Those keepalives were 91–96% of relay messages in our cost model |
| Restart notices ignored by clients | Make-before-break on `Restarting` and on max connection age | Deploys and platform time limits don't stall traffic |
| Varint frame types with legacy gaps | Eight `u8` frame types, `0x01`–`0x08` | Clean first version |

## Architecture

```
 Switchback endpoints (switchback-endpoint 1.0, doc 09)
     │ WebSocket wss://cairn.<domain>/v1/connect  (subprotocol switchback.v1, signed auth)
     │ STUN udp://stun.cloudflare.com:3478
     ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ @cairn/core (pure TypeScript)                                 │
 │  codec · connect auth · connection state machine ·            │
 │  registry rules (newest-wins, PeerGone) · limits              │
 └──────────────┬──────────────────────────────┬────────────────┘
                │ SocketHost port               │ Router port
   Cairn Edge: Worker                     Cairn Edge: Mailbox Durable Object
   Cairn Pool: Node ws server             Cairn Pool: Redis/Valkey · single node: memory
```

| Deployment | SocketHost | Router |
| --- | --- | --- |
| Cairn Edge (Cloudflare) | Worker at the nearest PoP | Durable Object per EndpointId ("mailbox") |
| Cairn Pool (ECS, Cloud Run, Container Apps, k8s, VMs) | Node server | Redis/Valkey |
| Single node (dev, small installs) | Node server | memory |

## Glossary

| Term | Meaning |
| --- | --- |
| EndpointId | 32-byte Ed25519 public key; text form z-base-32 (52 chars). |
| Frame | One binary WebSocket message: `type u8 · payload`. |
| ConnRef | Opaque handle to one client WebSocket in one SocketHost. |
| Active connection | The connection that receives traffic for an EndpointId (newest wins). |
| Displaced connection | An older connection of the same EndpointId: open, receives nothing, promoted if the active one closes. |
| Mailbox | Cairn Edge Durable Object named after an EndpointId; routes frames to its connections. |
| Link | A Worker→Durable Object WebSocket used to push frames to a destination mailbox. |
| Sent-to set | EndpointIds an endpoint has sent to; used for PeerGone. |
| Relay path / direct path | The QUIC path between two peers through Cairn / over UDP. |

## Decisions

`docs/decisions.md`: ADR-001 TypeScript pure core · ADR-002 Cairn Edge edge-terminated sockets ·
ADR-003 Cairn Pool on hyperscalers, no managed gateways · ADR-004 STUN instead of QAD · ADR-005 no
ADR-005 no
discovery service in v1 · ADR-006 Redis pub/sub routing · ADR-007 *superseded by ADR-010* ·
ADR-008 Switchback v1 is the first version, no compatibility · ADR-009 names · ADR-010 no foreign
stack in-repo, client from scratch · ADR-011 multi-language SDK layout + mise toolchains.
