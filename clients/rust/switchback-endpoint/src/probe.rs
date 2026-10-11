//! Cairn probes (doc 09-C6): captive-portal detection against the configured deployment.
//! No relay-latency probing exists — there is one anycast URL and nothing to choose
//! between. Plain HTTP/1.1 over a raw TCP socket keeps this dependency-free.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::CairnUrl;

/// Challenge token shape (doc 01 §2.1): 16–32 chars from [A-Za-z0-9].
pub const CHALLENGE_LENGTH: usize = 16;

/// Perform the captive-portal check. Returns `Ok(false)` when the network is clean,
/// `Ok(true)` when a captive portal is detected, and `Err` when the check itself failed
/// (treated as "no conclusion" by callers).
pub async fn captive_portal_check(cairn: &CairnUrl) -> Result<bool, ProbeError> {
    let url = cairn.captive_url();
    let (host, port) = host_port(&url)?;
    let mut stream = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|e| ProbeError::Connect(e.to_string()))?;

    let challenge = random_challenge();
    let request = format!(
        "GET /v1/captive HTTP/1.1\r\nHost: {host}\r\nSwitchback-Challenge: {challenge}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| ProbeError::Io(e.to_string()))?;

    let mut response = Vec::with_capacity(1024);
    stream
        .read_to_end(&mut response)
        .await
        .map_err(|e| ProbeError::Io(e.to_string()))?;
    let head = String::from_utf8_lossy(&response);

    let status_ok = head.lines().next().is_some_and(|line| line.contains("204"));
    let echoed = head
        .lines()
        .find_map(|line| line.to_ascii_lowercase().strip_prefix("switchback-response:").map(str::to_string))
        .map(|v| v.trim().to_string())
        == Some(challenge);
    Ok(!(status_ok && echoed))
}

fn host_port(url: &str) -> Result<(String, u16), ProbeError> {
    let rest = url
        .split_once("://")
        .ok_or_else(|| ProbeError::InvalidUrl(url.to_string()))?
        .1;
    let hostport = rest.split('/').next().unwrap_or(rest);
    match hostport.rsplit_once(':') {
        Some((host, port)) => {
            let port: u16 = port.parse().map_err(|_| ProbeError::InvalidUrl(url.to_string()))?;
            Ok((host.to_string(), port))
        }
        None => Ok((hostport.to_string(), if url.starts_with("https") { 443 } else { 80 })),
    }
}

fn random_challenge() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut raw = [0u8; CHALLENGE_LENGTH];
    getrandom::getrandom(&mut raw).expect("CSPRNG");
    raw.iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect()
}

#[derive(Debug, thiserror::Error)]
pub enum ProbeError {
    #[error("invalid url {0}")]
    InvalidUrl(String),
    #[error("connect failed: {0}")]
    Connect(String),
    #[error("io failed: {0}")]
    Io(String),
}
