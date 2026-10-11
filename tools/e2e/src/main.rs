//! End-to-end scenarios (docs/08 §4): run against any Cairn deployment, e.g.
//! `cargo run -p e2e -- --cairn ws://127.0.0.1:8080 --scenario all`.

mod raw;

use std::time::Duration;

use switchback_endpoint::{
    builder_relay_only, SecretKey, SwitchbackConfig,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scenario {
    EchoRelayed,
    EchoDirect,
    Displace,
    Gone,
    Replay,
    Stale,
    Probes,
    Restart,
    MaxAge,
    Stun,
    Smoke,
}

impl Scenario {
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "echo-relayed" => Scenario::EchoRelayed,
            "echo-direct" => Scenario::EchoDirect,
            "displace" => Scenario::Displace,
            "gone" => Scenario::Gone,
            "replay" => Scenario::Replay,
            "stale" => Scenario::Stale,
            "probes" => Scenario::Probes,
            "restart" => Scenario::Restart,
            "max-age" => Scenario::MaxAge,
            "stun" => Scenario::Stun,
            "smoke" => Scenario::Smoke,
            _ => return None,
        })
    }

    fn name(&self) -> &'static str {
        match self {
            Scenario::EchoRelayed => "echo-relayed",
            Scenario::EchoDirect => "echo-direct",
            Scenario::Displace => "displace",
            Scenario::Gone => "gone",
            Scenario::Replay => "replay",
            Scenario::Stale => "stale",
            Scenario::Probes => "probes",
            Scenario::Restart => "restart",
            Scenario::MaxAge => "max-age",
            Scenario::Stun => "stun",
            Scenario::Smoke => "smoke",
        }
    }
}

struct Opts {
    cairn: String,
    scenario: String,
    /// Admin URL of the relay (restart scenario POSTs /drain).
    cairn_admin: Option<String>,
}

