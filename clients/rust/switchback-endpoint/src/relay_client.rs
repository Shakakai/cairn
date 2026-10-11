//! The Switchback v1 relay client (docs/01, 09-C1/C2/C3): authenticated WebSockets to
//! Cairn carrying `Send`/`SendBatch` out and the relay→client frame set in. A single
//! actor task owns the active connection and, during planned recycles, its replacement:
//!
//! - **C2 keepalive**: WebSocket ping every 15s; a missing pong within 5s kills the
//!   connection; the actor reconnects with backoff.
//! - **C3 make-before-break**: on `Restarting(reconnect_in, try_for)` (drain, deploy)
//!   the actor opens a new connection after a random delay in `[0, reconnect_in]` and
//!   keeps the old one until the new is established (ServerInfo received), then closes
//!   the old. `ServerInfo.max_conn_age_s > 0` schedules the same at
//!   `age − random(30..120s)`. `Status(1 Displaced)` logs a warning unless we opened
//!   the newer connection ourselves, in which case the old one closes quietly
//!   (doc 01 §5.1). The QUIC path above the socket is never disturbed: the outbound
//!   channel and inbound queues outlive the swap.
//! - Unknown frame types and unknown status codes are ignored (doc 01 §1).

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::{debug, warn};

use switchback_proto::{
    create_auth_blob, decode_relay_frame, encode_auth_blob_b64, frames::frame_type, RelayFrame,
};

/// Endpoint key bytes (32-byte Ed25519 public key).
pub type EndpointKeyBytes = [u8; 32];

/// Everything the relay told us about itself (doc 01 §4.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerInfo {
    pub max_payload: u32,
    pub max_conn_age_s: u32,
    pub region: String,
    pub conn_id: String,
}

/// Control-plane events surfaced to the endpoint (and to e2e scenarios).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayEvent {
    ServerInfo(ServerInfo),
    /// Status(1): a newer connection took over this EndpointId.
    Displaced,
    /// Status(0): this connection now receives traffic (promotion).
    BecameActive,
    /// Status(2): the relay is rate limiting us.
    RateLimited,
    /// The relayed path to `peer` no longer exists (doc 01 §5.3).
    PeerGone(String),
    /// Planned restart/drain (doc 01 §4.6); make-before-break follows (C3).
    Restarting { reconnect_in_ms: u32, try_for_ms: u32 },
    /// A relay connection was (re-)established; generation increments per recycle.
    Connected { generation: u64 },
}

/// One recorded raw frame (bytes include the type byte).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedFrame {
    pub outgoing: bool,
    pub bytes: Vec<u8>,
}

/// Shared recording hook (tests enable it via [`RelayClientHandle::recorder`]).
#[derive(Debug, Default, Clone)]
pub struct Recorder {
    frames: Arc<Mutex<Vec<RecordedFrame>>>,
    enabled: Arc<AtomicBool>,
}

impl Recorder {
    pub fn enable(&self) {
        self.enabled.store(true, Ordering::SeqCst);
    }

    fn record(&self, outgoing: bool, bytes: &[u8]) {
        if !self.enabled.load(Ordering::SeqCst) {
            return;
        }
        let mut guard = self.frames.lock().expect("recorder");
        if guard.len() < 500_000 {
            guard.push(RecordedFrame {
                outgoing,
                bytes: bytes.to_vec(),
            });
        }
    }

    /// Recorded frames in wire order.
    pub fn frames(&self) -> Vec<RecordedFrame> {
        self.frames.lock().expect("recorder").clone()
    }

    pub fn clear(&self) {
        self.frames.lock().expect("recorder").clear();
    }
}

/// Per-socket queues connecting the relay actor and quinn's UDP socket abstraction.
pub struct SocketQueues {
    /// Inbound datagrams waiting for quinn: (from-addr, ecn, payload).
    pub(crate) inbound: Mutex<VecDeque<(SocketAddr, u8, Vec<u8>)>>,
    /// Wakers of pending poll_recv calls.
    pub(crate) wakers: Mutex<Vec<std::task::Waker>>,
    /// Reverse map: quinn's peer address -> endpoint key bytes (registered by connect()).
    peer_map: Mutex<std::collections::HashMap<SocketAddr, EndpointKeyBytes>>,
}

