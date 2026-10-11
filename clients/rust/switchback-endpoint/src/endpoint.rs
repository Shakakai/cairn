//! The app-facing endpoint (doc 09): a quinn endpoint whose transports are the Cairn
//! relay client plus, unless `builder_relay_only` was used, a real UDP socket behind a
//! hybrid socket (C4). Peers exchange UDP candidates in-band (ALPN
//! `switchback/candidates`, ADR-018) and switch to direct paths; with the default
//! `QuietWhenDirect` policy the relay path then goes fully quiet (ADR-016/018).

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use quinn::crypto::rustls::{QuicClientConfig, QuicServerConfig};
use tracing::debug;

use crate::config::{RelayPathPolicy, SecretKey, SwitchbackConfig};
use crate::relay_client::RelayClientConfig;
use crate::hybrid::{CANDIDATES_ALPN, HybridSocket, UdpState};
use crate::identity::{self, IdentityError};
use crate::relay_client;
use crate::relay_client::RelayClientHandle;
use crate::socket::{peer_addr, RelaySocket, SocketQueues};
use crate::stun_probe;
use crate::{CairnUrl, EndpointAddr, EndpointId, PROTOCOL_VERSIONS};

pub use quinn::Connection;

/// Default ALPN for Switchback application connections.
pub const DEFAULT_ALPN: &[u8] = b"switchback/1";
/// QUIC keepalive on the direct path: keeps NAT mappings open once the relay path is
/// quiet (C4/ADR-018).
const DIRECT_KEEPALIVE: Duration = Duration::from_secs(15);
const CANDIDATE_EXCHANGE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, thiserror::Error)]
pub enum EndpointError {
    #[error("invalid cairn url: {0}")]
    InvalidUrl(#[from] crate::config::InvalidCairnUrl),
    #[error("certificate generation failed: {0}")]
    Certificate(#[from] rcgen::Error),
    #[error("endpoint construction failed: {0}")]
    Quinn(#[from] std::io::Error),
    #[error("relay connection failed: {0}")]
    Relay(String),
    #[error("peer identity verification failed: {0}")]
    Identity(#[from] IdentityError),
    #[error("connected to {connected}, expected {expected}")]
    PeerMismatch { connected: EndpointId, expected: EndpointId },
    #[error("connection failed: {0}")]
    Connect(#[from] quinn::ConnectError),
    #[error("connection failed: {0}")]
    Connection(#[from] quinn::ConnectionError),
    #[error("candidate exchange failed: {0}")]
    Candidates(String),
}

/// Builder preconfigured for Switchback (doc 09): Cairn as the only relay, STUN, the
/// quiet-relay-path policy, no other lookup services (C7). The default builder binds a
/// UDP socket and enables direct paths (C4/C5); `builder_relay_only` disables them.
pub struct EndpointBuilder {
    config: SwitchbackConfig,
    secret: SecretKey,
    alpns: Vec<Vec<u8>>,
    relay_only: bool,
}

impl EndpointBuilder {
    fn new(config: SwitchbackConfig) -> Self {
        Self {
            config,
            secret: SecretKey::generate(),
            alpns: vec![DEFAULT_ALPN.to_vec()],
            relay_only: false,
        }
    }

    /// Use a specific identity (otherwise one is generated).
    pub fn secret_key(mut self, secret: SecretKey) -> Self {
        self.secret = secret;
        self
    }

    /// Application protocols this endpoint serves (default `switchback/1`).
    pub fn alpn_protocols(mut self, alpns: Vec<Vec<u8>>) -> Self {
        self.alpns = alpns;
        self
    }

    pub async fn build(self) -> Result<Endpoint, EndpointError> {
        Endpoint::build(self.config, self.secret, self.alpns, self.relay_only).await
    }
}

/// One accepted connection waiting for the application's `accept()`.
struct PendingAccept {
    peer: EndpointId,
    conn: Connection,
}

/// Everything the accept pump needs. The pump holds a `Weak` reference so dropping the
/// last `Endpoint` handle stops the pump, which drops the last relay-handle clone —
/// without this, `drop(endpoint)` would never close the relay socket (and registry
/// promotions would never fire).
struct EndpointShared {
    shutdown: Arc<tokio::sync::Notify>,
    inner: quinn::Endpoint,
    secret: SecretKey,
    local_id: EndpointId,
    relay: RelayClientHandle,
    queues: Arc<SocketQueues>,
    hybrid: Option<Arc<HybridSocket>>,
    /// Reflexive address discovered via STUN (C5).
    reflexive: Arc<Mutex<Option<SocketAddr>>>,
    direct_count: Arc<AtomicUsize>,
    relay_path_policy: RelayPathPolicy,
    accept_queue: Arc<Mutex<Vec<PendingAccept>>>,
    accept_notify: Arc<tokio::sync::Notify>,
}

/// Notifies the accept pump when the last endpoint handle drops.
struct EndpointGuard {
    shutdown: Arc<tokio::sync::Notify>,
}

impl Drop for EndpointGuard {
    fn drop(&mut self) {
        self.shutdown.notify_waiters();
    }
}

/// A Switchback endpoint. Cheap to clone.
#[derive(Clone)]
pub struct Endpoint {
    shared: Arc<EndpointShared>,
    _guard: Arc<EndpointGuard>,
}

impl Endpoint {
    #[allow(clippy::too_many_arguments)]
    async fn build(
        config: SwitchbackConfig,
        secret: SecretKey,
        alpns: Vec<Vec<u8>>,
        relay_only: bool,
    ) -> Result<Self, EndpointError> {
        let cert = identity::generate_certificate(secret.bytes())?;
        let tls_key = rustls_pki_types::PrivateKeyDer::Pkcs8(cert.key_der.into());
        let tls_cert = rustls_pki_types::CertificateDer::from(cert.cert_der);

        let mut transport = quinn::TransportConfig::default();
        transport.keep_alive_interval(Some(DIRECT_KEEPALIVE));
        let transport = Arc::new(transport);

        // Server side: accept any certificate — peer identity is proven by the Ed25519
        // signature in the certificate extension and verified by us (ADR-013).
        let mut server_tls = quinn::rustls::ServerConfig::builder()
            .with_client_cert_verifier(Arc::new(AcceptAnyClient))
            .with_single_cert(vec![tls_cert.clone()], tls_key.clone_key())
            .map_err(|e| EndpointError::Relay(format!("tls server config: {e}")))?;
        // The server also serves the internal candidates exchange (C4, ADR-018).
        let mut server_alpns = vec![CANDIDATES_ALPN.to_vec()];
        server_alpns.extend(alpns.iter().cloned());
        server_tls.alpn_protocols = server_alpns;
        let mut server = quinn::ServerConfig::with_crypto(Arc::new(
            QuicServerConfig::try_from(server_tls)
                .map_err(|e| EndpointError::Relay(format!("quic server config: {e}")))?,
        ));
        server.transport = transport;

        let mut client_tls = quinn::rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAll))
            .with_client_auth_cert(vec![tls_cert], tls_key)
            .map_err(|e| EndpointError::Relay(format!("tls client config: {e}")))?;
        client_tls.alpn_protocols = alpns;
        let client = quinn::ClientConfig::new(Arc::new(
            QuicClientConfig::try_from(client_tls)
                .map_err(|e| EndpointError::Relay(format!("quic client config: {e}")))?,
        ));

        let queues = SocketQueues::new();
        let relay = relay_client::spawn(
            RelayClientConfig {
                connect_url: config.cairn_url.connect_url(),
                auth_host: config.cairn_url.auth_host.clone(),
                secret_key: *secret.bytes(),
                access_token: config.access_token.clone(),
                quiet_when_direct: matches!(config.relay_path_policy, RelayPathPolicy::QuietWhenDirect),
            },
            queues.clone(),
        );

        let runtime = quinn::default_runtime()
            .ok_or_else(|| EndpointError::Relay("no async runtime".into()))?;

        // C4/C5: unless relay-only, bind a UDP socket and run the hybrid.
        let reflexive: Arc<Mutex<Option<SocketAddr>>> = Arc::new(Mutex::new(None));
        let hybrid: Option<Arc<HybridSocket>> = if relay_only {
            None
        } else {
            let udp = tokio::net::UdpSocket::bind(SocketAddr::V4(SocketAddrV4::new(
                Ipv4Addr::UNSPECIFIED,
                0,
            )))
            .await?;
            let udp = Arc::new(UdpState {
                socket: udp,
                real_to_virtual: Mutex::new(std::collections::HashMap::new()),
                queues: queues.clone(),
            });
            let servers: Vec<SocketAddr> = config.stun_servers.iter().filter_map(|s| parse_socket_addr(s)).collect();

            let socket = HybridSocket::new(queues.clone(), relay.outbound.clone(), udp.clone());
            let note = {
                let s = socket.clone();
                Arc::new(move |real: SocketAddr| s.note_rx(real)) as Arc<dyn Fn(SocketAddr) + Send + Sync>
            };

            // C5: STUN probes share the pending map with the reader task.
            let probes = stun_probe::PendingProbes::new();
            tokio::spawn(crate::hybrid::udp_reader(
                udp.clone(),
                note,
                probes.clone(),
                servers.clone(),
            ));
            {
                let reflexive = reflexive.clone();
                let udp = udp.clone();
                tokio::spawn(async move {
                    for server in servers {
                        if let Ok(mapped) =
                            stun_probe::bind(&udp.socket, server, &probes, Duration::from_secs(2)).await
                        {
                            debug!(%mapped.addr, "stun reflexive address discovered");
                            *reflexive.lock().expect("reflexive") = Some(mapped.addr);
                            break;
                        }
                    }
                });
            }
            Some(socket)
        };

        let socket: Arc<dyn quinn::AsyncUdpSocket> = match &hybrid {
            Some(h) => h.clone(),
            None => RelaySocket::new(queues.clone(), relay.outbound.clone()),
        };
        let mut inner = quinn::Endpoint::new_with_abstract_socket(
            quinn::EndpointConfig::default(),
            Some(server),
            socket,
            runtime,
        )?;
        inner.set_default_client_config(client);

        let local_id = relay.endpoint_id().to_string();
        let shutdown = Arc::new(tokio::sync::Notify::new());
        let endpoint = Self {
            _guard: Arc::new(EndpointGuard {
                shutdown: shutdown.clone(),
            }),
            shared: Arc::new(EndpointShared {
                shutdown,
                inner,
                secret,
                local_id,
                relay,
                queues,
                hybrid,
                reflexive,
                direct_count: Arc::new(AtomicUsize::new(0)),
                relay_path_policy: config.relay_path_policy,
                accept_queue: Arc::new(Mutex::new(Vec::new())),
                accept_notify: Arc::new(tokio::sync::Notify::new()),
            }),
        };

        // Internal accept pump: candidates connections (C4) are handled here; app
        // connections queue for `accept()`. Weak: dies with the last endpoint handle.
        {
            let weak = Arc::downgrade(&endpoint.shared);
            tokio::spawn(async move {
                loop {
                    let shared = match weak.upgrade() {
                        Some(s) => s,
                        None => break,
                    };
                    tokio::select! {
                        _ = shared.shutdown.notified() => break,
                        incoming = shared.inner.accept() => match incoming {
                            Some(i) => accept_once(&shared, i).await,
                            None => break,
                        },
                    }
                }
            });
        }

        Ok(endpoint)
    }

    /// This endpoint's public identity.
    pub fn local_id(&self) -> &EndpointId {
        &self.shared.local_id
    }

    /// Access to the underlying relay client (control events, recording).
    pub fn relay(&self) -> &RelayClientHandle {
        &self.shared.relay
    }

    /// The secret key (kept private; exposed for tests that reconnect as the same
    /// identity).
    pub fn secret_key(&self) -> &SecretKey {
        &self.shared.secret
    }

    /// Number of peer connections currently routed over a direct path (C4).
    pub fn direct_connection_count(&self) -> usize {
        self.shared.direct_count.load(Ordering::SeqCst)
    }

    /// Dial a peer by EndpointId. Verifies the peer's identity proof, exchanges UDP
    /// candidates (unless relay-only) and returns the connection.
    pub async fn connect(&self, peer: &EndpointId) -> Result<Connection, EndpointError> {
        self.connect_with_alpn(peer, DEFAULT_ALPN).await
    }

    /// Dial with a specific ALPN (must be one the peer serves).
    pub async fn connect_with_alpn(&self, peer: &EndpointId, alpn: &[u8]) -> Result<Connection, EndpointError> {
        let peer_bytes = switchback_proto::endpoint_id_to_bytes(peer)
            .map_err(|_| EndpointError::Relay(format!("malformed peer id {peer}")))?;
        let addr = peer_addr(&peer_bytes);
        self.shared.queues.register_peer(addr, peer_bytes);

        let client_config = client_config_for(&self.shared.secret, alpn);
        let connecting = self.shared.inner.connect_with(client_config, addr, "switchback")?;
        let conn = connecting.await?;
        let identity = peer_identity(&conn)?;
        if identity.endpoint_id != *peer {
            let connected = identity.endpoint_id;
            conn.close(0u32.into(), b"peer identity mismatch");
            return Err(EndpointError::PeerMismatch { connected, expected: peer.clone() });
        }
        self.maybe_establish_direct(&peer_bytes, addr).await;
        debug!(peer = %peer, "connection established");
        Ok(conn)
    }

    /// C4: run the in-band candidate exchange with the peer and switch routes. Called
    /// by the dialer; the accept side is driven by the pump.
    async fn maybe_establish_direct(&self, peer_bytes: &[u8; 32], _virtual: SocketAddr) {
        let Some(hybrid) = self.shared.hybrid.clone() else { return };
        let vaddr = peer_addr(peer_bytes);
        let client_config = client_config_for(&self.shared.secret, CANDIDATES_ALPN);
        let candidates_conn = match async {
            let connecting = self
                .shared
                .inner
                .connect_with(client_config, vaddr, "switchback")?;
            connecting.await.map_err(EndpointError::Connection)
        }
        .await
        {
            Ok(c) => c,
            Err(error) => {
                tracing::warn!(%error, "candidates connection failed");
                return;
            }
        };
        let candidates_conn2 = candidates_conn.clone();
        let shared = self.shared.clone();
        match tokio::time::timeout(
            CANDIDATE_EXCHANGE_TIMEOUT,
            candidates_exchange(&shared, candidates_conn, vaddr, true),
        )
        .await
        {
            Ok(Ok(())) => {
                note_direct(&shared, &hybrid);
                tokio::spawn(async move {
                    candidates_conn2.closed().await;
                });
            }
            Ok(Err(error)) => tracing::warn!(%error, "candidate exchange failed"),
            Err(_) => tracing::warn!("candidate exchange timed out"),
        }
    }

    /// Accept an incoming connection; returns the peer's proven EndpointId. Candidates
    /// connections are handled internally by the accept pump.
    pub async fn accept(&self) -> Option<(EndpointId, Connection)> {
        loop {
            let pending = self.shared.accept_queue.lock().expect("accept queue").pop();
            if let Some(PendingAccept { peer, conn }) = pending {
                return Some((peer, conn));
            }
            self.shared.accept_notify.notified().await;
        }
    }

}

/// Accept one incoming connection (pump iteration).
async fn accept_once(shared: &EndpointShared, incoming: quinn::Incoming) {
    match incoming.await {
        Ok(conn) => {
            let alpn = connection_alpn(&conn);
            if alpn.as_deref() == Some(CANDIDATES_ALPN) {
                handle_candidates_conn(shared, conn).await;
            } else {
                match peer_identity(&conn) {
                    Ok(identity) => {
                        shared
                            .accept_queue
                            .lock()
                            .expect("accept queue")
                            .push(PendingAccept {
                                peer: identity.endpoint_id,
                                conn,
                            });
                        shared.accept_notify.notify_one();
                    }
                    Err(error) => {
                        tracing::warn!(%error, "rejected connection with unverifiable identity");
                        conn.close(0u32.into(), b"bad identity proof");
                    }
                }
            }
        }
        Err(error) => {
            tracing::warn!(%error, "incoming connection failed");
        }
    }
}

/// Accept side of the candidate exchange (C4), driven by the pump.
async fn handle_candidates_conn(shared: &EndpointShared, conn: Connection) {
    let Some(hybrid) = &shared.hybrid else {
        conn.close(0u32.into(), b"relay-only endpoint");
        return;
    };
    let vaddr = conn.remote_address();
    let ok = tokio::time::timeout(
        CANDIDATE_EXCHANGE_TIMEOUT,
        candidates_exchange(shared, conn.clone(), vaddr, false),
    )
    .await
    .is_ok_and(|r| r.is_ok());
    if ok {
        note_direct(shared, hybrid);
        // Keep the connection alive so in-flight stream data is reliably delivered;
        // dropping a quinn connection closes it immediately.
        tokio::spawn(async move {
            conn.closed().await;
        });
    } else {
        tracing::warn!("candidate exchange failed or timed out");
    }
}

/// Symmetric exchange: each side writes its candidate list on its own bi stream and
/// reads the peer's from the peer's stream. No route is enabled until BOTH lists are
/// in hand — otherwise the first side to finish would switch the candidates
/// connection itself onto a UDP path the peer cannot yet demux, deadlocking the
/// exchange.
async fn candidates_exchange(
    shared: &EndpointShared,
    conn: Connection,
    peer_virtual: SocketAddr,
    dialer: bool,
) -> Result<(), String> {
    let ours = encode_candidates(&local_candidates(shared));
    let (mut send, _our_recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
    tracing::debug!(dialer, "candidates: stream ready, writing ours");
    send.write_all(&ours).await.map_err(|e| e.to_string())?;
    send.finish().map_err(|e| e.to_string())?;
    let (_their_send, mut their_recv) = conn.accept_bi().await.map_err(|e| e.to_string())?;
    tracing::debug!(dialer, "candidates: ours sent, reading theirs");
    let theirs = their_recv.read_to_end(16 * 1024).await.map_err(|e| e.to_string())?;
    tracing::debug!(dialer, "candidates: read {} bytes", theirs.len());
    let peer_candidates = decode_candidates(&theirs)?;
    let chosen = peer_candidates.first().copied();
    if let (Some(hybrid), Some(real)) = (&shared.hybrid, chosen) {
        hybrid.set_route(peer_virtual, Some(real));
        debug!(%peer_virtual, %real, "direct path selected");
    }
    Ok(())
}

/// Track the direct path: suppress relay keepalives under the quiet policy
/// (ADR-016/018); resume them if the route reverts (fallback or watchdog).
fn note_direct(shared: &EndpointShared, hybrid: &Arc<HybridSocket>) {
    shared.direct_count.fetch_add(1, Ordering::SeqCst);
    let policy_quiet = matches!(shared.relay_path_policy, RelayPathPolicy::QuietWhenDirect);
    if policy_quiet {
        shared.relay.set_direct_quiet(true);
    }
    let count = shared.direct_count.clone();
    let relay = shared.relay.clone();
    let hybrid = hybrid.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if hybrid.direct_count() == 0 {
                count.store(0, Ordering::SeqCst);
                if policy_quiet {
                    relay.set_direct_quiet(false);
                }
                break;
            }
        }
    });
}

/// The addresses we advertise: primary local + STUN reflexive.
fn local_candidates(shared: &EndpointShared) -> Vec<SocketAddr> {
    let mut out: Vec<SocketAddr> = Vec::new();
    if let Some(primary) = primary_local_ipv4() {
        if let Some(h) = &shared.hybrid {
            if let Ok(local) = h.udp_local_addr() {
                out.push(SocketAddr::new(primary.into(), local.port()));
            }
        }
    }
    if let Some(r) = *shared.reflexive.lock().expect("reflexive") {
        if !out.contains(&r) {
            out.push(r);
        }
    }
    out
}

fn client_config_for(secret: &SecretKey, alpn: &[u8]) -> quinn::ClientConfig {
    let cert = identity::generate_certificate(secret.bytes()).expect("regenerate cert");
    let tls_key = rustls_pki_types::PrivateKeyDer::Pkcs8(cert.key_der.into());
    let tls_cert = rustls_pki_types::CertificateDer::from(cert.cert_der);
    let mut client_tls = quinn::rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAll))
        .with_client_auth_cert(vec![tls_cert], tls_key)
        .expect("client config");
    client_tls.alpn_protocols = vec![alpn.to_vec()];
    let mut transport = quinn::TransportConfig::default();
    transport.keep_alive_interval(Some(DIRECT_KEEPALIVE));
    let mut config = quinn::ClientConfig::new(Arc::new(
        QuicClientConfig::try_from(client_tls).expect("quic client config"),
    ));
    config.transport_config(Arc::new(transport));
    config
}

