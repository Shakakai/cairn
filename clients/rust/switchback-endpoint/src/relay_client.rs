//! The Switchback v1 relay client (docs/01, 09-C1): one authenticated WebSocket to Cairn
//! carrying `Send`/`SendBatch` out and `ServerInfo`/`Recv`/`RecvBatch`/`PeerGone`/`Status`/
//! `Restarting` in. WebSocket-level keepalives (C2): ping every 15s, reconnect if no pong
//! within 5s. Unknown frame types and unknown status codes are ignored (doc 01 §1).
//!
//! The client is the transport under [`crate::socket::RelaySocket`]: outbound datagrams
//! arrive from the socket on an unbounded channel, inbound datagrams are queued on the
//! socket's own [`SocketQueues`]. A recording hook captures every raw frame so e2e can
//! assert only Switchback v1 frames cross the wire.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::task::Waker;
use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::{debug, warn};

use switchback_proto::{create_auth_blob, decode_relay_frame, encode_auth_blob_b64, RelayFrame};
use switchback_proto::frames::frame_type;

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
    /// Planned restart/drain (doc 01 §4.6); full make-before-break handling is M7 (C3).
    Restarting { reconnect_in_ms: u32, try_for_ms: u32 },
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
    enabled: Arc<std::sync::atomic::AtomicBool>,
}

impl Recorder {
    pub fn enable(&self) {
        self.enabled.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn record(&self, outgoing: bool, bytes: &[u8]) {
        if !self.enabled.load(std::sync::atomic::Ordering::SeqCst) {
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
    pub(crate) wakers: Mutex<Vec<Waker>>,
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

    fn push_inbound(&self, datagram: (SocketAddr, u8, Vec<u8>)) {
        self.inbound.lock().expect("inbound").push_back(datagram);
        for waker in self.wakers.lock().expect("wakers").drain(..) {
            waker.wake();
        }
    }
}

/// Configuration for one relay connection.
pub struct RelayClientConfig {
    /// `ws(s)://host/v1/connect`.
    pub connect_url: String,
    /// Lower-cased host (no port) used in the auth blob.
    pub auth_host: String,
    pub secret_key: [u8; 32],
    pub access_token: Option<String>,
}

/// Live relay connection state, updated by the actor.
#[derive(Debug, Default)]
pub struct RelayState {
    pub server_info: Option<ServerInfo>,
    /// Status(0) received: the relay routes traffic to this connection.
    pub active: bool,
}

/// Aborts the actor task when the last handle clone drops (endpoint shutdown closes the
/// relay WebSocket, which makes Cairn unregister the endpoint and fan out PeerGone).
struct ActorGuard {
    abort: tokio::task::AbortHandle,
}

impl Drop for ActorGuard {
    fn drop(&mut self) {
        self.abort.abort();
    }
}

/// Handle to a running relay client.
#[derive(Clone)]
pub struct RelayClientHandle {
    /// Outbound datagrams: (dst key bytes, ecn, payload). Fed by RelaySocket::poll_send.
    pub(crate) outbound: mpsc::UnboundedSender<(EndpointKeyBytes, u8, Bytes)>,
    state: Arc<Mutex<RelayState>>,
    fanout: Arc<Mutex<Vec<mpsc::UnboundedSender<RelayEvent>>>>,
    recorder: Recorder,
    endpoint_id: String,
    _guard: Arc<ActorGuard>,
}

impl RelayClientHandle {
    pub fn endpoint_id(&self) -> &str {
        &self.endpoint_id
    }

    pub fn server_info(&self) -> Option<ServerInfo> {
        self.state.lock().expect("state").server_info.clone()
    }

    /// True once Status(0 Active) has been received for this connection.
    pub fn is_active(&self) -> bool {
        self.state.lock().expect("state").active
    }

    /// Subscribe to control events (ServerInfo, Displaced, PeerGone, ...).
    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<RelayEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.fanout.lock().expect("fanout").push(tx);
        rx
    }

    pub fn recorder(&self) -> Recorder {
        self.recorder.clone()
    }
}

/// Connect to Cairn and spawn the client task. Reconnects with backoff on failure.
pub fn spawn(cfg: RelayClientConfig, queues: Arc<SocketQueues>) -> RelayClientHandle {
    let (outbound_tx, outbound_rx) = mpsc::unbounded_channel::<(EndpointKeyBytes, u8, Bytes)>();
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<RelayEvent>();
    let state = Arc::new(Mutex::new(RelayState::default()));
    let recorder = Recorder::default();
    let fanout = Arc::new(Mutex::new(Vec::<mpsc::UnboundedSender<RelayEvent>>::new()));

    let endpoint_id =
        switchback_proto::endpoint_id_from_bytes(&switchback_proto::ed25519_public_key(&cfg.secret_key));

    // Fan actor events out to subscribers.
    let fanout2 = fanout.clone();
    tokio::spawn(async move {
        while let Some(ev) = event_rx.recv().await {
            let mut guard = fanout2.lock().expect("fanout");
            guard.retain(|tx| tx.send(ev.clone()).is_ok());
        }
    });

    let task = tokio::spawn(run(cfg, outbound_rx, event_tx, state.clone(), recorder.clone(), queues));

    RelayClientHandle {
        outbound: outbound_tx,
        state,
        fanout,
        recorder,
        endpoint_id,
        _guard: Arc::new(ActorGuard {
            abort: task.abort_handle(),
        }),
    }
}

const PING_INTERVAL: Duration = Duration::from_secs(15);
const PONG_TIMEOUT: Duration = Duration::from_secs(5);

async fn run(
    cfg: RelayClientConfig,
    mut outbound: mpsc::UnboundedReceiver<(EndpointKeyBytes, u8, Bytes)>,
    events: mpsc::UnboundedSender<RelayEvent>,
    state: Arc<Mutex<RelayState>>,
    recorder: Recorder,
    queues: Arc<SocketQueues>,
) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match connect_and_run(&cfg, &mut outbound, &events, &state, &recorder, &queues).await {
            Ok(()) => debug!("relay connection closed; reconnecting"),
            Err(error) => warn!(%error, "relay connection failed; reconnecting"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(15));
    }
}

async fn connect_and_run(
    cfg: &RelayClientConfig,
    outbound: &mut mpsc::UnboundedReceiver<(EndpointKeyBytes, u8, Bytes)>,
    events: &mpsc::UnboundedSender<RelayEvent>,
    state: &Arc<Mutex<RelayState>>,
    recorder: &Recorder,
    queues: &Arc<SocketQueues>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let endpoint_bytes = switchback_proto::ed25519_public_key(&cfg.secret_key);
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).map_err(|e| format!("rng: {e}"))?;
    let blob = create_auth_blob(
        &cfg.secret_key,
        &cfg.auth_host,
        &endpoint_bytes,
        now_unix_ms(),
        &nonce,
    );
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