impl SocketQueues {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            inbound: Mutex::new(VecDeque::new()),
            wakers: Mutex::new(Vec::new()),
            peer_map: Mutex::new(std::collections::HashMap::new()),
        })
    }

    pub(crate) fn register_peer(&self, addr: SocketAddr, key: EndpointKeyBytes) {
        self.peer_map.lock().expect("peer_map").insert(addr, key);
    }

    pub(crate) fn peer_key(&self, addr: &SocketAddr) -> Option<EndpointKeyBytes> {
        self.peer_map.lock().expect("peer_map").get(addr).copied()
    }

    pub(crate) fn push_inbound(&self, datagram: (SocketAddr, u8, Vec<u8>)) {
        self.inbound.lock().expect("inbound").push_back(datagram);
        for waker in self.wakers.lock().expect("wakers").drain(..) {
            waker.wake();
        }
    }
}

/// Configuration for the relay client.
pub struct RelayClientConfig {
    /// `ws(s)://host/v1/connect`.
    pub connect_url: String,
    /// Lower-cased host (no port) used in the auth blob.
    pub auth_host: String,
    pub secret_key: [u8; 32],
    pub access_token: Option<String>,
    /// C4 (QuietWhenDirect): suppress the self-keepalive once a direct path is active.
    pub quiet_when_direct: bool,
}

/// Live relay connection state, updated by the actor.
#[derive(Debug, Default)]
pub struct RelayState {
    pub server_info: Option<ServerInfo>,
    /// Status(0) received for the current generation.
    pub active: bool,
    /// The newest established generation.
    pub generation: u64,
}

struct Shared {
    state: Mutex<RelayState>,
    /// C4: set by the endpoint once a direct path is selected (quiet policy).
    direct_quiet: AtomicBool,
    recorder: Recorder,
    queues: Arc<SocketQueues>,
}

/// Aborts the actor when the last handle clone drops. The QUIC layer may outlive the
/// endpoint (connections keep the socket alive), so channel-closure alone cannot stop
/// the actor: application teardown must close the relay socket.
struct ActorGuard {
    abort: tokio::task::AbortHandle,
}

impl Drop for ActorGuard {
    fn drop(&mut self) {
        self.abort.abort();
    }
}

/// Handle to the running relay client actor.
#[derive(Clone)]
pub struct RelayClientHandle {
    /// Outbound datagrams: (dst key bytes, ecn, payload). Fed by the socket layer.
    pub(crate) outbound: mpsc::UnboundedSender<(EndpointKeyBytes, u8, Bytes)>,
    shared: Arc<Shared>,
    endpoint_id: String,
    fanout: Arc<Mutex<Vec<mpsc::UnboundedSender<RelayEvent>>>>,
    _guard: Arc<ActorGuard>,
}

impl RelayClientHandle {
    pub fn endpoint_id(&self) -> &str {
        &self.endpoint_id
    }

    pub fn server_info(&self) -> Option<ServerInfo> {
        self.shared.state.lock().expect("state").server_info.clone()
    }

    /// True once Status(0 Active) has been received for the current generation.
    pub fn is_active(&self) -> bool {
        self.shared.state.lock().expect("state").active
    }

    /// Current generation number (increases on every established recycle).
    pub fn generation(&self) -> u64 {
        self.shared.state.lock().expect("state").generation
    }

    /// Subscribe to control events (ServerInfo, Restarting, Connected, ...).
    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<RelayEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.fanout.lock().expect("fanout").push(tx);
        rx
    }

    pub fn recorder(&self) -> Recorder {
        self.shared.recorder.clone()
    }

    /// C4: mark that a direct path is (or is no longer) selected.
    pub fn set_direct_quiet(&self, quiet: bool) {
        self.shared.direct_quiet.store(quiet, Ordering::SeqCst);
    }
}

