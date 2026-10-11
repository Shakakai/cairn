//! Live smoke: two endpoints echo through a local Cairn (started by the test harness via
//! the `e2e`-style env var CAIRN_URL). Skipped when no relay is configured.

use switchback_endpoint::{builder_relay_only, SecretKey, SwitchbackConfig};

fn cairn_url() -> Option<String> {
    std::env::var("CAIRN_URL").ok().filter(|v| !v.is_empty())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn echo_over_relay() {
    let _ = tracing_subscriber::fmt().with_env_filter("switchback_endpoint=debug").try_init();
    let Some(url) = cairn_url() else {
        eprintln!("CAIRN_URL not set; skipping live echo test");
        return;
    };
    let mut cfg = SwitchbackConfig {
        cairn_url: url.parse().unwrap(),
        ..Default::default()
    };
    cfg.cairn_url = url.parse().unwrap();

    let a = builder_relay_only(&cfg)
        .secret_key(SecretKey::from_bytes([1u8; 32]))
        .build()
        .await
        .unwrap();
    let b = builder_relay_only(&cfg)
        .secret_key(SecretKey::from_bytes([2u8; 32]))
        .build()
        .await
        .unwrap();

    let peer_b = b.local_id().clone();
    let accept = tokio::spawn(async move {
        let (peer, conn) = b.accept().await.expect("accept");
        assert_eq!(peer, switchback_endpoint::proto::endpoint_id_from_bytes(&switchback_endpoint::proto::ed25519_public_key(&[1u8; 32])));
        let (mut send, mut recv) = conn.accept_bi().await.unwrap();
        let msg = recv.read_to_end(1024).await.unwrap();
        send.write_all(&msg).await.unwrap();
        send.finish().unwrap();
        // Stay alive until the dialer is done reading: dropping the connection now would
        // send CONNECTION_CLOSE and the peer may discard in-flight stream data.
        conn.closed().await;
    });

    let conn = a.connect(&peer_b).await.expect("connect");
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    send.write_all(b"hello switchback").await.unwrap();
    send.finish().unwrap();
    let echoed = recv.read_to_end(1024).await.unwrap();
    assert_eq!(echoed, b"hello switchback");
    conn.close(0u32.into(), b"done");
    accept.await.unwrap();
}