    let (mut ws, _response) = tokio_tungstenite::connect_async(request).await?;
    debug!("relay websocket established");

    let mut ping_timer = tokio::time::interval(PING_INTERVAL);
    ping_timer.tick().await; // consume the immediate first tick
    let mut pong_deadline = Box::pin(tokio::time::sleep(PING_INTERVAL + PONG_TIMEOUT));
    let mut awaiting_pong = false;
    // Platform keepalive (ADR-016): Cloudflare reaps eyeball WebSockets after ~1-2 min
    // of data silence regardless of control pings; an empty datagram to ourselves
    // ("sending to yourself is allowed", doc 01 §4.2/§5.1) keeps quiet connections
    // alive on every platform. Sent only when nothing else has flowed recently.
    let mut last_activity = std::time::Instant::now();
    const DATA_KEEPALIVE_AFTER: std::time::Duration = Duration::from_secs(30);

    loop {
        tokio::select! {
            _ = ping_timer.tick() => {
                let mut payload = [0u8; 8];
                getrandom::getrandom(&mut payload).map_err(|e| format!("rng: {e}"))?;
                ws.send(Message::Ping(Bytes::from(payload.to_vec()))).await?;
                awaiting_pong = true;
                pong_deadline.as_mut().reset(tokio::time::Instant::now() + PONG_TIMEOUT);
                if last_activity.elapsed() >= DATA_KEEPALIVE_AFTER {
                    // Quiet connection: self-keepalive (ADR-016).
                    let frame = build_send_frame(&endpoint_bytes, 0, &[]);
                    recorder.record(true, &frame);
                    ws.send(Message::Binary(Bytes::from(frame))).await?;
                    last_activity = std::time::Instant::now();
                }
            }
            _ = &mut pong_deadline, if awaiting_pong => {
                // C2: no pong within 5s of our ping: drop; the outer loop reconnects.
                return Err("pong timeout".into());
            }
            item = outbound.recv() => {
                let Some((dst, ecn, payload)) = item else { return Ok(()) };
                let frame = build_send_frame(&dst, ecn, &payload);
                recorder.record(true, &frame);
                ws.send(Message::Binary(Bytes::from(frame))).await?;
                last_activity = std::time::Instant::now();
            }
            msg = ws.next() => {
                let Some(msg) = msg else { return Ok(()) };
                match msg? {
                    Message::Binary(data) => {
                        recorder.record(false, &data);
                        handle_frame(&data, events, state, queues)?;
                    }
                    Message::Pong(_) => { awaiting_pong = false; }
                    Message::Ping(data) => {
                        ws.send(Message::Pong(data)).await?;
                    }
                    Message::Close(frame) => {
                        debug!(?frame, "relay sent close");
                        return Ok(());
                    }
                    Message::Text(_) | Message::Frame(_) => {
                        // Text is ignored by both sides (doc 01 §4).
                    }
                }
            }
        }
    }
}

fn handle_frame(
    data: &[u8],
    events: &mpsc::UnboundedSender<RelayEvent>,
    state: &Arc<Mutex<RelayState>>,
    queues: &Arc<SocketQueues>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
            state.lock().expect("state").server_info = Some(info.clone());
            let _ = events.send(RelayEvent::ServerInfo(info));
        }
        Ok(RelayFrame::Recv { src, ecn, datagram }) => {
            // Learn the reverse mapping so our own transmits to this peer route by id.
            queues.register_peer(crate::socket::peer_addr(&src), src);
            queues.push_inbound((crate::socket::peer_addr(&src), ecn, datagram));
        }
        Ok(RelayFrame::RecvBatch {
            src,
            ecn,
            datagrams,
            segment_size,
        }) => {
            queues.register_peer(crate::socket::peer_addr(&src), src);
            for chunk in datagrams.chunks(segment_size.max(1) as usize) {
                queues.push_inbound((crate::socket::peer_addr(&src), ecn, chunk.to_vec()));
            }
        }
        Ok(RelayFrame::PeerGone { peer }) => {
            let _ = events.send(RelayEvent::PeerGone(switchback_proto::endpoint_id_from_bytes(&peer)));
        }
        Ok(RelayFrame::Status { code }) => match code {
            0 => {
                state.lock().expect("state").active = true;
                let _ = events.send(RelayEvent::BecameActive);
            }
            1 => {
                state.lock().expect("state").active = false;
                warn!("relay: Displaced — the same EndpointId connected elsewhere");
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
        }
        Ok(RelayFrame::Unknown { frame_type }) => {
            debug!(frame_type, "unknown relay frame type ignored");
        }
        Err(error) => warn!(%error, "malformed relay frame ignored"),
    }
    Ok(())
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
