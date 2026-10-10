# Switchback + Cairn — build specification

**Switchback** is a peer-to-peer protocol and client stack: endpoints identified by Ed25519 keys
meet through a relay, holepunch a direct UDP path, and fall back to the relay only when they must.
**Cairn** is the relay and discovery infrastructure they meet at, deployable on Cloudflare (Cairn
Edge) and as containers on AWS, GCP or Azure (Cairn Pool).

Switchback v1 is the first version of this system. It doesn't interoperate with any earlier or
foreign network.

Start with `AGENTS.md`, then `docs/00-overview.md`, `docs/01-protocol.md` and
`docs/11-milestones.md`.

## Handing this to a coding agent

Put this folder at the root of an empty repository and start with:

> Read AGENTS.md and every file in docs/. Then execute milestone M0 from docs/11-milestones.md.
> Stop at the end of each milestone, report the acceptance checklist with evidence, and list any
> decisions you recorded in docs/decisions.md before continuing to the next milestone.
