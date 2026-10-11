//! The C4 hybrid socket: quinn's single `AsyncUdpSocket` that routes per-peer over the
//! Cairn relay or, once candidates are exchanged (in-band, ALPN
//! `switchback/candidates`), directly over UDP. Peers keep the same virtual addresses,
//! so quinn sees no path change; only the substrate switches (ADR-018).
//!
//! Fallback: a direct route that sees no inbound UDP from the peer for
//! `DIRECT_RX_TIMEOUT` reverts to the relay automatically.

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;
use std::task::Poll;
use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::sync::mpsc;

use crate::relay_client::{EndpointKeyBytes, SocketQueues};

/// ALPN for the in-band candidate exchange (ADR-018).
pub const CANDIDATES_ALPN: &[u8] = b"switchback/candidates";
/// A direct route with no inbound packets for this long reverts to the relay.
pub(crate) const DIRECT_RX_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Route {
    Relay,
    Direct(SocketAddr),
}

struct PeerState {
    route: Route,
    route_since: Instant,
    last_rx: Option<Instant>,
}

/// Shared UDP side, owned by the reader task and the socket.
pub(crate) struct UdpState {
    pub socket: tokio::net::UdpSocket,
    /// real source addr -> virtual peer addr (installed when a direct route is set).
    pub real_to_virtual: Mutex<HashMap<SocketAddr, SocketAddr>>,
    pub queues: Arc<SocketQueues>,
}

/// quinn `AsyncUdpSocket` over relay + UDP. Relay behaviour is unchanged; per-peer
/// routes decide the substrate for outbound datagrams.
pub(crate) struct HybridSocket {
    queues: Arc<SocketQueues>,
    outbound: mpsc::UnboundedSender<(EndpointKeyBytes, u8, Bytes)>,
    udp: Arc<UdpState>,
    peers: Arc<Mutex<HashMap<SocketAddr, PeerState>>>,
}

impl std::fmt::Debug for HybridSocket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HybridSocket").finish_non_exhaustive()
    }
}