/// Extract and verify the peer's Ed25519 identity from the QUIC connection.
fn peer_identity(conn: &Connection) -> Result<identity::PeerIdentity, IdentityError> {
    let certs = conn
        .peer_identity()
        .and_then(|any| {
            any.downcast::<Vec<rustls_pki_types::CertificateDer<'static>>>()
                .ok()
                .map(|b| *b)
        })
        .ok_or(IdentityError::NoCertificate)?;
    identity::verify_peer(&certs)
}

/// ALPN of an established connection (via rustls handshake data).
fn connection_alpn(conn: &Connection) -> Option<Vec<u8>> {
    let data = conn.handshake_data()?;
    let data = data
        .downcast::<quinn_proto::crypto::rustls::HandshakeData>()
        .ok()?;
    data.protocol.map(|p| p.to_vec())
}

fn encode_candidates(list: &[SocketAddr]) -> Vec<u8> {
    let mut out = vec![1u8, list.len().min(255) as u8];
    for addr in list.iter().take(255) {
        match addr.ip() {
            std::net::IpAddr::V4(ip) => {
                out.push(0x01);
                out.extend_from_slice(&ip.octets());
            }
            std::net::IpAddr::V6(ip) => {
                out.push(0x02);
                out.extend_from_slice(&ip.octets());
            }
        }
        out.extend_from_slice(&addr.port().to_be_bytes());
    }
    out
}