const PING_INTERVAL: Duration = Duration::from_secs(15);
const PONG_TIMEOUT: Duration = Duration::from_secs(5);
/// Platform keepalive (ADR-016): an empty datagram to ourselves after 30s of quiet.
const DATA_KEEPALIVE_AFTER: Duration = Duration::from_secs(30);
/// C3: reconnect at `age - random(30..=120s)` (doc 09).
const AGE_JITTER_MIN_S: u64 = 30;
const AGE_JITTER_SPREAD: u64 = 91;

/// Connect to Cairn and spawn the actor. Planned recycles are make-before-break (C3);
/// unexpected failures fall back to reconnect-with-backoff.
pub fn spawn(cfg: RelayClientConfig, queues: Arc<SocketQueues>) -> RelayClientHandle {
    let (outbound_tx, outbound_rx) = mpsc::unbounded_channel::<(EndpointKeyBytes, u8, Bytes)>();
    let (events_tx, mut events_rx) = mpsc::unbounded_channel::<RelayEvent>();
    let fanout: Arc<Mutex<Vec<mpsc::UnboundedSender<RelayEvent>>>> = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::new(Shared {
        state: Mutex::new(RelayState::default()),
        direct_quiet: AtomicBool::new(false),
        recorder: Recorder::default(),
        queues: queues.clone(),
    });

    let endpoint_id =
        switchback_proto::endpoint_id_from_bytes(&switchback_proto::ed25519_public_key(&cfg.secret_key));

    // Fan actor events out to subscribers.
    {
        let fanout = fanout.clone();
        tokio::spawn(async move {
            while let Some(ev) = events_rx.recv().await {
                fanout.lock().expect("fanout").retain(|tx| tx.send(ev.clone()).is_ok());
            }
        });
    }

    let task = tokio::spawn(actor(cfg, outbound_rx, events_tx, shared.clone()));

    RelayClientHandle {
        outbound: outbound_tx,
        shared,
        endpoint_id,
        fanout,
        _guard: Arc::new(ActorGuard {
            abort: task.abort_handle(),
        }),
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// One connection generation of the actor.
struct Conn {
    ws: Ws,
    generation: u64,
    established: bool,
    /// When this generation should pre-emptively recycle (max_conn_age, C3).
    recycle_at: Option<tokio::time::Instant>,
}

async fn connect_ws(cfg: &RelayClientConfig, endpoint_bytes: &EndpointKeyBytes) -> Result<Ws, Box<dyn std::error::Error + Send + Sync>> {
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).map_err(|e| format!("rng: {e}"))?;
    let blob = create_auth_blob(cfg.secret_key_ref(), &cfg.auth_host, endpoint_bytes, now_unix_ms(), &nonce);
    let auth = encode_auth_blob_b64(&blob);

    let mut request: Request = cfg.connect_url.as_str().into_client_request()?;
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        "switchback.v1".parse().expect("protocol token"),
    );
    request
        .headers_mut()
        .insert("Switchback-Auth", auth.parse().expect("base64url token"));
    if let Some(token) = &cfg.access_token {
        request
            .headers_mut()
            .insert("Authorization", format!("Bearer {token}").parse().expect("bearer"));
    }
    let (ws, _response) = tokio_tungstenite::connect_async(request).await?;
    Ok(ws)
}

impl RelayClientConfig {
    fn secret_key_ref(&self) -> &[u8; 32] {
        &self.secret_key
    }
}

