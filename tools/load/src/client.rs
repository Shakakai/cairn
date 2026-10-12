//! One lightweight load client: a raw WebSocket speaking Switchback v1
//! (switchback-proto only — no QUIC), used by `tools/load`.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::tungstenite::handshake::client::Request;

use switchback_proto::{create_auth_blob, ed25519_public_key, encode_auth_blob_b64, RelayFrame};

use crate::{Counters, Pattern, Samples};

/// One shared TLS connector: native roots load from the OS keychain exactly once
/// (per-connect loads serialize on the keychain lock and fail under concurrency).
fn shared_connector() -> &'static tokio_tungstenite::Connector {
    static CONNECTOR: std::sync::OnceLock<tokio_tungstenite::Connector> = std::sync::OnceLock::new();
    CONNECTOR.get_or_init(|| {
        let mut roots = rustls::RootCertStore::empty();
        for cert in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(cert);
        }
        let config = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(config))
    })
}

/// Connect with an optional bound source address: `--bind-source-ips N` makes client i
/// use 127.0.<i/254>.<(i%254)+1>, multiplying the per-4-tuple ephemeral-port ceiling
/// for local pool tests (loopback aliases, e.g. `ifconfig lo0 alias`).
async fn connect(
    request: tokio_tungstenite::tungstenite::handshake::client::Request,
    cairn: &str,
    id: usize,
    bind_source: bool,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Box<dyn std::error::Error + Send + Sync>,
> {
    let hostport = cairn
        .split_once("://")
        .map(|(_, rest)| rest.trim_end_matches('/').split('/').next().unwrap_or(""))
        .unwrap_or("");
    let secure = cairn.starts_with("wss://");
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().unwrap_or(if secure { 443 } else { 80 })),
        None => (hostport.to_string(), if secure { 443 } else { 80 }),
    };
    let mut addrs = tokio::net::lookup_host(format!("{host}:{port}")).await?;
    let dst = addrs
        .find(|a| a.is_ipv4())
        .or_else(|| addrs.next())
        .ok_or("no address resolved")?;
    let stream = if bind_source {
        // 127/8 is loopback-routed on macOS (no aliases needed): 127.<block>.<x>.<y>
        // gives 2 x 254 x 254 distinct source addresses.
        let rem = id % (254 * 254);
        let local = std::net::SocketAddr::new(
            std::net::IpAddr::V4(std::net::Ipv4Addr::new(
                127,
                (id / (254 * 254)) as u8,
                (rem / 254) as u8,
                ((rem % 254) + 1) as u8,
            )),
            0,
        );
        let socket = tokio::net::TcpSocket::new_v4()?;
        socket.bind(local)?;
        socket.connect(dst).await?
    } else {
        tokio::net::TcpStream::connect(dst).await?
    };
    let (ws, _) = tokio_tungstenite::client_async_tls_with_config(
        request,
        stream,
        None,
        secure.then(|| shared_connector().clone()),
    )
    .await?;
    Ok(ws)
}

fn seed_of(i: usize) -> [u8; 32] {
    let mut seed = [0u8; 32];
    seed[..8].copy_from_slice(&(i as u64 + 1).to_be_bytes());
    seed[31] = 0xa5;
    seed
}

pub(crate) struct ClientArgs {
    pub cairn: String,
    pub id: usize,
    pub deadline: Instant,
    pub pattern: Pattern,
    pub burst: usize,
    pub new_peers_per_min: u64,
    pub counters: Arc<Counters>,
    pub samples: Arc<Samples>,
    pub bind_source: bool,
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_client(
    args: ClientArgs,
) {
    let ClientArgs {
        cairn,
        id,
        deadline,
        pattern,
        burst,
        new_peers_per_min,
        counters,
        samples,
        bind_source,
    } = args;
    let connect_url = format!("{}/v1/connect", cairn.trim_end_matches('/'));
    let host = cairn
        .split_once("://")
        .map(|(_, rest)| rest.trim_end_matches('/'))
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string();
    let auth_host = match host.rsplit_once(':') {
        Some((h, _)) => h.to_lowercase(),
        None => host.to_lowercase(),
    };

    if id < 3 {
        eprintln!("client {id}: starting (cairn={cairn})");
    }
    let secret = seed_of(id);
    let endpoint = ed25519_public_key(&secret);
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).expect("rng");
    let blob = create_auth_blob(&secret, &auth_host, &endpoint, now_unix_ms(), &nonce);
    let auth = encode_auth_blob_b64(&blob);

