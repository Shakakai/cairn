//! The app-facing endpoint (doc 09): a quinn endpoint whose only transport is the Cairn
//! relay client. Dial by EndpointId alone; both sides verify the peer's Ed25519 identity
//! proof from the TLS certificate (ADR-013).

use std::sync::Arc;

use quinn::crypto::rustls::{QuicClientConfig, QuicServerConfig};
use tracing::debug;

use crate::config::{SecretKey, SwitchbackConfig};
use crate::relay_client::RelayClientConfig;
use crate::identity::{self, IdentityError};
use crate::relay_client;
use crate::socket::{RelaySocket, SocketQueues};
use crate::{CairnUrl, EndpointAddr, EndpointId, PROTOCOL_VERSIONS};

pub use quinn::Connection;

/// Default ALPN for Switchback application connections.
pub const DEFAULT_ALPN: &[u8] = b"switchback/1";

#[derive(Debug, thiserror::Error)]
pub enum EndpointError {
    #[error("invalid cairn url: {0}")]
    InvalidUrl(#[from] crate::config::InvalidCairnUrl),
    #[error("certificate generation failed: {0}")]
    Certificate(#[from] rcgen::Error),
    #[error("endpoint construction failed: {0}")]
    Quinn(#[from] std::io::Error),
    #[error("relay connection failed: {0}")]
    Relay(String),
    #[error("peer identity verification failed: {0}")]
    Identity(#[from] IdentityError),
    #[error("connected to {connected}, expected {expected}")]
    PeerMismatch { connected: EndpointId, expected: EndpointId },
    #[error("connection failed: {0}")]
    Connect(#[from] quinn::ConnectError),
    #[error("connection failed: {0}")]
    Connection(#[from] quinn::ConnectionError),
}

/// Builder preconfigured for Switchback (doc 09): Cairn as the only relay, STUN config
/// carried for M7, quiet-relay-path policy, no other lookup services (C7).
pub struct EndpointBuilder {
    config: SwitchbackConfig,
    secret: SecretKey,
    alpns: Vec<Vec<u8>>,
}

impl EndpointBuilder {
    fn new(config: SwitchbackConfig) -> Self {
        Self {
            config,
            secret: SecretKey::generate(),
            alpns: vec![DEFAULT_ALPN.to_vec()],
        }
    }

    /// Use a specific identity (otherwise one is generated).
    pub fn secret_key(mut self, secret: SecretKey) -> Self {
        self.secret = secret;
        self
    }

    /// Application protocols this endpoint serves (default `switchback/1`).
    pub fn alpn_protocols(mut self, alpns: Vec<Vec<u8>>) -> Self {
        self.alpns = alpns;
        self
    }

    pub async fn build(self) -> Result<Endpoint, EndpointError> {
        Endpoint::build(self.config, self.secret, self.alpns).await
    }
}

/// A Switchback endpoint. Cheap to clone.
#[derive(Clone)]
pub struct Endpoint {
    inner: quinn::Endpoint,
    secret: SecretKey,
    local_id: EndpointId,
    relay: relay_client::RelayClientHandle,
    queues: Arc<SocketQueues>,
}

impl Endpoint {
    async fn build(
        config: SwitchbackConfig,
        secret: SecretKey,
        alpns: Vec<Vec<u8>>,
    ) -> Result<Self, EndpointError> {
        let cert = identity::generate_certificate(secret.bytes())?;
        let tls_key = rustls_pki_types::PrivateKeyDer::Pkcs8(cert.key_der.into());
        let tls_cert = rustls_pki_types::CertificateDer::from(cert.cert_der);

        // Server side: accept any certificate — peer identity is proven by the Ed25519
        // signature in the certificate extension and verified by us (ADR-013).
        let mut server_tls = quinn::rustls::ServerConfig::builder()
            .with_client_cert_verifier(Arc::new(AcceptAnyClient))
            .with_single_cert(vec![tls_cert.clone()], tls_key.clone_key())
            .map_err(|e| EndpointError::Relay(format!("tls server config: {e}")))?;
        server_tls.alpn_protocols = alpns.clone();
        let server = quinn::ServerConfig::with_crypto(Arc::new(
            QuicServerConfig::try_from(server_tls).map_err(|e| EndpointError::Relay(format!("quic server config: {e}")))?,
        ));

        let mut client_tls = quinn::rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAll))
            .with_client_auth_cert(vec![tls_cert], tls_key)
            .map_err(|e| EndpointError::Relay(format!("tls client config: {e}")))?;
        client_tls.alpn_protocols = alpns;
        let _client: quinn::ClientConfig =
            quinn::ClientConfig::new(Arc::new(QuicClientConfig::try_from(client_tls).map_err(
                |e| EndpointError::Relay(format!("quic client config: {e}")),
            )?));

        let queues = SocketQueues::new();
        let relay = relay_client::spawn(
            RelayClientConfig {
                connect_url: config.cairn_url.connect_url(),
                auth_host: config.cairn_url.auth_host.clone(),
                secret_key: *secret.bytes(),
                access_token: config.access_token.clone(),
            },
            queues.clone(),
        );

        let socket = RelaySocket::new(queues.clone(), relay.outbound.clone());
        let runtime =
            quinn::default_runtime().ok_or_else(|| EndpointError::Relay("no async runtime".into()))?;
        let inner = quinn::Endpoint::new_with_abstract_socket(
            quinn::EndpointConfig::default(),
            Some(server),
            socket,
            runtime,
        )?;

        let local_id = relay_client_handle_id(&relay);
        Ok(Self {
            inner,
            secret,
            local_id,
            relay,
            queues,
        })
    }

    /// This endpoint's public identity.
    pub fn local_id(&self) -> &EndpointId {
        &self.local_id
    }

    /// Access to the underlying relay client (control events, recording).
    pub fn relay(&self) -> &relay_client::RelayClientHandle {
        &self.relay
    }

    /// The secret key (kept private; exposed for tests that need to reconnect as the same
    /// identity).
    pub fn secret_key(&self) -> &SecretKey {
        &self.secret
    }

    /// Dial a peer by EndpointId. Verifies the peer's identity proof before returning.
    pub async fn connect(&self, peer: &EndpointId) -> Result<Connection, EndpointError> {
        self.connect_with_alpn(peer, DEFAULT_ALPN).await
    }

    /// Dial with a specific ALPN (must be one the peer serves).
    pub async fn connect_with_alpn(&self, peer: &EndpointId, alpn: &[u8]) -> Result<Connection, EndpointError> {
        let peer_bytes = switchback_proto::endpoint_id_to_bytes(peer)
            .map_err(|_| EndpointError::Relay(format!("malformed peer id {peer}")))?;
        let addr = crate::socket::peer_addr(&peer_bytes);
        self.queues.register_peer(addr, peer_bytes);

        let client_config = self.client_config_for(alpn);
        let connecting = self.inner.connect_with(client_config, addr, "switchback")?;
        let conn = connecting.await?;
        let identity = peer_identity(&conn)?;
        if identity.endpoint_id != *peer {
            let connected = identity.endpoint_id;
            conn.close(0u32.into(), b"peer identity mismatch");
            return Err(EndpointError::PeerMismatch { connected, expected: peer.clone() });
        }
        debug!(peer = %peer, "connection established");
        Ok(conn)
    }

    /// Accept an incoming connection; returns the peer's proven EndpointId.
    pub async fn accept(&self) -> Option<(EndpointId, Connection)> {
        loop {
            let incoming = self.inner.accept().await?;
            match incoming.await {
                Ok(conn) => match peer_identity(&conn) {
                    Ok(identity) => return Some((identity.endpoint_id, conn)),
                    Err(error) => {
                        tracing::warn!(%error, "rejected connection with unverifiable identity");
                        conn.close(0u32.into(), b"bad identity proof");
                    }
                },
                Err(error) => {
                    tracing::warn!(%error, "incoming connection failed");
                }
            }
        }
    }

    fn client_config_for(&self, alpn: &[u8]) -> quinn::ClientConfig {
        let cert = identity::generate_certificate(self.secret.bytes()).expect("regenerate cert");
        let tls_key = rustls_pki_types::PrivateKeyDer::Pkcs8(cert.key_der.into());
        let tls_cert = rustls_pki_types::CertificateDer::from(cert.cert_der);
        let mut client_tls = quinn::rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAll))
            .with_client_auth_cert(vec![tls_cert], tls_key)
            .expect("client config");
        client_tls.alpn_protocols = vec![alpn.to_vec()];
        quinn::ClientConfig::new(Arc::new(QuicClientConfig::try_from(client_tls).expect("quic client config")))
    }
}

/// Extract and verify the peer's Ed25519 identity from the QUIC connection.
fn peer_identity(conn: &Connection) -> Result<identity::PeerIdentity, IdentityError> {
    let certs: Vec<rustls_pki_types::CertificateDer<'static>> = conn
        .peer_identity()
        .and_then(|any| any.downcast::<Vec<rustls_pki_types::CertificateDer<'static>>>().ok().map(|b| *b))
        .ok_or(IdentityError::NoCertificate)?;
    identity::verify_peer(&certs)
}

fn relay_client_handle_id(handle: &relay_client::RelayClientHandle) -> EndpointId {
    handle.endpoint_id().to_string()
}

/// Client certificate verifier that accepts any certificate: peer authentication is the
/// Ed25519 identity proof, verified out-of-band of TLS chain validation (ADR-013).
#[derive(Debug)]
struct AcceptAnyClient;

impl quinn::rustls::server::danger::ClientCertVerifier for AcceptAnyClient {
    fn offer_client_auth(&self) -> bool {
        true
    }

    fn client_auth_mandatory(&self) -> bool {
        true
    }

    fn root_hint_subjects(&self) -> &[quinn::rustls::DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        _end_entity: &rustls_pki_types::CertificateDer<'_>,
        _intermediates: &[rustls_pki_types::CertificateDer<'_>],
        _now: rustls_pki_types::UnixTime,
    ) -> Result<quinn::rustls::server::danger::ClientCertVerified, quinn::rustls::Error> {
        Ok(quinn::rustls::server::danger::ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &quinn::rustls::DigitallySignedStruct,
    ) -> Result<quinn::rustls::client::danger::HandshakeSignatureValid, quinn::rustls::Error> {
        Ok(quinn::rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &quinn::rustls::DigitallySignedStruct,
    ) -> Result<quinn::rustls::client::danger::HandshakeSignatureValid, quinn::rustls::Error> {
        Ok(quinn::rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<quinn::rustls::SignatureScheme> {
        vec![
            quinn::rustls::SignatureScheme::RSA_PSS_SHA256,
            quinn::rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            quinn::rustls::SignatureScheme::ED25519,
        ]
    }
}

/// Certificate verifier that accepts any certificate: peer authentication is the
/// Ed25519 identity proof, verified out-of-band of TLS chain validation (ADR-013).
#[derive(Debug)]
struct AcceptAll;

impl quinn::rustls::client::danger::ServerCertVerifier for AcceptAll {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls_pki_types::CertificateDer<'_>,
        _intermediates: &[rustls_pki_types::CertificateDer<'_>],
        _server_name: &quinn::rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls_pki_types::UnixTime,
    ) -> Result<quinn::rustls::client::danger::ServerCertVerified, quinn::rustls::Error> {
        Ok(quinn::rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &quinn::rustls::DigitallySignedStruct,
    ) -> Result<quinn::rustls::client::danger::HandshakeSignatureValid, quinn::rustls::Error> {
        Ok(quinn::rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &quinn::rustls::DigitallySignedStruct,
    ) -> Result<quinn::rustls::client::danger::HandshakeSignatureValid, quinn::rustls::Error> {
        Ok(quinn::rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<quinn::rustls::SignatureScheme> {
        vec![
            quinn::rustls::SignatureScheme::RSA_PSS_SHA256,
            quinn::rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            quinn::rustls::SignatureScheme::ED25519,
        ]
    }
}

/// `builder(cfg)` (doc 09): an endpoint builder preconfigured for Switchback.
pub fn builder(cfg: &SwitchbackConfig) -> EndpointBuilder {
    EndpointBuilder::new(cfg.clone())
}

/// `builder_relay_only(cfg)`: relayed connections only (no IP transports). On this
/// from-scratch client every endpoint is relay-only today; the name is kept for API
/// parity with doc 09 and future direct transports.
pub fn builder_relay_only(cfg: &SwitchbackConfig) -> EndpointBuilder {
    EndpointBuilder::new(cfg.clone())
}

/// `addr(cfg, peer)`: dial a peer by id alone (doc 09). The returned address resolves to
/// the configured Cairn.
pub fn addr(cfg: &SwitchbackConfig, peer: EndpointId) -> EndpointAddr {
    EndpointAddr {
        peer,
        cairn: cfg.cairn_url.clone(),
    }
}

/// Wire protocol versions this client speaks (doc 01 §1).
pub fn protocol_versions() -> &'static [&'static str] {
    PROTOCOL_VERSIONS
}

/// One Cairn deployment's view of a peer: identity + where to reach it.
#[derive(Debug, Clone)]
pub struct LookupResult {
    pub peer: EndpointId,
    pub cairn: CairnUrl,
}