#[allow(clippy::too_many_lines)]
async fn actor(
    cfg: RelayClientConfig,
    mut outbound: mpsc::UnboundedReceiver<(EndpointKeyBytes, u8, Bytes)>,
    events: mpsc::UnboundedSender<RelayEvent>,
    shared: Arc<Shared>,
) {
    let endpoint_bytes = switchback_proto::ed25519_public_key(&cfg.secret_key);
    let mut generation_counter = 0u64;
    let mut backoff = Duration::from_secs(1);

    // Establish the first connection.
    let mut conn: Conn = loop {
        match connect_ws(&cfg, &endpoint_bytes).await {
            Ok(ws) => {
                generation_counter += 1;
                break Conn {
                    ws,
                    generation: generation_counter,
                    established: false,
                    recycle_at: None,
                };
            }
            Err(error) => {
                warn!(%error, "relay connect failed; retrying");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(15));
            }
        }
    };
    backoff = Duration::from_secs(1);

    // Replacement being built (C3).
    let mut replacement: Option<Conn> = None;
    let mut connect_at: Option<tokio::time::Instant> = None;
    let mut connecting: Option<tokio::task::JoinHandle<Result<Ws, Box<dyn std::error::Error + Send + Sync>>>> = None;

    let mut conn_dead = false;
    let mut ping_timer = tokio::time::interval(PING_INTERVAL);
    ping_timer.tick().await; // consume the immediate first tick
    let mut pong_deadline = Box::pin(tokio::time::sleep(PING_INTERVAL + PONG_TIMEOUT));
    let mut awaiting_pong = false;
    let mut last_activity = std::time::Instant::now();

    loop {
        tokio::select! {
            _ = ping_timer.tick() => {
                let mut payload = [0u8; 8];
                if getrandom::getrandom(&mut payload).is_err() {
                    continue;
                }
                let ping = Message::Ping(Bytes::from(payload.to_vec()));
                let _ = conn.ws.send(ping).await;
                awaiting_pong = true;
                pong_deadline.as_mut().reset(tokio::time::Instant::now() + PONG_TIMEOUT);
                if last_activity.elapsed() >= DATA_KEEPALIVE_AFTER {
                    // Quiet connection: self-keepalive (ADR-016), suppressed when a
                    // direct path is selected under the quiet policy (C4).
                    let quiet = cfg.quiet_when_direct
                        && shared.direct_quiet.load(Ordering::SeqCst);
                    if !quiet {
                        let frame = build_send_frame(&endpoint_bytes, 0, &[]);
                        shared.recorder.record(true, &frame);
                        if conn.ws.send(Message::Binary(Bytes::from(frame))).await.is_err() {
                            continue;
                        }
                        last_activity = std::time::Instant::now();
                    }
                }
            }
            _ = &mut pong_deadline, if awaiting_pong => {
                // C2: no pong within 5s of our ping: this connection is dead.
                warn!("relay: pong timeout; reconnecting");
                fail_connection(&mut conn, &shared).await;
                conn_dead = true;
                if replacement_in_flight(&connect_at, &connecting, &replacement) {
                    continue;
                }
                match reconnect(&cfg, &endpoint_bytes, &mut generation_counter, &mut backoff).await {
                    Ok(new_conn) => { conn = new_conn; conn_dead = false; backoff = Duration::from_secs(1); }
                    Err(()) => { /* loop retries */ }
                }
            }
            item = outbound.recv() => {
                let Some((dst, ecn, payload)) = item else { return };
                let frame = build_send_frame(&dst, ecn, &payload);
                shared.recorder.record(true, &frame);
                let target = replacement.as_mut().unwrap_or(&mut conn);
                if target.ws.send(Message::Binary(Bytes::from(frame))).await.is_err() {
                    continue;
                }
                last_activity = std::time::Instant::now();
            }
            // A dead current connection (closed while a C3 replacement is pending)
            // would otherwise return Ready(None) forever and spin this task.
            msg = conn.ws.next(), if !conn_dead => {
                let Some(msg) = msg else {
                    fail_connection(&mut conn, &shared).await;
                    conn_dead = true;
                    if replacement_in_flight(&connect_at, &connecting, &replacement) {
                        continue;
                    }
                    match reconnect(&cfg, &endpoint_bytes, &mut generation_counter, &mut backoff).await {
                        Ok(new_conn) => { conn = new_conn; conn_dead = false; backoff = Duration::from_secs(1); }
                        Err(()) => continue,
                    }
                    continue;
                };
                match msg {
                    Ok(Message::Binary(data)) => {
                        shared.recorder.record(false, &data);
                        if let Some(reconnect_in_ms) = handle_frame(&data, &mut conn, &shared, &events) {
                            if !replacement_in_flight(&connect_at, &connecting, &replacement) {
                                let delay =
                                    Duration::from_millis(random_below(reconnect_in_ms as u64 + 1));
                                connect_at = Some(tokio::time::Instant::now() + delay);
                            }
                        }
                    }
                    Ok(Message::Pong(_)) => { awaiting_pong = false; }
                    Ok(Message::Ping(data)) => {
                        let _ = conn.ws.send(Message::Pong(data)).await;
                    }
                    Ok(Message::Close(frame)) => {
                        debug!(?frame, "relay sent close");
                        fail_connection(&mut conn, &shared).await;
                        conn_dead = true;
                        // A C3 replacement (armed by a preceding Restarting) takes over;
                        // do not race it with a break-then-make reconnect.
                        if replacement_in_flight(&connect_at, &connecting, &replacement) {
                            continue;
                        }
                        match reconnect(&cfg, &endpoint_bytes, &mut generation_counter, &mut backoff).await {
                            Ok(new_conn) => { conn = new_conn; conn_dead = false; backoff = Duration::from_secs(1); }
                            Err(()) => continue,
                        }
                    }
                    Ok(Message::Text(_)) | Ok(Message::Frame(_)) => {
                        // Text is ignored by both sides (doc 01 §4).
                    }
                    Err(_) => {
                        fail_connection(&mut conn, &shared).await;
                        conn_dead = true;
                        if replacement_in_flight(&connect_at, &connecting, &replacement) {
                            continue;
                        }
                        match reconnect(&cfg, &endpoint_bytes, &mut generation_counter, &mut backoff).await {
                            Ok(new_conn) => { conn = new_conn; conn_dead = false; backoff = Duration::from_secs(1); }
                            Err(()) => continue,
                        }
                    }
                }
            }
            msg = async { match replacement.as_mut() { Some(c) => c.ws.next().await, None => std::future::pending().await } } => {
                let Some(msg) = msg else {
                    replacement = None;
                    continue;
                };
                match msg {
                    Ok(Message::Binary(data)) => {
                        shared.recorder.record(false, &data);
                        let was_established = replacement.as_ref().is_some_and(|c| c.established);
                        let schedule = if let Some(rep) = replacement.as_mut() {
                            handle_frame(&data, rep, &shared, &events)
                        } else {
                            None
                        };
                        if schedule.is_some() {
                            // The replacement is itself being recycled before takeover:
                            // drop it and let the normal reconnect path run.
                            replacement = None;
                            if !conn_dead && connecting.is_none() && connect_at.is_none() {
                                connect_at = Some(tokio::time::Instant::now());
                            }
                        }
                        // Established? (ServerInfo seen) → swap (C3 make-before-break).
                        if !was_established && replacement.as_ref().is_some_and(|c| c.established) {
                            let new_conn = replacement.take().expect("checked");
                            let old = std::mem::replace(&mut conn, new_conn);
                            drop(old.ws); // close the old socket quietly
                            conn_dead = false;
                            awaiting_pong = false;
                            let _ = events.send(RelayEvent::Connected { generation: conn.generation });
                        }
                    }
                    Ok(Message::Pong(_)) | Ok(Message::Ping(_)) | Ok(Message::Text(_)) | Ok(Message::Frame(_)) => {}
                    Ok(Message::Close(frame)) => {
                        debug!(?frame, "replacement closed before establishing");
                        replacement = None;
                        if conn_dead && connecting.is_none() && connect_at.is_none() {
                            if let Ok(new_conn) =
                                reconnect(&cfg, &endpoint_bytes, &mut generation_counter, &mut backoff).await
                            {
                                conn = new_conn;
                                conn_dead = false;
                                backoff = Duration::from_secs(1);
                            }
                        }
                    }
                    Err(_) => {
                        replacement = None;
                        if conn_dead && connecting.is_none() && connect_at.is_none() {
                            if let Ok(new_conn) =
                                reconnect(&cfg, &endpoint_bytes, &mut generation_counter, &mut backoff).await
                            {
                                conn = new_conn;
                                conn_dead = false;
                                backoff = Duration::from_secs(1);
                            }
                        }
                    }
                }
            }
            _ = sleep_until(connect_at), if connect_at.is_some() && replacement.is_none() && connecting.is_none() => {
                connect_at = None;
                let cfg2 = clone_cfg(&cfg);
                let ep = endpoint_bytes;
                connecting = Some(tokio::spawn(async move { connect_ws(&cfg2, &ep).await }));
            }
            result = async { match connecting.as_mut() { Some(j) => j.await, None => std::future::pending().await } } => {
                connecting = None;
                match result {
                    Ok(Ok(ws)) => {
                        generation_counter += 1;
                        replacement = Some(Conn {
                            ws,
                            generation: generation_counter,
                            established: false,
                            recycle_at: None,
                        });
                    }
                    Ok(Err(error)) => {
                        warn!(%error, "replacement connect failed");
                    }
                    Err(_) => {}
                }
            }
            _ = sleep_until(conn.recycle_at), if conn.recycle_at.is_some() && replacement.is_none() && connecting.is_none() => {
                conn.recycle_at = None;
                let cfg2 = clone_cfg(&cfg);
                let ep = endpoint_bytes;
                connecting = Some(tokio::spawn(async move { connect_ws(&cfg2, &ep).await }));
            }
        }
        backoff = if conn.established { Duration::from_secs(1) } else { backoff };
    }
}