fn decode_candidates(bytes: &[u8]) -> Result<Vec<SocketAddr>, String> {
    if bytes.len() < 2 || bytes[0] != 1 {
        return Err("bad candidate version".into());
    }
    let count = bytes[1] as usize;
    let mut out = Vec::with_capacity(count);
    let mut pos = 2;
    for _ in 0..count {
        let family = *bytes.get(pos).ok_or("truncated")?;
        pos += 1;
        let ip = match family {
            0x01 => {
                if pos + 4 > bytes.len() {
                    return Err("truncated v4".into());
                }
                let ip = Ipv4Addr::new(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
                pos += 4;
                ip.into()
            }
            0x02 => {
                if pos + 16 > bytes.len() {
                    return Err("truncated v6".into());
                }
                let mut raw = [0u8; 16];
                raw.copy_from_slice(&bytes[pos..pos + 16]);
                pos += 16;
                std::net::Ipv6Addr::from(raw).into()
            }
            other => return Err(format!("bad family {other}")),
        };
        if pos + 2 > bytes.len() {
            return Err("truncated port".into());
        }
        let port = u16::from_be_bytes([bytes[pos], bytes[pos + 1]]);
        pos += 2;
        out.push(SocketAddr::new(ip, port));
    }
    Ok(out)
}

/// Best-effort primary local IPv4 (the connect trick sends no traffic).
fn primary_local_ipv4() -> Option<Ipv4Addr> {
    let socket = std::net::UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect(SocketAddrV4::new(Ipv4Addr::new(192, 0, 2, 1), 80)).ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

fn parse_socket_addr(text: &str) -> Option<SocketAddr> {
    // Allow "host:port" with DNS resolution skipped in the hot path: try numeric
    // first; fall back to a blocking lookup on a spawn (startup only).
    if let Ok(addr) = text.parse::<SocketAddr>() {
        return Some(addr);
    }
    let (host, port) = text.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    let ip: std::net::IpAddr = host.parse().ok().or_else(|| {
        // Minimal synchronous resolution for well-known STUN hostnames at startup.
        std::net::ToSocketAddrs::to_socket_addrs(&format!("{host}:0"))
            .ok()?
            .next()
            .map(|a| a.ip())
    })?;
    Some(SocketAddr::new(ip, port))
}

/// `builder(cfg)` (doc 09): an endpoint builder preconfigured for Switchback, with a
/// UDP socket and direct paths enabled.
pub fn builder(cfg: &SwitchbackConfig) -> EndpointBuilder {
    EndpointBuilder::new(cfg.clone())
}

/// `builder_relay_only(cfg)`: relayed connections only (no IP transports) — used by
/// `tools/e2e echo-relayed`.
pub fn builder_relay_only(cfg: &SwitchbackConfig) -> EndpointBuilder {
    let mut b = EndpointBuilder::new(cfg.clone());
    b.relay_only = true;
    b
}

/// `addr(cfg, peer)`: dial a peer by id alone (doc 09).
pub fn addr(cfg: &SwitchbackConfig, peer: EndpointId) -> EndpointAddr {
    EndpointAddr {
        peer,
        cairn: cfg.cairn_url.clone(),
    }
}

/// Wire protocol versions this client speaks (doc 01 §1).
pub fn protocol_versions() -> &'static [&'static str] {
    PROTOCOL_VERSIONS
}

/// One Cairn deployment's view of a peer: identity + where to reach it.
#[derive(Debug, Clone)]
pub struct LookupResult {
    pub peer: EndpointId,
    pub cairn: CairnUrl,
}

/// Client certificate verifier that accepts any certificate: peer authentication is the
/// Ed25519 identity proof, verified out-of-band of TLS chain validation (ADR-013).
#[derive(Debug)]
struct AcceptAnyClient;

impl quinn::rustls::server::danger::ClientCertVerifier for AcceptAnyClient {
    fn offer_client_auth(&self) -> bool {
        true
    }

    fn client_auth_mandatory(&self) -> bool {
        true
    }

    fn root_hint_subjects(&self) -> &[quinn::rustls::DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        _end_entity: &rustls_pki_types::CertificateDer<'_>,
        _intermediates: &[rustls_pki_types::CertificateDer<'_>],
        _now: rustls_pki_types::UnixTime,
    ) -> Result<quinn::rustls::server::danger::ClientCertVerified, quinn::rustls::Error> {
        Ok(quinn::rustls::server::danger::ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &quinn::rustls::DigitallySignedStruct,
    ) -> Result<quinn::rustls::client::danger::HandshakeSignatureValid, quinn::rustls::Error> {
        Ok(quinn::rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &quinn::rustls::DigitallySignedStruct,
    ) -> Result<quinn::rustls::client::danger::HandshakeSignatureValid, quinn::rustls::Error> {
        Ok(quinn::rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<quinn::rustls::SignatureScheme> {
        vec![
            quinn::rustls::SignatureScheme::RSA_PSS_SHA256,
            quinn::rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            quinn::rustls::SignatureScheme::ED25519,
        ]
    }
}

/// Certificate verifier that accepts any certificate: peer authentication is the
/// Ed25519 identity proof, verified out-of-band of TLS chain validation (ADR-013).
#[derive(Debug)]
struct AcceptAll;

impl quinn::rustls::client::danger::ServerCertVerifier for AcceptAll {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls_pki_types::CertificateDer<'_>,
        _intermediates: &[rustls_pki_types::CertificateDer<'_>],
        _server_name: &quinn::rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls_pki_types::UnixTime,
    ) -> Result<quinn::rustls::client::danger::ServerCertVerified, quinn::rustls::Error> {
        Ok(quinn::rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &quinn::rustls::DigitallySignedStruct,
    ) -> Result<quinn::rustls::client::danger::HandshakeSignatureValid, quinn::rustls::Error> {
        Ok(quinn::rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &quinn::rustls::DigitallySignedStruct,
    ) -> Result<quinn::rustls::client::danger::HandshakeSignatureValid, quinn::rustls::Error> {
        Ok(quinn::rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<quinn::rustls::SignatureScheme> {
        vec![
            quinn::rustls::SignatureScheme::RSA_PSS_SHA256,
            quinn::rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            quinn::rustls::SignatureScheme::ED25519,
        ]
    }
}