    let mut request: Request = match connect_url.as_str().into_client_request() {
        Ok(r) => r,
        Err(_) => {
            counters.connect_errors.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        "switchback.v1".parse().expect("protocol"),
    );
    request
        .headers_mut()
        .insert("Switchback-Auth", auth.parse().expect("auth"));

    if id < 3 {
        eprintln!("client {id}: connecting to {connect_url}");
    }
    let ws = match connect(request, cairn.as_str(), id, bind_source).await {
        Ok(v) => v,
        Err(e) => {
            if id < 30 {
                eprintln!("client {id} connect error: {e}");
            }
            counters.rejected.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };
    counters.connected.fetch_add(1, Ordering::Relaxed);
    let (mut tx, mut rx) = ws.split();

    // Reader task: count frames, sample relay latency (timestamp in payload), and
    // echo back when this client is the even/odd peer of a pair (real endpoints).
    let read_counters = counters.clone();
    let (echo_tx, echo_rx_shared) = {
        let (etx, erx) = tokio::sync::mpsc::unbounded_channel::<Message>();
        (etx, erx)
    };
    let reader = tokio::spawn(async move {
        while let Some(msg) = rx.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    read_counters.frames_recv.fetch_add(1, Ordering::Relaxed);
                    if let Ok(RelayFrame::Recv { src, datagram, .. }) =
                        switchback_proto::decode_relay_frame(&data)
                    {
                        if datagram.len() >= 8 {
                            let sent = u64::from_be_bytes(datagram[..8].try_into().unwrap());
                            let now = now_unix_ms();
                            if now >= sent {
                                samples.record((now - sent) as f64);
                            }
                        }
                        // Odd clients echo back to their even partner (real path).
                        if id % 2 == 1 {
                            let frame = send_frame(&src, &datagram);
                            read_counters.bytes_sent.fetch_add(frame.len() as u64, Ordering::Relaxed);
                            if echo_tx.send(Message::Binary(frame.into())).is_ok() {
                                read_counters.frames_sent.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                _ => {}
            }
        }
    });

    // Writer: pattern traffic.
    let mut ticker = tokio::time::interval(Duration::from_secs(30)); // ADR-016 self-keepalive cadence
    ticker.tick().await;
    let start = Instant::now();
    let mut peer_counter: u64 = 0;
    let mut sent: u64 = 0;
    let mut echo_rx = echo_rx_shared;
    loop {
        tokio::select! {
            Some(echo) = echo_rx.recv() => {
                if tx.send(echo).await.is_err() {
                    counters.send_errors.fetch_add(1, Ordering::Relaxed);
                    break;
                }
            }
            _ = ticker.tick() => {
                // Quiet-keepalive: empty datagram to self (matches the real client).
                let frame = send_frame(&endpoint, &[]);
                if tx.send(Message::Binary(frame.into())).await.is_err() {
                    counters.send_errors.fetch_add(1, Ordering::Relaxed);
                    break;
                }
                counters.frames_sent.fetch_add(1, Ordering::Relaxed);
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if Instant::now() >= deadline {
                    break;
                }
                match pattern {
                    Pattern::Idle => {}
                    Pattern::Pairs => {
                        // New destinations at the configured rate; a burst per new peer.
                        if new_peers_per_min > 0 {
                            if !id.is_multiple_of(2) {
                                tokio::time::sleep(Duration::from_millis(100)).await;
                                continue;
                            }
                            let due = start.elapsed().as_secs_f64() * new_peers_per_min as f64 / 60.0;
                            while (peer_counter as f64) < due {
                                peer_counter += 1;
                                // Fresh (mostly offline) destinations: new-peer cost.
                                let peer = ed25519_public_key(&peer_seed(id, peer_counter));
                                for _b in 0..burst.max(1) {
                                    let payload = stamped_payload(sent);
                                    sent += 1;
                                    let frame = send_frame(&peer, &payload);
                                    counters.bytes_sent.fetch_add(frame.len() as u64, Ordering::Relaxed);
                                    if tx.send(Message::Binary(frame.into())).await.is_err() {
                                        counters.send_errors.fetch_add(1, Ordering::Relaxed);
                                        break;
                                    }
                                    counters.frames_sent.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        }
                    }
                    Pattern::Stream => {
                        // Even clients stream to their odd partner (a real endpoint).
                        if !id.is_multiple_of(2) {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            continue;
                        }
                        let payload = stamped_payload(sent);
                        let frame = send_frame(&ed25519_public_key(&seed_of(id | 1)), &payload);
                        counters.bytes_sent.fetch_add(frame.len() as u64, Ordering::Relaxed);
                        if tx.send(Message::Binary(frame.into())).await.is_err() {
                            counters.send_errors.fetch_add(1, Ordering::Relaxed);
                            break;
                        }
                        counters.frames_sent.fetch_add(1, Ordering::Relaxed);
                        sent += 1;
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }
            }
        }
    }

    let _ = tx.send(Message::Close(None)).await;
    drop(tx);
    if reader.await.is_ok() {
        // A clean close at the deadline is expected; count mid-run drops elsewhere.
    }
}

fn peer_seed(id: usize, n: u64) -> [u8; 32] {
    let mut seed = [0u8; 32];
    seed[..8].copy_from_slice(&n.to_be_bytes());
    seed[8..16].copy_from_slice(&(id as u64).to_be_bytes());
    seed[31] = 0x5c;
    seed
}

fn stamped_payload(seq: u64) -> Vec<u8> {
    let mut p = now_unix_ms().to_be_bytes().to_vec();
    p.extend_from_slice(&seq.to_be_bytes());
    p
}

fn send_frame(dst: &[u8; 32], payload: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(34 + payload.len());
    f.push(0x02);
    f.extend_from_slice(dst);
    f.push(0);
    f.extend_from_slice(payload);
    f
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
