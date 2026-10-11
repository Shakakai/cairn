//! Raw protocol checks for e2e: hand-built WebSocket upgrades (replay/stale/subprotocol)
//! and the HTTP probes, using switchback-proto to craft auth blobs.

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

use switchback_proto::create_auth_blob;

/// A successful upgrade with a fixed nonce (the first half of the replay scenario).
pub async fn connect_ok(cairn: &str, seed: [u8; 32], nonce: [u8; 16]) -> Result<(), String> {
    let mut ws = connect_with_nonce(cairn, seed, nonce).await?;
    ws.send(Message::Close(None)).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Platform-tolerant replay assertion (doc 01 §3.1): Node rejects the upgrade with
/// 401 before accept; Cloudflare accepts and then closes with 1008.
pub async fn expect_replayed(cairn: &str, seed: [u8; 32], nonce: [u8; 16]) -> Result<(), String> {
    match tokio_tungstenite::connect_async(auth_request(cairn, seed, nonce)?).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            let status = response.status().as_u16();
            let body = response
                .body()
                .as_ref()
                .map(|b| String::from_utf8_lossy(b).to_string())
                .unwrap_or_default();
            if status == 401 && body.trim() == "auth: replay" {
                Ok(())
            } else {
                Err(format!("expected 401 auth: replay, got {status} {body}"))
            }
        }
        Err(other) => Err(format!("unexpected error: {other}")),
        Ok((mut ws, _)) => {
            // Cloudflare path: accepted (ServerInfo arrives first), then closed with
            // 1008 once the mailbox rejects the replayed nonce.
            let read = async move {
                use futures_util::StreamExt;
                loop {
                    match ws.next().await {
                        Some(Ok(Message::Close(Some(frame)))) if u16::from(frame.code) == 1008 => {
                            return Ok(())
                        }
                        Some(Ok(_)) => continue,
                        other => return Err(format!("expected close 1008, got {other:?}")),
                    }
                }
            };
            tokio::time::timeout(std::time::Duration::from_secs(10), read)
                .await
                .map_err(|_| "timed out waiting for the 1008 replay close".to_string())?
        }
    }
}

fn auth_request(cairn: &str, seed: [u8; 32], nonce: [u8; 16]) -> Result<Request, String> {
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
    Ok(request)
}

async fn connect_with_nonce(
    cairn: &str,
    seed: [u8; 32],
    nonce: [u8; 16],
) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, String> {
    let (ws, _) = tokio_tungstenite::connect_async(auth_request(cairn, seed, nonce)?)
        .await
        .map_err(|e| format!("connect should succeed: {e}"))?;
    Ok(ws)
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
    // Read the head, then exactly the declared body length: servers may keep the
    // connection open (no EOF), which read_to_end would wait for.
    let mut raw = Vec::with_capacity(2048);
    let mut buf = [0u8; 1024];
    let head_end = loop {
        let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break raw.len();
        }
        raw.extend_from_slice(&buf[..n]);
        if let Some(pos) = find_subslice(&raw, b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let head_text = String::from_utf8_lossy(&raw[..head_end.min(raw.len())]).to_string();
    let content_length = head_text.lines().find_map(|line| {
        let (k, v) = line.split_once(':')?;
        if k.trim().eq_ignore_ascii_case("content-length") {
            v.trim().parse::<usize>().ok()
        } else {
            None
        }
    });
    // Body: read the declared length, or (chunked/close-delimited) until EOF with a
    // short timeout so an idle keep-alive socket can't stall the probe.
    let body_collection = async {
        let mut body = raw[head_end.min(raw.len())..].to_vec();
        match content_length {
            Some(len) => {
                while body.len() < len {
                    let n = stream.read(&mut buf).await?;
                    if n == 0 {
                        break;
                    }
                    body.extend_from_slice(&buf[..n]);
                }
            }
            None => {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                    loop {
                        let n = stream.read(&mut buf).await?;
                        if n == 0 {
                            break;
                        }
                        body.extend_from_slice(&buf[..n]);
                    }
                    Ok::<_, std::io::Error>(())
                })
                .await;
            }
        }
        Ok::<Vec<u8>, std::io::Error>(body)
    };
    let body = body_collection.await.map_err(|e| e.to_string())?;
    parse_http_with_body(&head_text, body)
}

fn parse_http_with_body(head: &str, body: Vec<u8>) -> Result<HttpResponse, String> {
    let mut parsed = parse_http(head)?;
    parsed.body = String::from_utf8_lossy(&body).to_string();
    Ok(parsed)
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
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