async fn fail_connection(conn: &mut Conn, shared: &Arc<Shared>) {
    let _ = conn.ws.close(None).await;
    shared.state.lock().expect("state").active = false;
}

async fn reconnect(
    cfg: &RelayClientConfig,
    endpoint_bytes: &EndpointKeyBytes,
    generation_counter: &mut u64,
    backoff: &mut Duration,
) -> Result<Conn, ()> {
    tokio::time::sleep(*backoff).await;
    match connect_ws(cfg, endpoint_bytes).await {
        Ok(ws) => {
            *generation_counter += 1;
            Ok(Conn {
                ws,
                generation: *generation_counter,
                established: false,
                recycle_at: None,
            })
        }
        Err(error) => {
            warn!(%error, "relay reconnect failed; will retry");
            *backoff = (*backoff * 2).min(Duration::from_secs(15));
            Err(())
        }
    }
}

/// Schedule the C3 max-age recycle relative to `now` (called on establishment).
/// Only when the jitter fits inside the age: the relay's own Restarting drives
/// make-before-break otherwise, and a same-instant client recycle would just displace
/// the server-triggered replacement (displacement war).
fn arm_recycle(conn: &mut Conn, shared: &Arc<Shared>) {
    let Some(info) = shared.state.lock().expect("state").server_info.clone() else { return };
    if info.max_conn_age_s == 0 {
        return;
    }
    let age = Duration::from_secs(info.max_conn_age_s as u64);
    let jitter = Duration::from_secs(random_below(AGE_JITTER_SPREAD) + AGE_JITTER_MIN_S);
    let Some(before) = age.checked_sub(jitter).filter(|d| !d.is_zero()) else {
        return;
    };
    conn.recycle_at = Some(tokio::time::Instant::now() + before);
}

