//! STUN probing from the endpoint's UDP socket (docs/09-C5). The reader task is the
//! single consumer of the socket; probes register their transaction id here and the
//! reader resolves them when the response arrives.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

/// Transaction id -> waiting probe. Clone shares the same map.
#[derive(Clone)]
pub(crate) struct PendingProbes {
    inner: Arc<Mutex<HashMap<[u8; 12], tokio::sync::oneshot::Sender<switchback_stun::MappedAddress>>>>,
}

impl PendingProbes {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Register a probe; the returned receiver resolves with the mapped address.
    pub(crate) fn register(
        &self,
        tx_id: [u8; 12],
    ) -> tokio::sync::oneshot::Receiver<switchback_stun::MappedAddress> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.inner.lock().expect("probes").insert(tx_id, tx);
        rx
    }

    /// If `data` is the response to a registered probe, resolve it. Returns true when
    /// consumed (caller must not feed it to QUIC).
    pub(crate) fn complete(&mut self, tx_id: &[u8; 12], data: &[u8]) -> bool {
        let tx = self.inner.lock().expect("probes").remove(tx_id);
        let Some(tx) = tx else { return false };
        let parsed = switchback_stun::parse_binding_response(data, *tx_id);
        match parsed {
            Ok(mapped) => {
                let _ = tx.send(mapped);
            }
            Err(_) => {
                // Drop the probe; the caller's timeout handles it.
            }
        }
        true
    }
}

/// Send a Binding Request and wait for the response via the pending-probe map
/// (the reader task owns the socket's recv loop).
pub(crate) async fn bind(
    socket: &tokio::net::UdpSocket,
    server: SocketAddr,
    probes: &PendingProbes,
    timeout: std::time::Duration,
) -> Result<switchback_stun::MappedAddress, switchback_stun::BindError> {
    let mut tx_id = [0u8; 12];
    getrandom::getrandom(&mut tx_id).map_err(|e| switchback_stun::BindError::Io(e.to_string()))?;
    let rx = probes.register(tx_id);
    let request = switchback_stun::binding_request(tx_id);
    socket
        .send_to(&request, server)
        .await
        .map_err(|e| switchback_stun::BindError::Io(e.to_string()))?;
    tokio::time::timeout(timeout, rx)
        .await
        .map_err(|_| switchback_stun::BindError::Timeout)?
        .map_err(|_| switchback_stun::BindError::Timeout)
}
