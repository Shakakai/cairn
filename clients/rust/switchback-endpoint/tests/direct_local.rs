//! Live: two endpoints on one host establish a direct UDP path via in-band candidates
//! (C4) and echo; the relay path must go quiet (QuietWhenDirect, ADR-018).

use switchback_endpoint::{builder, SecretKey, SwitchbackConfig};

fn cairn_url() -> Option<String> {
    std::env::var("CAIRN_URL").ok().filter(|v| !v.is_empty())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn direct_echo_and_quiet_relay() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("switchback_endpoint=debug")
        .try_init();
    let Some(url) = cairn_url() else {
        eprintln!("CAIRN_URL not set; skipping");
        return;
    };
    let cfg = SwitchbackConfig {
        cairn_url: url.parse().unwrap(),
        stun_servers: vec![], // loopback candidates; no STUN needed
        ..Default::default()
    };

    let a = builder(&cfg).secret_key(SecretKey::from_bytes([1u8; 32])).build().await.unwrap();
    let b = builder(&cfg).secret_key(SecretKey::from_bytes([2u8; 32])).build().await.unwrap();
    a.relay().recorder().enable();
    b.relay().recorder().enable();

    let peer_b = b.local_id().clone();
    let b_accept = b.clone();
    let accept = tokio::spawn(async move {
        let (_peer, conn) = b_accept.accept().await.expect("accept");
        let (mut send, mut recv) = conn.accept_bi().await.unwrap();
        let msg = recv.read_to_end(1 << 20).await.unwrap();
        send.write_all(&msg).await.unwrap();
        send.finish().unwrap();
        conn.closed().await;
    });

    let conn = a.connect(&peer_b).await.expect("connect");
    // C4: the candidate exchange happens inside connect(); the route should be direct
    // within a second on loopback.
    let mut direct = false;
    for _ in 0..50 {
        if a.direct_connection_count() > 0 && b.direct_connection_count() > 0 {
            direct = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(direct, "direct path not established (a={}, b={})", a.direct_connection_count(), b.direct_connection_count());

    a.relay().recorder().clear();
    b.relay().recorder().clear();
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    send.write_all(b"direct hello").await.unwrap();
    send.finish().unwrap();
    let echoed = recv.read_to_end(1024).await.unwrap();
    assert_eq!(echoed, b"direct hello");
    conn.close(0u32.into(), b"done");

    // C4 acceptance (doc 09, amended by ADR-018): no relay Send frames carrying data
    // while the direct path serves the connection.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    for (label, recorder) in [("a", a.relay().recorder()), ("b", b.relay().recorder())] {
        let datagram_frames = recorder
            .frames()
            .iter()
            .filter(|f| f.outgoing && f.bytes.first() == Some(&0x02) && f.bytes.len() > 34)
            .count();
        assert_eq!(datagram_frames, 0, "relay carried data on {label}");
    }
    accept.await.unwrap();
}