/// Handle one relay frame for `conn`. Control events route through the shared bus;
/// the first ServerInfo on a connection marks it established (drives C3 scheduling and
/// the make-before-break swap).
#[allow(clippy::too_many_arguments)]
/// Handle one relay frame; returns `Some(reconnect_in_ms)` when the frame asks for a
/// C3 replacement (Restarting). The caller owns scheduling and all replacement state.
fn handle_frame(
    data: &[u8],
    conn: &mut Conn,
    shared: &Arc<Shared>,
    events: &mpsc::UnboundedSender<RelayEvent>,
) -> Option<u32> {
    match decode_relay_frame(data) {
        Ok(RelayFrame::ServerInfo {
            max_payload,
            max_conn_age_s,
            region,
            conn_id,
        }) => {
            let info = ServerInfo {
                max_payload,
                max_conn_age_s,
                region,
                conn_id,
            };
            {
                let mut state = shared.state.lock().expect("state");
                state.server_info = Some(info.clone());
                state.generation = conn.generation;
            }
            if !conn.established {
                conn.established = true;
                let _ = events.send(RelayEvent::Connected { generation: conn.generation });
                arm_recycle(conn, shared);
            }
            let _ = events.send(RelayEvent::ServerInfo(info));
        }
        Ok(RelayFrame::Recv { src, ecn, datagram }) => {
            shared.queues.register_peer(crate::socket::peer_addr(&src), src);
            shared.queues.push_inbound((crate::socket::peer_addr(&src), ecn, datagram));
        }
        Ok(RelayFrame::RecvBatch {
            src,
            ecn,
            datagrams,
            segment_size,
        }) => {
            shared.queues.register_peer(crate::socket::peer_addr(&src), src);
            for chunk in datagrams.chunks(segment_size.max(1) as usize) {
                shared
                    .queues
                    .push_inbound((crate::socket::peer_addr(&src), ecn, chunk.to_vec()));
            }
        }
        Ok(RelayFrame::PeerGone { peer }) => {
            let _ = events.send(RelayEvent::PeerGone(switchback_proto::endpoint_id_from_bytes(&peer)));
        }
        Ok(RelayFrame::Status { code }) => match code {
            0 => {
                shared.state.lock().expect("state").active = true;
                let _ = events.send(RelayEvent::BecameActive);
            }
            1 => {
                warn!("relay: Displaced — the same EndpointId connected elsewhere");
                shared.state.lock().expect("state").active = false;
                let _ = events.send(RelayEvent::Displaced);
            }
            2 => {
                let _ = events.send(RelayEvent::RateLimited);
            }
            other => debug!(code = other, "unknown status code ignored"),
        },
        Ok(RelayFrame::Restarting {
            reconnect_in_ms,
            try_for_ms,
        }) => {
            let _ = events.send(RelayEvent::Restarting {
                reconnect_in_ms,
                try_for_ms,
            });
            return Some(reconnect_in_ms); // caller schedules: delay in [0, reconnect_in]
        }
        Ok(RelayFrame::Unknown { frame_type }) => {
            debug!(frame_type, "unknown relay frame type ignored");
        }
        Err(error) => warn!(%error, "malformed relay frame ignored"),
    }
    None
}

