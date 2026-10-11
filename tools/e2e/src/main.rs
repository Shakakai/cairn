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
    Displace,
    Gone,
    Replay,
    Stale,
    Probes,
    Smoke,
}

impl Scenario {
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "echo-relayed" => Scenario::EchoRelayed,
            "displace" => Scenario::Displace,
            "gone" => Scenario::Gone,
            "replay" => Scenario::Replay,
            "stale" => Scenario::Stale,
            "probes" => Scenario::Probes,
            "smoke" => Scenario::Smoke,
            _ => return None,
        })
    }

    fn name(&self) -> &'static str {
        match self {
            Scenario::EchoRelayed => "echo-relayed",
            Scenario::Displace => "displace",
            Scenario::Gone => "gone",
            Scenario::Replay => "replay",
            Scenario::Stale => "stale",
            Scenario::Probes => "probes",
            Scenario::Smoke => "smoke",
        }
    }
}

struct Opts {
    cairn: String,
    scenario: String,
}

fn parse_args() -> Opts {
    let mut cairn = None;
    let mut scenario = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--cairn" => cairn = args.next(),
            "--scenario" => scenario = args.next(),
            other => {
                eprintln!("unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }
    Opts {
        cairn: cairn.unwrap_or_else(|| "ws://127.0.0.1:8080".to_string()),
        scenario: scenario.unwrap_or_else(|| "all".to_string()),
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
            Scenario::Displace,
            Scenario::Gone,
            Scenario::Replay,
            Scenario::Stale,
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
        match run(scenario, &opts.cairn).await {
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

async fn run(scenario: Scenario, cairn: &str) -> Result<(), String> {
    match scenario {
        Scenario::EchoRelayed => echo_relayed(cairn).await,
        Scenario::Displace => displace(cairn).await,
        Scenario::Gone => gone(cairn).await,
        Scenario::Replay => replay(cairn).await,
        Scenario::Stale => stale(cairn).await,
        Scenario::Probes => probes(cairn).await,
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
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            maybe = rx.recv() => match maybe {
                Some(switchback_endpoint::RelayEvent::BecameActive) if matches_fn(&RelayEventInner::Active) => return Ok(()),
                Some(switchback_endpoint::RelayEvent::Displaced) if matches_fn(&RelayEventInner::Displaced) => return Ok(()),
                Some(_) => continue,
                None => return Err("event stream closed".into()),
            },
            _ = &mut deadline => return Err("timed out waiting for relay event".into()),
        }
    }
}
