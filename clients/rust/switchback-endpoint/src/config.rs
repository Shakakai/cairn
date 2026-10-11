//! Switchback client configuration (doc 09): one Cairn deployment, STUN servers, an
//! optional access token, and the relay-path policy. There are no network presets (C7) —
//! every default is a constant in this crate.

use std::sync::Arc;

/// Ed25519 secret key seed (32 bytes). The [`EndpointId`](crate::EndpointId) is derived
/// from it. Clone is cheap (shared).
#[derive(Clone)]
pub struct SecretKey(Arc<[u8; 32]>);

impl SecretKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(Arc::new(bytes))
    }

    pub fn generate() -> Self {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).expect("CSPRNG");
        Self::from_bytes(bytes)
    }

    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretKey(..)")
    }
}

/// A parsed Cairn deployment URL. `ws(s)://` and `http(s)://` spellings are accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CairnUrl {
    /// Normalised `http(s)://host` base (no path, no trailing slash).
    pub(crate) http_base: String,
    /// `true` when TLS is in use.
    pub(crate) secure: bool,
    /// Lower-cased host without port (used in the auth blob, doc 01 §3.2).
    pub(crate) auth_host: String,
}

impl CairnUrl {
    pub fn parse(text: &str) -> Result<Self, InvalidCairnUrl> {
        let url = url_parse(text)?;
        let secure = match url.0.as_str() {
            "https" | "wss" => true,
            "http" | "ws" => false,
            other => return Err(InvalidCairnUrl::UnsupportedScheme(other.to_string())),
        };
        if url.1.is_empty() {
            return Err(InvalidCairnUrl::MissingHost);
        }
        let http_base = format!("{}://{}", if secure { "https" } else { "http" }, url.1);
        Ok(Self {
            http_base,
            secure,
            auth_host: url.2,
        })
    }

    /// `wss://host/v1/connect` / `ws://host/v1/connect`.
    pub fn connect_url(&self) -> String {
        format!(
            "{}://{}/v1/connect",
            if self.secure { "wss" } else { "ws" },
            &self.http_base.split("://").nth(1).expect("scheme")
        )
    }

    /// `http(s)://host/v1/captive`.
    pub fn captive_url(&self) -> String {
        format!("{}/v1/captive", self.http_base)
    }

    /// `http(s)://host/v1/ping`.
    pub fn ping_url(&self) -> String {
        format!("{}/v1/ping", self.http_base)
    }

    /// `http(s)://host/healthz`.
    pub fn healthz_url(&self) -> String {
        format!("{}/healthz", self.http_base)
    }
}

impl std::str::FromStr for CairnUrl {
    type Err = InvalidCairnUrl;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

/// Minimal URL splitter (avoids a url crate dependency for this one use).
fn url_parse(text: &str) -> Result<(String, String, String), InvalidCairnUrl> {
    let (scheme, rest) = text.split_once("://").ok_or(InvalidCairnUrl::MissingScheme)?;
    let rest = rest.trim_end_matches('/');
    let without_path = rest.split('/').next().unwrap_or(rest);
    // auth host: lower-cased, port stripped (IPv6 literals keep brackets)
    let auth_host = if let Some(inner) = without_path.strip_prefix('[') {
        match inner.split_once(']') {
            Some((ip, _)) => format!("[{ip}]").to_lowercase(),
            None => without_path.to_lowercase(),
        }
    } else {
        match without_path.rsplit_once(':') {
            Some((host, _)) => host.to_lowercase(),
            None => without_path.to_lowercase(),
        }
    };
    Ok((scheme.to_string(), without_path.to_string(), auth_host))
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum InvalidCairnUrl {
    #[error("missing scheme (http/https/ws/wss)")]
    MissingScheme,
    #[error("unsupported scheme {0}")]
    UnsupportedScheme(String),
    #[error("missing host")]
    MissingHost,
}

/// What to do with the relay path once a direct path exists (doc 09 C4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RelayPathPolicy {
    /// Stop keepalives on the relay path when a direct path is selected (default).
    #[default]
    QuietWhenDirect,
    /// Keep the relay path warm (calls / real-time apps).
    AlwaysWarm,
}

/// Everything needed to build an endpoint. `switchback-endpoint` speaks `switchback.v1`
/// only and knows exactly one deployment (C7).
#[derive(Debug, Clone)]
pub struct SwitchbackConfig {
    /// e.g. `https://cairn.example.net`.
    pub cairn_url: CairnUrl,
    /// STUN servers for address discovery (used from M7; defaults below).
    pub stun_servers: Vec<String>,
    /// Optional bearer token (doc 01 §3.3).
    pub access_token: Option<String>,
    pub relay_path_policy: RelayPathPolicy,
}

impl SwitchbackConfig {
    /// Default STUN servers (ADR-004): Cloudflare's public anycast STUN.
    pub const DEFAULT_STUN: &'static [&'static str] = &["stun.cloudflare.com:3478"];
}

impl Default for SwitchbackConfig {
    fn default() -> Self {
        Self {
            cairn_url: CairnUrl::parse("https://cairn.example.net").expect("constant url"),
            stun_servers: Self::DEFAULT_STUN.iter().map(|s| s.to_string()).collect(),
            access_token: None,
            relay_path_policy: RelayPathPolicy::default(),
        }
    }
}