impl HybridSocket {
    pub(crate) fn new(
        queues: Arc<SocketQueues>,
        outbound: mpsc::UnboundedSender<(EndpointKeyBytes, u8, Bytes)>,
        udp: Arc<UdpState>,
    ) -> Arc<Self> {
        Arc::new(Self {
            queues,
            outbound,
            udp,
            peers: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Switch the substrate for `virtual_peer`: `Some(real)` selects direct UDP,
    /// `None` returns the peer to the relay.
    pub(crate) fn set_route(&self, virtual_peer: SocketAddr, real: Option<SocketAddr>) {
        let mut peers = self.peers.lock().expect("peers");
        let state = peers.entry(virtual_peer).or_insert(PeerState {
            route: Route::Relay,
            route_since: Instant::now(),
            last_rx: None,
        });
        state.route = match real {
            Some(addr) => Route::Direct(addr),
            None => Route::Relay,
        };
        state.route_since = Instant::now();
        state.last_rx = None;
        if let Route::Direct(addr) = state.route {
            self.udp
                .real_to_virtual
                .lock()
                .expect("r2v")
                .insert(addr, virtual_peer);
        } else {
            self.udp
                .real_to_virtual
                .lock()
                .expect("r2v")
                .retain(|_, v| *v != virtual_peer);
        }
    }

    /// Local address of the underlying UDP socket.
    pub(crate) fn udp_local_addr(&self) -> io::Result<SocketAddr> {
        self.udp.socket.local_addr()
    }

    /// Peers currently routed direct (for tests/metrics).
    pub(crate) fn direct_count(&self) -> usize {
        self.peers
            .lock()
            .expect("peers")
            .values()
            .filter(|p| matches!(p.route, Route::Direct(_)))
            .count()
    }

    /// Learn that an inbound UDP datagram arrived from `real` (reader task).
    pub(crate) fn note_rx(&self, real: SocketAddr) {
        let vaddr = match self.udp.real_to_virtual.lock().expect("r2v").get(&real) {
            Some(v) => *v,
            None => return,
        };
        if let Some(state) = self.peers.lock().expect("peers").get_mut(&vaddr) {
            state.last_rx = Some(Instant::now());
        }
    }
}

impl quinn::AsyncUdpSocket for HybridSocket {
    fn create_io_poller(self: Arc<Self>) -> std::pin::Pin<Box<dyn quinn::UdpPoller>> {
        Box::pin(AlwaysWritable)
    }

    fn try_send(&self, transmit: &quinn_udp::Transmit<'_>) -> io::Result<()> {
        let Some(dst) = self.queues.peer_key(&transmit.destination) else {
            return Ok(()); // unknown peer (path probes): no route anyway
        };
        let route = {
            let mut peers = self.peers.lock().expect("peers");
            let state = peers.entry(transmit.destination).or_insert(PeerState {
                route: Route::Relay,
                route_since: Instant::now(),
                last_rx: None,
            });
            if matches!(state.route, Route::Direct(_)) {
                // Watchdog: after a grace period, a direct route that never saw
                // inbound (or went silent) reverts to the relay.
                let silent = state.route_since.elapsed() > DIRECT_RX_TIMEOUT
                    && state.last_rx.is_none_or(|at| at.elapsed() > DIRECT_RX_TIMEOUT);
                if silent {
                    state.route = Route::Relay;
                    state.route_since = Instant::now();
                    state.last_rx = None;
                    self.udp
                        .real_to_virtual
                        .lock()
                        .expect("r2v")
                        .retain(|_, v| *v != transmit.destination);
                }
            }
            state.route
        };
        match route {
            Route::Direct(real) => {
                // QUIC over UDP; ECN best-effort (ignored on failure). try_send_to is
                // synchronous: backpressure becomes a drop (QUIC retransmits).
                match self.udp.socket.try_send_to(transmit.contents, real) {
                    Ok(_) => Ok(()),
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(()),
                    Err(e) => Err(e),
                }
            }
            Route::Relay => {
                let ecn = transmit.ecn.map(|e| e as u8).unwrap_or(0);
                let payload = Bytes::copy_from_slice(transmit.contents);
                self.outbound
                    .send((dst, ecn, payload))
                    .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "relay client gone"))
            }
        }
    }

    fn poll_recv(
        &self,
        cx: &mut std::task::Context<'_>,
        bufs: &mut [io::IoSliceMut<'_>],
        meta: &mut [quinn_udp::RecvMeta],
    ) -> Poll<io::Result<usize>> {
        let mut inbound = self.queues.inbound.lock().expect("inbound");
        if inbound.is_empty() {
            self.queues
                .wakers
                .lock()
                .expect("wakers")
                .push(cx.waker().clone());
            return Poll::Pending;
        }
        let mut count = 0;
        for (buf, slot_meta) in bufs.iter_mut().zip(meta.iter_mut()) {
            let Some((addr, ecn, payload)) = inbound.pop_front() else { break };
            if buf.len() < payload.len() {
                inbound.push_front((addr, ecn, payload));
                break;
            }
            buf[..payload.len()].copy_from_slice(&payload);
            *slot_meta = quinn_udp::RecvMeta {
                addr,
                len: payload.len(),
                stride: payload.len(),
                ecn: quinn_udp::EcnCodepoint::from_bits(ecn),
                dst_ip: None,
            };
            count += 1;
        }
        Poll::Ready(Ok(count))
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.udp.socket.local_addr()
    }

    fn max_transmit_segments(&self) -> usize {
        1
    }

    fn may_fragment(&self) -> bool {
        false
    }
}

/// Sends never block (relay queue unbounded; UDP try_send), so the poller is always
/// ready.
#[derive(Debug)]
struct AlwaysWritable;

impl quinn::UdpPoller for AlwaysWritable {
    fn poll_writable(self: std::pin::Pin<&mut Self>, _cx: &mut std::task::Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

/// Reader task: the single consumer of the UDP socket. STUN responses resolve pending
/// probes; other datagrams are matched to a direct peer by source address and queued
/// for quinn with the peer's virtual address; strangers are dropped (doc 09-C5 demux).
pub(crate) async fn udp_reader(
    udp: Arc<UdpState>,
    note_rx: Arc<dyn Fn(SocketAddr) + Send + Sync>,
    mut stun_pending: crate::stun_probe::PendingProbes,
    stun_servers: Vec<SocketAddr>,
) {
    let mut buf = [0u8; 65_536];
    loop {
        let (len, from) = match udp.socket.recv_from(&mut buf).await {
            Ok(v) => v,
            Err(_) => continue,
        };
        let data = &buf[..len];
        if switchback_stun::is_stun_message(data) {
            let tx_id: [u8; 12] = data[8..20].try_into().expect("stun header");
            if stun_pending.complete(&tx_id, data) {
                continue;
            }
            let _ = stun_servers.contains(&from);
            continue; // unsolicited STUN: drop
        }
        let virtual_addr = udp.real_to_virtual.lock().expect("r2v").get(&from).copied();
        if let Some(virtual_addr) = virtual_addr {
            note_rx(from);
            udp.queues.push_inbound((virtual_addr, 0, data.to_vec()));
        }
        // Unknown source: never fed to QUIC.
    }
}