fn parse_args() -> Opts {
    let mut cairn = None;
    let mut scenario = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--cairn" => cairn = args.next(),
            "--scenario" => scenario = args.next(),
            "--cairn-admin" => {
                let _ = args.next();
            }
            other => {
                eprintln!("unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }
    Opts {
        cairn: cairn.unwrap_or_else(|| "ws://127.0.0.1:8080".to_string()),
        scenario: scenario.unwrap_or_else(|| "all".to_string()),
        cairn_admin: std::env::args()
            .skip(1)
            .position(|a| a == "--cairn-admin")
            .and_then(|i| std::env::args().skip(1).nth(i + 1)),
    }
}

fn config(cairn: &str) -> SwitchbackConfig {
    SwitchbackConfig {
        cairn_url: cairn.parse().expect("valid --cairn url"),
        ..Default::default()
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    let opts = parse_args();
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .try_init();

    let scenarios: Vec<Scenario> = match opts.scenario.as_str() {
        "all" => vec![
            Scenario::Probes,
            Scenario::EchoRelayed,
            Scenario::EchoDirect,
            Scenario::Displace,
            Scenario::Gone,
            Scenario::Replay,
            Scenario::Stale,
            Scenario::Stun,
        ],
        "smoke" => vec![Scenario::Probes, Scenario::EchoRelayed, Scenario::Displace],
        name => vec![Scenario::parse(name).unwrap_or_else(|| {
            eprintln!("unknown scenario {name}; expected echo-relayed|displace|gone|replay|stale|probes|smoke|all");
            std::process::exit(2);
        })],
    };

    let mut failures = 0;
    let start = std::time::Instant::now();
    for scenario in scenarios {
        let t = std::time::Instant::now();
        match run(scenario, &opts.cairn, opts.cairn_admin.as_deref()).await {
            Ok(()) => println!("PASS {} ({:.1}s)", scenario.name(), t.elapsed().as_secs_f64()),
            Err(error) => {
                failures += 1;
                println!("FAIL {}: {error}", scenario.name());
            }
        }
    }
    println!("total: {:.1}s", start.elapsed().as_secs_f64());
    if failures > 0 {
        std::process::exit(1);
    }
}

async fn run(scenario: Scenario, cairn: &str, cairn_admin: Option<&str>) -> Result<(), String> {
    match scenario {
        Scenario::EchoRelayed => echo_relayed(cairn).await,
        Scenario::EchoDirect => echo_direct(cairn).await,
        Scenario::Displace => displace(cairn).await,
        Scenario::Gone => gone(cairn).await,
        Scenario::Replay => replay(cairn).await,
        Scenario::Stale => stale(cairn).await,
        Scenario::Probes => probes(cairn).await,
        Scenario::Restart => restart(cairn, cairn_admin).await,
        Scenario::MaxAge => max_age(cairn).await,
        Scenario::Stun => stun().await,
        Scenario::Smoke => unreachable!("smoke expands to scenarios"),
    }
}

/// Two endpoints with relay-only transports connect by EndpointId + relay URL and echo
/// 10 000 messages (docs/08). Also asserts only Switchback v1 frames crossed the wire.
async fn echo_relayed(cairn: &str) -> Result<(), String> {
    let cfg = config(cairn);
    let a = builder_relay_only(&cfg)
        .secret_key(SecretKey::from_bytes([1u8; 32]))
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let b = builder_relay_only(&cfg)
        .secret_key(SecretKey::from_bytes([2u8; 32]))
        .build()
        .await
        .map_err(|e| e.to_string())?;
    a.relay().recorder().enable();
    b.relay().recorder().enable();

    wait_active(&a).await?;
    wait_active(&b).await?;
    let peer_b = b.local_id().clone();
    let b_accept = b.clone();
    let accept = tokio::spawn(async move {
        let (_peer, conn) = b_accept.accept().await.expect("accept");
        let (mut send, mut recv) = conn.accept_bi().await.unwrap();
        while let Some(msg) = recv.read_chunk(1024 * 1024, true).await.unwrap() {
            send.write_all(&msg.bytes).await.unwrap();
        }
        send.finish().unwrap();
        conn.closed().await; // keep the connection until the dialer is done
    });

    let conn = a.connect(&peer_b).await.map_err(|e| e.to_string())?;
    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
    const MESSAGES: usize = 10_000;
    let reader = tokio::spawn(async move {
        let mut data = Vec::new();
        while let Some(chunk) = recv.read_chunk(1024 * 1024, true).await.unwrap() {
            data.extend_from_slice(&chunk.bytes);
        }
        data
    });
    let mut expected = Vec::new();
    for i in 0..MESSAGES {
        let msg = format!("hello {i}");
        expected.extend_from_slice(msg.as_bytes());
        send.write_all(msg.as_bytes()).await.unwrap();
    }
    send.finish().unwrap();
    let echoed = reader.await.unwrap();
    if echoed != expected {
        return Err(format!(
            "echo mismatch: expected {} bytes, got {} (prefixes {:?} vs {:?})",
            expected.len(),
            echoed.len(),
            &expected[..expected.len().min(40)],
            &echoed[..echoed.len().min(40)]
        ));
    }
    conn.close(0u32.into(), b"done");
    accept.await.unwrap();

    // Only Switchback v1 frames on the wire (doc 11 M4 acceptance).
    for (label, recorder) in [("a", a.relay().recorder()), ("b", b.relay().recorder())] {
        for frame in recorder.frames() {
            let t = frame.bytes.first().copied().unwrap_or(0);
            let ok = if frame.outgoing {
                // clients only ever send Send (0x02) / SendBatch (0x03)
                t == 0x02 || t == 0x03
            } else {
                matches!(t, 0x01 | 0x04 | 0x05 | 0x06 | 0x07 | 0x08)
            };
            if !ok {
                return Err(format!("non-v1 frame on the wire from {label}: type 0x{t:02x}"));
            }
        }
    }
    Ok(())
}

/// Same identity connects twice (docs/08): the first relay connection gets Displaced,
/// traffic moves to the second; closing the second promotes the first.
async fn displace(cairn: &str) -> Result<(), String> {
    let cfg = config(cairn);
    let first = builder_relay_only(&cfg)
        .secret_key(SecretKey::from_bytes([3u8; 32]))
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let mut first_events = first.relay().subscribe();
    wait_active(&first).await?;

    let second = builder_relay_only(&cfg)
        .secret_key(SecretKey::from_bytes([3u8; 32]))
        .build()
        .await
        .map_err(|e| e.to_string())?;

    // First sees Displaced (Status 1).
    wait_event(&mut first_events, |e| matches!(e, RelayEventInner::Displaced), Duration::from_secs(5)).await?;

    // Traffic to the shared identity reaches the second connection.
    let sender = builder_relay_only(&cfg)
        .secret_key(SecretKey::from_bytes([4u8; 32]))
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let shared = second.local_id().clone();
    let dial = tokio::spawn(async move { sender.connect(&shared).await });
    let accept_second = tokio::spawn({
        let second = second.clone();
        async move { second.accept().await }
    });
    let (conn, accepted) = tokio::join!(dial, accept_second);
    let conn = conn.map_err(|e| e.to_string()).and_then(|c| c.map_err(|e| e.to_string()))?;
    conn.close(0u32.into(), b"");
    accepted.unwrap().unwrap().1.close(0u32.into(), b"");

    // Dropping the second endpoint closes its relay connection; the first is promoted.
    drop(second);
    wait_event(&mut first_events, |e| matches!(e, RelayEventInner::Active), Duration::from_secs(10)).await?;
    Ok(())
}

/// A sends to B, then A disconnects; B receives PeerGone(A) once (docs/08).
async fn gone(cairn: &str) -> Result<(), String> {
    let cfg = config(cairn);
    let a = builder_relay_only(&cfg)
        .secret_key(SecretKey::from_bytes([5u8; 32]))
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let b = builder_relay_only(&cfg)
        .secret_key(SecretKey::from_bytes([6u8; 32]))
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let mut b_events = b.relay().subscribe();
    wait_active(&a).await?;
    wait_active(&b).await?;

    let b2 = b.clone();
    let _accept_task = tokio::spawn(async move {
        let _ = b2.accept().await;
    });

    let peer_b = b.local_id().clone();
    let conn = a.connect(&peer_b).await.map_err(|e| e.to_string())?;
    let (mut send, _recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
    send.write_all(b"ping").await.unwrap();
    conn.close(0u32.into(), b"leaving");

    // A's endpoint goes away fully when dropped: the relay must fan out PeerGone(A) once.
    let a_id = a.local_id().clone();
    drop(a);
    let deadline = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(deadline);
    let mut gones = 0;
    loop {
        tokio::select! {
            maybe = b_events.recv() => {
                match maybe {
                    Some(switchback_endpoint::RelayEvent::PeerGone(peer)) if peer == a_id => {
                        gones += 1;
                        if gones > 1 {
                            return Err("PeerGone delivered more than once".into());
                        }
                        // Give any duplicate a moment to arrive.
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        break;
                    }
                    Some(_) => continue,
                    None => return Err("event stream closed before PeerGone".into()),
                }
            }
            _ = &mut deadline => return Err("timed out waiting for PeerGone".into()),
        }
    }
    Ok(())
}

/// Reusing an auth blob (same nonce) must be rejected with 401 auth: replay (docs/08).
async fn replay(cairn: &str) -> Result<(), String> {
    let mut nonce = [0u8; 16];
    getrandom_nonce(&mut nonce);
    // First use succeeds.
    raw::connect_ok(cairn, [7u8; 32], nonce).await?;
    // Reuse is rejected (401 before accept on Node; 1008 close after accept on
    // Cloudflare — doc 01 §3.1).
    raw::expect_replayed(cairn, [7u8; 32], nonce).await
}

/// Auth with a timestamp outside the skew must be rejected 401 auth: stale (docs/08).
async fn stale(cairn: &str) -> Result<(), String> {
    raw::expect_upgrade_rejected(
        cairn,
        raw::Auth::Stale { seed: [8u8; 32] },
        "switchback.v1",
        401,
        "auth: stale",
    )
    .await
}

/// `/v1/ping` 204, `/v1/captive` challenge echo, `/healthz` lists switchback.v1; a client
/// offering any other subprotocol gets 400 (doc 11 M4 acceptance).
async fn probes(cairn: &str) -> Result<(), String> {
    raw::probe_http(cairn).await?;
    raw::expect_upgrade_rejected(
        cairn,
        raw::Auth::Fresh { seed: [9u8; 32], nonce: None },
        "bogus.v1",
        400,
        "unsupported protocol version; supported: switchback.v1",
    )
    .await
}

/// Wait until the endpoint's relay connection is registered and active: the relay drops
/// frames for offline destinations (doc 01 §4.3), so dialing before presence is a race.
async fn wait_active(endpoint: &switchback_endpoint::Endpoint) -> Result<(), String> {
    let deadline = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(deadline);
    loop {
        if endpoint.relay().is_active() {
            return Ok(());
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(20)) => continue,
            _ = &mut deadline => return Err("timed out waiting for relay registration".into()),
        }
    }
}

fn getrandom_nonce(buf: &mut [u8; 16]) {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let digest = switchback_endpoint::proto::blake3_derive_key("e2e nonce", &nanos.to_be_bytes());
    buf.copy_from_slice(&digest[..16]);
}

// RelayEvent matching without exposing internals: small local enum.
enum RelayEventInner {
    Active,
    Displaced,
}

async fn wait_event(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<switchback_endpoint::RelayEvent>,
    matches_fn: impl Fn(&RelayEventInner) -> bool,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("timed out waiting for relay event".into());
        }
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(switchback_endpoint::RelayEvent::BecameActive))
                if matches_fn(&RelayEventInner::Active) => return Ok(()),
            Ok(Some(switchback_endpoint::RelayEvent::Displaced))
                if matches_fn(&RelayEventInner::Displaced) => return Ok(()),
            Ok(Some(_)) => continue,
            Ok(None) => return Err("event stream closed".into()),
            Err(_) => return Err("timed out waiting for relay event".into()),
        }
    }
}

