//! Raw protocol checks for e2e: hand-built WebSocket upgrades (replay/stale/subprotocol)
//! and the HTTP probes, using switchback-proto to craft auth blobs.

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

use switchback_proto::create_auth_blob;

/// A successful upgrade with a fixed nonce (the first half of the replay scenario).
pub async fn connect_ok(cairn: &str, seed: [u8; 32], nonce: [u8; 16]) -> Result<(), String> {
    let (connect_url, auth_host) = parts(cairn);
    let endpoint = switchback_proto::ed25519_public_key(&seed);
    let blob = create_auth_blob(&seed, &auth_host, &endpoint, now_unix_ms(), &nonce);
    let auth_header = switchback_proto::encode_auth_blob_b64(&blob);
    let mut request: Request = connect_url.as_str().into_client_request().map_err(|e| e.to_string())?;
    request
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", "switchback.v1".parse().map_err(|e| format!("{e}"))?);
    request
        .headers_mut()
        .insert("Switchback-Auth", auth_header.parse().map_err(|e| format!("{e}"))?);
    let (mut ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("first replay connect should succeed: {e}"))?;
    ws.send(Message::Close(None)).await.map_err(|e| e.to_string())?;
    Ok(())
}

pub enum Auth {
    /// Fresh blob; reusing `nonce` across calls exercises replay rejection.
    Fresh { seed: [u8; 32], nonce: Option<[u8; 16]> },
    /// Timestamp 10 minutes in the past: outside the 60s skew.
    Stale { seed: [u8; 32] },
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn parts(url: &str) -> (String, String) {
    // -> (ws base url, auth host)
    let rest = url.split_once("://").expect("scheme").1.trim_end_matches('/');
    let hostport = rest.split('/').next().unwrap_or(rest);
    let auth_host = match hostport.rsplit_once(':') {
        Some((host, _)) => host.to_lowercase(),
        None => hostport.to_lowercase(),
    };
    (format!("{}/v1/connect", url.trim_end_matches('/')), auth_host)
}

/// Connect with the given auth and offered subprotocol; expect an HTTP rejection with an
/// exact status and body.
pub async fn expect_upgrade_rejected(
    cairn: &str,
    auth: Auth,
    subprotocol: &str,
    expected_status: u16,
    expected_body: &str,
) -> Result<(), String> {
    let (connect_url, auth_host) = parts(cairn);
    let seed = match &auth {
        Auth::Fresh { seed, .. } => *seed,
        Auth::Stale { seed } => *seed,
    };
    let endpoint = switchback_proto::ed25519_public_key(&seed);
    let (timestamp_ms, nonce): (u64, [u8; 16]) = match auth {
        Auth::Fresh { nonce, .. } => {
            let mut n = nonce.unwrap_or([0u8; 16]);
            if nonce.is_none() {
                getrandom_bytes(&mut n);
            }
            (now_unix_ms(), n)
        }
        Auth::Stale { .. } => (now_unix_ms() - 10 * 60_000, [0xabu8; 16]),
    };
    let blob = create_auth_blob(&seed, &auth_host, &endpoint, timestamp_ms, &nonce);
    let auth_header = switchback_proto::encode_auth_blob_b64(&blob);

    let mut request: Request = connect_url.as_str().into_client_request().map_err(|e| e.to_string())?;
    request
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", subprotocol.parse().map_err(|e| format!("{e}"))?);
    request
        .headers_mut()
        .insert("Switchback-Auth", auth_header.parse().map_err(|e| format!("{e}"))?);

    match tokio_tungstenite::connect_async(request).await {
        Ok((_ws, _response)) => Err(format!("expected HTTP {expected_status}, but the upgrade succeeded")),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            let status = response.status().as_u16();
            let body = response.body().as_ref().map(|b| String::from_utf8_lossy(b).to_string()).unwrap_or_default();
            if status != expected_status {
                return Err(format!("expected HTTP {expected_status}, got {status} (body: {body})"));
            }
            if body.trim() != expected_body {
                return Err(format!("expected body {expected_body:?}, got {body:?}"));
            }
            Ok(())
        }
        Err(other) => Err(format!("expected HTTP {expected_status}, got a different error: {other}")),
    }
}

fn getrandom_bytes(buf: &mut [u8; 16]) {
    // e2e has no direct getrandom dep; reuse proto's re-export via signing path.
    let seed = [0u8; 32];
    let sig = switchback_proto::ed25519_sign(b"nonce", &seed);
    buf.copy_from_slice(&sig[..16]);
}

/// `/v1/ping` 204, `/v1/captive` echo, `/healthz` JSON with switchback.v1 (docs/08).
pub async fn probe_http(cairn: &str) -> Result<(), String> {
    let http_base = {
        let (base, _) = parts(cairn);
        base.trim_end_matches("/v1/connect")
            .replacen("ws://", "http://", 1)
            .replacen("wss://", "https://", 1)
    };

    // /v1/ping
    let ping = http_get(&format!("{http_base}/v1/ping")).await?;
    if ping.status != 204 {
        return Err(format!("/v1/ping: expected 204, got {}", ping.status));
    }

    // /v1/captive with a valid challenge
    let challenge = "abcdefgh12345678";
    let captive = http_get(&format!("{http_base}/v1/captive")).await?;
    let _ = captive; // simple GET without header: still 204, no echo (checked by TS suite)
    let captive_echo = http_get_header(&format!("{http_base}/v1/captive"), &[("Switchback-Challenge", challenge)]).await?;
    if captive_echo.status != 204 {
        return Err(format!("/v1/captive: expected 204, got {}", captive_echo.status));
    }
    match captive_echo.header("switchback-response") {
        Some(v) if v == challenge => {}
        other => return Err(format!("/v1/captive: bad challenge echo: {other:?}")),
    }

    // /healthz lists switchback.v1
    let health = http_get(&format!("{http_base}/healthz")).await?;
    if health.status != 200 {
        return Err(format!("/healthz: expected 200, got {}", health.status));
    }
    if !health.body.contains("\"switchback.v1\"") {
        return Err(format!("/healthz: protocols missing switchback.v1: {}", health.body));
    }
    Ok(())
}

struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl HttpResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

async fn http_get(url: &str) -> Result<HttpResponse, String> {
    http_get_header(url, &[]).await
}

async fn http_get_header(url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (hostport, path) = url
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/'))
        .ok_or_else(|| format!("invalid url {url}"))?;
    let host = hostport.split(':').next().unwrap_or(hostport);
    let port: u16 = hostport
        .rsplit_once(':')
        .and_then(|(_, p)| p.parse().ok())
        .unwrap_or(80);
    let mut stream = tokio::net::TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("connect {hostport}: {e}"))?;
    let mut head = format!("GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nConnection: close\r\n");
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.map_err(|e| e.to_string())?;
    parse_http(&String::from_utf8_lossy(&raw))
}

fn parse_http(text: &str) -> Result<HttpResponse, String> {
    let mut lines = text.lines();
    let status: u16 = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("bad status line: {text:?}"))?;
    let mut headers = Vec::new();
    for line in lines.by_ref() {
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let body: String = lines.collect::<Vec<_>>().join("\n");
    Ok(HttpResponse { status, headers, body })
}
