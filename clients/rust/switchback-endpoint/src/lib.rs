//! `switchback-endpoint` — the app-facing Switchback client (doc 09), speaking
//! `switchback.v1` only (PROTOCOL_VERSIONS). Built from scratch (ADR-010) on quinn as the
//! QUIC engine (ADR-013); the Cairn relay path is the only transport in this first
//! release line.

mod config;
mod endpoint;
mod identity;
mod probe;
pub mod relay_client;
mod socket;

pub use config::{CairnUrl, InvalidCairnUrl, RelayPathPolicy, SecretKey, SwitchbackConfig};
pub use endpoint::{
    addr, builder, builder_relay_only, protocol_versions, Connection, Endpoint, EndpointBuilder, EndpointError,
    LookupResult, DEFAULT_ALPN,
};
pub use identity::{verify_peer, PeerIdentity};
pub use probe::{captive_portal_check, ProbeError};
pub use relay_client::{RelayClientHandle, RelayEvent, Recorder, ServerInfo};

pub use switchback_proto as proto;

/// EndpointId: canonical z-base-32 text form of the 32-byte Ed25519 key (doc 01).
pub type EndpointId = String;

/// Wire protocol versions this client speaks (doc 01 §1).
pub const PROTOCOL_VERSIONS: &[&str] = &["switchback.v1"];

/// `addr(cfg, peer)` (doc 09): everything needed to dial a peer by id alone.
#[derive(Debug, Clone)]
pub struct EndpointAddr {
    pub peer: EndpointId,
    pub cairn: CairnUrl,
}