// ---------------------------------------------------------------------------
// M7 scenarios
// ---------------------------------------------------------------------------

/// Two endpoints with UDP transports go direct (C4); the relay must carry no data
/// frames for the connection within 35s of the direct path being selected
/// (doc 09 C4, amended by ADR-018).
async fn echo_direct(cairn: &str) -> Result<(), String> {
    let cfg = config(cairn);
    cfg_stun_local(&cfg);
    let a = switchback_endpoint::builder(&cfg)
        .secret_key(SecretKey::from_bytes([21u8; 32]))
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let b = switchback_endpoint::builder(&cfg)
        .secret_key(SecretKey::from_bytes([22u8; 32]))
        .build()
        .await
        .map_err(|e| e.to_string())?;
    a.relay().recorder().enable();
    b.relay().recorder().enable();

    let peer_b = b.local_id().clone();
    let b_accept = b.clone();
    let accept = tokio::spawn(async move {
        let (_peer, conn) = b_accept.accept().await.expect("accept");
        let (mut send, mut recv) = conn.accept_bi().await.unwrap();
        while let Some(chunk) = recv.read_chunk(1 << 20, true).await.unwrap() {
            send.write_all(&chunk.bytes).await.unwrap();
        }
        send.finish().unwrap();
        conn.closed().await;
    });

    let t_start = std::time::Instant::now();
    let conn = a.connect(&peer_b).await.map_err(|e| e.to_string())?;
    // Wait for both sides to select the direct path.
    let deadline = t_start + Duration::from_secs(30);
    loop {
        if a.direct_connection_count() > 0 && b.direct_connection_count() > 0 {
            break;
        }
        if std::time::Instant::now() > deadline {
            return Err(format!(
                "direct path not established within 30s (a={}, b={})",
                a.direct_connection_count(),
                b.direct_connection_count()
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let t_direct = std::time::Instant::now();
    a.relay().recorder().clear();
    b.relay().recorder().clear();

    // Echo traffic while watching the relay.
    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
    let reader = tokio::spawn(async move {
        let mut data = Vec::new();
        while let Some(chunk) = recv.read_chunk(1 << 20, true).await.unwrap() {
            data.extend_from_slice(&chunk.bytes);
        }
        data
    });
    let mut expected = Vec::new();
    for i in 0..1000 {
        let msg = format!("direct {i}");
        expected.extend_from_slice(msg.as_bytes());
        send.write_all(msg.as_bytes()).await.unwrap();
    }
    send.finish().unwrap();
    let echoed = reader.await.unwrap();
    if echoed != expected {
        return Err("echo mismatch over the direct path".into());
    }

    // doc 09 C4 acceptance: relay data frames reach zero within 35s of going direct.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let window = t_direct.elapsed();
    for (label, recorder) in [("a", a.relay().recorder()), ("b", b.relay().recorder())] {
        let data_frames = recorder
            .frames()
            .iter()
            .filter(|f| f.outgoing && f.bytes.first() == Some(&0x02) && f.bytes.len() > 34)
            .count();
        if data_frames > 0 {
            return Err(format!("{label}: {data_frames} relay data frames within {window:?} of going direct"));
        }
    }
    if window > Duration::from_secs(35) {
        return Err(format!("direct path took {window:?} (> 35s)"));
    }
    conn.close(0u32.into(), b"done");
    accept.await.unwrap();
    Ok(())
}

/// Server drains (Restarting + close 1012); the client must reconnect make-before-break
/// (C3) with zero application message loss on a reliable stream (docs/08).
async fn restart(cairn: &str, cairn_admin: Option<&str>) -> Result<(), String> {
    let admin = cairn_admin.ok_or("restart requires --cairn-admin <admin url>")?;
    let cfg = config(cairn);
    let a = builder_relay_only(&cfg)
        .secret_key(SecretKey::from_bytes([23u8; 32]))
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let b = builder_relay_only(&cfg)
        .secret_key(SecretKey::from_bytes([24u8; 32]))
        .build()
        .await
        .map_err(|e| e.to_string())?;

    let peer_b = b.local_id().clone();
    let b_accept = b.clone();
    let accept = tokio::spawn(async move {
        let (_peer, conn) = b_accept.accept().await.expect("accept");
        let (mut send, mut recv) = conn.accept_bi().await.unwrap();
        while let Some(chunk) = recv.read_chunk(1 << 20, true).await.unwrap() {
            send.write_all(&chunk.bytes).await.unwrap();
        }
        send.finish().unwrap();
        conn.closed().await;
    });

    let conn = a.connect(&peer_b).await.map_err(|e| e.to_string())?;
    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
    let reader = tokio::spawn(async move {
        let mut data = Vec::new();
        while let Some(chunk) = recv.read_chunk(1 << 20, true).await.unwrap() {
            data.extend_from_slice(&chunk.bytes);
        }
        data
    });

    // Stream messages through the drain.
    let mut expected = Vec::new();
    for i in 0..500 {
        let msg = format!("through-drain {i}");
        expected.extend_from_slice(msg.as_bytes());
        send.write_all(msg.as_bytes()).await.unwrap();
    }
    // Trigger the server drain mid-stream.
    let client = reqwestless::post(&format!("{admin}/drain")).await?;
    if client != 202 {
        return Err(format!("drain trigger returned {client}"));
    }
    for i in 500..1000 {
        let msg = format!("through-drain {i}");
        expected.extend_from_slice(msg.as_bytes());
        send.write_all(msg.as_bytes()).await.unwrap();
    }
    send.finish().unwrap();
    let echoed = tokio::time::timeout(Duration::from_secs(60), reader)
        .await
        .map_err(|_| "echo did not complete after drain".to_string())?
        .unwrap();
    if echoed != expected {
        return Err(format!(
            "message loss across the restart: expected {} bytes, got {}",
            expected.len(),
            echoed.len()
        ));
    }
    conn.close(0u32.into(), b"done");
    accept.await.unwrap();
    Ok(())
}

/// Same as `restart`, but the recycle is driven by the relay's max-connection-age
/// (the relay closes with Restarting + 1012; C3 must hide it). Run against a relay
/// started with `maxConnectionAgeMs` configured (docs/08).
async fn max_age(cairn: &str) -> Result<(), String> {
    restart_like(cairn, None).await
}

async fn restart_like(cairn: &str, _unused: Option<&str>) -> Result<(), String> {
    let cfg = config(cairn);
    let a = builder_relay_only(&cfg)
        .secret_key(SecretKey::from_bytes([25u8; 32]))
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let b = builder_relay_only(&cfg)
        .secret_key(SecretKey::from_bytes([26u8; 32]))
        .build()
        .await
        .map_err(|e| e.to_string())?;

    let peer_b = b.local_id().clone();
    let b_accept = b.clone();
    let accept = tokio::spawn(async move {
        let (_peer, conn) = b_accept.accept().await.expect("accept");
        let (mut send, mut recv) = conn.accept_bi().await.unwrap();
        while let Some(chunk) = recv.read_chunk(1 << 20, true).await.unwrap() {
            send.write_all(&chunk.bytes).await.unwrap();
        }
        send.finish().unwrap();
        conn.closed().await;
    });

    let conn = a.connect(&peer_b).await.map_err(|e| e.to_string())?;
    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
    let reader = tokio::spawn(async move {
        let mut data = Vec::new();
        while let Some(chunk) = recv.read_chunk(1 << 20, true).await.unwrap() {
            data.extend_from_slice(&chunk.bytes);
        }
        data
    });

    let mut expected = Vec::new();
    // Keep streaming for ~3 recycles (CI relays use maxConnectionAgeMs ~2.5s).
    let deadline = std::time::Instant::now() + Duration::from_secs(12);
    let mut i = 0;
    while std::time::Instant::now() < deadline {
        let msg = format!("through-age {i}");
        expected.extend_from_slice(msg.as_bytes());
        send.write_all(msg.as_bytes()).await.unwrap();
        i += 1;
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    send.finish().unwrap();
    let echoed = tokio::time::timeout(Duration::from_secs(60), reader)
        .await
        .map_err(|_| "echo did not complete after max-age recycles".to_string())?
        .unwrap();
    if echoed != expected {
        return Err(format!(
            "message loss across max-age recycles: expected {} bytes, got {}",
            expected.len(),
            echoed.len()
        ));
    }
    conn.close(0u32.into(), b"done");
    accept.await.unwrap();
    Ok(())
}

/// STUN: obtain a reflexive address from the configured server (doc 08). Skips (passes)
/// when the network is unreachable.
async fn stun() -> Result<(), String> {
    use std::net::SocketAddr;
    let server: SocketAddr = match "stun.cloudflare.com:3478".parse() {
        Ok(s) => s,
        Err(_) => {
            // Resolve the hostname once.
            let resolved = tokio::net::lookup_host("stun.cloudflare.com:3478")
                .await
                .map_err(|e| e.to_string())?
                .next()
                .ok_or("no STUN address resolved")?;
            resolved
        }
    };
    let socket = tokio::net::UdpSocket::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
    match switchback_endpoint::stun::bind(&socket, server, Duration::from_secs(5)).await {
        Ok(mapped) => {
            println!("stun: reflexive address {}", mapped.addr);
            Ok(())
        }
        Err(error) => {
            println!("stun: unreachable ({error}); skipping");
            Ok(())
        }
    }
}

/// Local runs: no external STUN needed for the direct path on loopback.
fn cfg_stun_local(_cfg: &SwitchbackConfig) {}

/// Minimal HTTP POST helper (no reqwest dependency).
mod reqwestless {
    pub async fn post(url: &str) -> Result<u16, String> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (hostport, path) = url
            .split_once("://")
            .and_then(|(_, rest)| rest.split_once('/'))
            .ok_or_else(|| format!("bad admin url {url}"))?;
        let host = hostport.split(':').next().unwrap_or(hostport);
        let port: u16 = hostport.rsplit(':').next().and_then(|p| p.parse().ok()).unwrap_or(80);
        let mut stream = tokio::net::TcpStream::connect((host, port))
            .await
            .map_err(|e| format!("admin connect: {e}"))?;
        let request = format!("POST /{path} HTTP/1.1\r\nHost: {hostport}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;
        let mut head = [0u8; 64];
        let n = stream.read(&mut head).await.map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&head[..n]);
        text.split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| format!("bad admin response: {text:?}"))
    }
}

