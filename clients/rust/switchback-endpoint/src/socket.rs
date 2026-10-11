//! [`RelaySocket`] — quinn's UDP socket abstraction (ADR-013) over the Switchback v1 relay
//! client. Outgoing QUIC packets become `Send` frames addressed by peer EndpointId;
//! incoming `Recv` frames become datagrams from the deterministic peer address.

use std::fmt::Debug;
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use bytes::Bytes;

pub use crate::relay_client::SocketQueues;
use crate::relay_client::EndpointKeyBytes;

/// Deterministic peer address in the reserved 240.0.0.0/4 space (ADR-013), derived from
/// the peer's EndpointId so both sides agree without coordination.
pub(crate) fn peer_addr(id: &EndpointKeyBytes) -> SocketAddr {
    let digest = switchback_proto::blake3_derive_key("switchback v1 peer addr", id);
    SocketAddr::V4(SocketAddrV4::new(
        Ipv4Addr::new(240 | (digest[0] & 0x0f), digest[1], digest[2], digest[3]),
        443,
    ))
}

/// The local (virtual) address of a relay-only socket.
pub(crate) fn local_addr() -> SocketAddr {
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(240, 0, 0, 0), 443))
}

/// Shared between the relay actor and this socket.
struct SocketState {
    queues: Arc<SocketQueues>,
    outbound: tokio::sync::mpsc::UnboundedSender<(EndpointKeyBytes, u8, Bytes)>,
}

/// quinn `AsyncUdpSocket` over the relay. Sends are queued immediately (the relay client
/// applies its own pacing); receives copy queued datagrams into quinn's buffers.
pub(crate) struct RelaySocket {
    state: Arc<SocketState>,
}

impl Debug for RelaySocket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelaySocket").finish_non_exhaustive()
    }
}

impl RelaySocket {
    pub(crate) fn new(
        queues: Arc<SocketQueues>,
        outbound: tokio::sync::mpsc::UnboundedSender<(EndpointKeyBytes, u8, Bytes)>,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Arc::new(SocketState { queues, outbound }),
        })
    }
}

impl quinn::AsyncUdpSocket for RelaySocket {
    fn create_io_poller(self: Arc<Self>) -> std::pin::Pin<Box<dyn quinn::UdpPoller>> {
        Box::pin(AlwaysWritable)
    }

    fn try_send(&self, transmit: &quinn_udp::Transmit<'_>) -> io::Result<()> {
        let Some(dst) = self.state.queues.peer_key(&transmit.destination) else {
            // quinn can emit transmits for addresses we never registered (path
            // validation probes): drop them, the relay has no route anyway.
            return Ok(());
        };
        let ecn = transmit.ecn.map(|e| e as u8).unwrap_or(0);
        let payload = Bytes::copy_from_slice(transmit.contents);
        self.state
            .outbound
            .send((dst, ecn, payload))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "relay client gone"))
    }

    fn poll_recv(
        &self,
        cx: &mut Context<'_>,
        bufs: &mut [io::IoSliceMut<'_>],
        meta: &mut [quinn_udp::RecvMeta],
    ) -> Poll<io::Result<usize>> {
        let mut inbound = self.state.queues.inbound.lock().expect("inbound");
        if inbound.is_empty() {
            self.state
                .queues
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
        Ok(local_addr())
    }

    fn max_transmit_segments(&self) -> usize {
        1
    }

    fn may_fragment(&self) -> bool {
        false
    }
}

/// Sends never block (unbounded queue to the relay actor), so the writable poller is
/// always ready.
#[derive(Debug)]
struct AlwaysWritable;

impl quinn::UdpPoller for AlwaysWritable {
    fn poll_writable(self: std::pin::Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

#[allow(dead_code)]
fn _assert_waker_send(_: Waker) {}