fn replacement_in_flight(
    connect_at: &Option<tokio::time::Instant>,
    connecting: &Option<tokio::task::JoinHandle<Result<Ws, Box<dyn std::error::Error + Send + Sync>>>>,
    replacement: &Option<Conn>,
) -> bool {
    connect_at.is_some() || connecting.is_some() || replacement.is_some()
}

async fn sleep_until(at: Option<tokio::time::Instant>) {
    match at {
        Some(instant) => {
            let now = tokio::time::Instant::now();
            if instant > now {
                tokio::time::sleep_until(instant).await;
            }
        }
        None => std::future::pending().await,
    }
}

fn clone_cfg(cfg: &RelayClientConfig) -> RelayClientConfig {
    RelayClientConfig {
        connect_url: cfg.connect_url.clone(),
        auth_host: cfg.auth_host.clone(),
        secret_key: cfg.secret_key,
        access_token: cfg.access_token.clone(),
        quiet_when_direct: cfg.quiet_when_direct,
    }
}

fn random_below(n: u64) -> u64 {
    if n <= 1 {
        return 0;
    }
    let mut buf = [0u8; 8];
    getrandom::getrandom(&mut buf).expect("CSPRNG");
    u64::from_le_bytes(buf) % n
}

fn build_send_frame(dst: &[u8; 32], ecn: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(1 + 32 + 1 + payload.len());
    frame.push(frame_type::SEND);
    frame.extend_from_slice(dst);
    frame.push(ecn);
    frame.extend_from_slice(payload);
    frame
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
