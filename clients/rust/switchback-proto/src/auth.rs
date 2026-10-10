//! Connect-auth blob (doc 01 §3.2): build the signed message, create and verify blobs.
//!
//! ```text
//! msg = BLAKE3.derive_key(context = "switchback v1 connect auth",
//!                         key_material = host || 0x00 || endpoint || timestamp_ms || nonce)
//! blob = version(1) || endpoint(32) || timestamp_ms(8 BE) || nonce(16) || signature(64)
//! ```

use base64::Engine as _;

use crate::crypto::{blake3_derive_key, ed25519_sign, ed25519_verify_strict, CONNECT_AUTH_CONTEXT};
use crate::keys::{endpoint_id_from_bytes, endpoint_id_to_bytes, ENDPOINT_KEY_LENGTH};

pub const AUTH_BLOB_VERSION: u8 = 0x01;
pub const AUTH_BLOB_LENGTH: usize = 121;
pub const AUTH_NONCE_LENGTH: usize = 16;
pub const AUTH_TIMESTAMP_LENGTH: usize = 8;
pub const AUTH_SIGNATURE_LENGTH: usize = 64;

/// Reasons a connect attempt fails auth (doc 01 §3.1 step 4); `missing` is a transport-layer
/// state (no blob at all), the rest are verification outcomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AuthFailure {
    #[error("malformed")]
    Malformed,
    #[error("stale")]
    Stale,
    #[error("bad-key")]
    BadKey,
    #[error("bad-signature")]
    BadSignature,
}

/// A decoded auth blob (doc 01 §3.2 layout).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthBlob {
    pub version: u8,
    pub endpoint: [u8; 32],
    pub timestamp_ms: u64,
    pub nonce: [u8; 16],
    pub signature: [u8; 64],
}

/// The raw material that gets signed.
pub struct AuthBlobParts {
    pub endpoint: [u8; 32],
    pub timestamp_ms: u64,
    pub nonce: [u8; 16],
    pub signature: [u8; 64],
}

/// Lower-case the host and strip any port (doc 01 §3.2).
pub fn normalize_host(host: &str) -> String {
    let lower = host.to_lowercase();
    if let Some(rest) = lower.strip_prefix('[') {
        // IPv6 literal: keep brackets, drop anything after ']'.
        match rest.find(']') {
            Some(end) => lower[..end + 2].to_string(),
            None => lower,
        }
    } else {
        match lower.rfind(':') {
            Some(colon) => lower[..colon].to_string(),
            None => lower,
        }
    }
}

/// The message that is signed.
pub fn build_auth_message(
    host: &str,
    endpoint: &[u8; 32],
    timestamp_ms: u64,
    nonce: &[u8; 16],
) -> Vec<u8> {
    let host = normalize_host(host);
    let mut msg = Vec::with_capacity(host.len() + 1 + 32 + 8 + 16);
    msg.extend_from_slice(host.as_bytes());
    msg.push(0x00);
    msg.extend_from_slice(endpoint);
    msg.extend_from_slice(&timestamp_ms.to_be_bytes());
    msg.extend_from_slice(nonce);
    msg
}

/// The 32-byte derived key the signature commits to.
pub fn derive_auth_message_key(msg: &[u8]) -> [u8; 32] {
    blake3_derive_key(CONNECT_AUTH_CONTEXT, msg)
}

/// Serialize an auth blob (121 bytes).
pub fn encode_auth_blob(parts: &AuthBlobParts) -> [u8; AUTH_BLOB_LENGTH] {
    let mut out = [0u8; AUTH_BLOB_LENGTH];
    out[0] = AUTH_BLOB_VERSION;
    out[1..33].copy_from_slice(&parts.endpoint);
    out[33..41].copy_from_slice(&parts.timestamp_ms.to_be_bytes());
    out[41..57].copy_from_slice(&parts.nonce);
    out[57..121].copy_from_slice(&parts.signature);
    out
}

/// Parse an auth blob. Checks only structural validity (doc 01 §3.2 check 1).
pub fn decode_auth_blob(bytes: &[u8]) -> Result<AuthBlob, AuthFailure> {
    if bytes.len() != AUTH_BLOB_LENGTH || bytes[0] != AUTH_BLOB_VERSION {
        return Err(AuthFailure::Malformed);
    }
    let mut endpoint = [0u8; 32];
    endpoint.copy_from_slice(&bytes[1..33]);
    let mut timestamp = [0u8; 8];
    timestamp.copy_from_slice(&bytes[33..41]);
    let mut nonce = [0u8; 16];
    nonce.copy_from_slice(&bytes[41..57]);
    let mut signature = [0u8; 64];
    signature.copy_from_slice(&bytes[57..121]);
    Ok(AuthBlob {
        version: bytes[0],
        endpoint,
        timestamp_ms: u64::from_be_bytes(timestamp),
        nonce,
        signature,
    })
}

/// Create and sign a fresh auth blob (new timestamp and nonce per connection attempt).
pub fn create_auth_blob(
    secret_key: &[u8; 32],
    host: &str,
    endpoint: &[u8; 32],
    timestamp_ms: u64,
    nonce: &[u8; 16],
) -> [u8; AUTH_BLOB_LENGTH] {
    let msg = build_auth_message(host, endpoint, timestamp_ms, nonce);
    let signature = ed25519_sign(&derive_auth_message_key(&msg), secret_key);
    encode_auth_blob(&AuthBlobParts {
        endpoint: *endpoint,
        timestamp_ms,
        nonce: *nonce,
        signature,
    })
}

/// Outcome of full verification, mirroring the TypeScript `verifyAuthBlob`.
pub type VerifyAuthResult = Result<VerifiedAuth, AuthFailure>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedAuth {
    /// Canonical z-base-32 EndpointId.
    pub endpoint: String,
    pub endpoint_bytes: [u8; 32],
    pub nonce: [u8; 16],
}

/// Full verification per doc 01 §3.2 checks 1–4. The replay check (check 5) happens in the
/// Router via `claimNonce` (doc 03).
pub fn verify_auth_blob(
    blob_bytes: &[u8],
    host: &str,
    now_ms: u64,
    skew_ms: u64,
) -> VerifyAuthResult {
    let blob = decode_auth_blob(blob_bytes)?;

    // Check 2: freshness.
    let age = blob.timestamp_ms.abs_diff(now_ms);
    if age > skew_ms {
        return Err(AuthFailure::Stale);
    }

    // Check 3: key must be a valid point, not small-order.
    if !crate::keys::is_valid_endpoint_key(&blob.endpoint) {
        return Err(AuthFailure::BadKey);
    }

    // Check 4: strict signature.
    let msg = build_auth_message(host, &blob.endpoint, blob.timestamp_ms, &blob.nonce);
    if !ed25519_verify_strict(&blob.signature, &derive_auth_message_key(&msg), &blob.endpoint) {
        return Err(AuthFailure::BadSignature);
    }

    Ok(VerifiedAuth {
        endpoint: endpoint_id_from_bytes(&blob.endpoint),
        endpoint_bytes: blob.endpoint,
        nonce: blob.nonce,
    })
}

/// base64url without padding (doc 01 §3).
pub fn encode_auth_blob_b64(blob: &[u8; AUTH_BLOB_LENGTH]) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    URL_SAFE_NO_PAD.encode(blob)
}

/// Decode a base64url-nopad auth blob; `None` means malformed transport encoding.
pub fn decode_auth_blob_b64(text: &str) -> Option<[u8; AUTH_BLOB_LENGTH]> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let bytes = URL_SAFE_NO_PAD.decode(text).ok()?;
    bytes.try_into().ok()
}

#[allow(dead_code)]
fn _assert_endpoint_round_trip(id: &str) -> Option<[u8; ENDPOINT_KEY_LENGTH]> {
    endpoint_id_to_bytes(id).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "cairn.example.net";

    fn test_key() -> ([u8; 32], [u8; 32]) {
        let mut seed = [0u8; 32];
        for (i, b) in seed.iter_mut().enumerate() {
            *b = (i + 1) as u8;
        }
        let public = crate::crypto::ed25519_public_key(&seed);
        (seed, public)
    }

    #[test]
    fn create_verify_round_trip() {
        let (seed, public) = test_key();
        let nonce = [0xabu8; 16];
        let ts = 1_700_000_000_000u64;
        let blob = create_auth_blob(&seed, HOST, &public, ts, &nonce);
        assert_eq!(blob.len(), AUTH_BLOB_LENGTH);
        let verified = verify_auth_blob(&blob, HOST, ts, 60_000).unwrap();
        assert_eq!(verified.endpoint_bytes, public);
        assert_eq!(verified.endpoint, endpoint_id_from_bytes(&public));
        assert_eq!(verified.nonce, nonce);
    }

    #[test]
    fn stale_both_directions() {
        let (seed, public) = test_key();
        let ts = 1_700_000_000_000u64;
        let blob = create_auth_blob(&seed, HOST, &public, ts, &[1u8; 16]);
        let skew = 60_000u64;
        assert!(verify_auth_blob(&blob, HOST, ts + skew, skew).is_ok());
        assert!(verify_auth_blob(&blob, HOST, ts - skew, skew).is_ok());
        assert_eq!(
            verify_auth_blob(&blob, HOST, ts + skew + 1, skew),
            Err(AuthFailure::Stale)
        );
        assert_eq!(
            verify_auth_blob(&blob, HOST, ts - skew - 1, skew),
            Err(AuthFailure::Stale)
        );
    }

    #[test]
    fn wrong_host_fails() {
        let (seed, public) = test_key();
        let ts = 1_700_000_000_000u64;
        let blob = create_auth_blob(&seed, HOST, &public, ts, &[2u8; 16]);
        assert_eq!(
            verify_auth_blob(&blob, "other.example.net", ts, 60_000),
            Err(AuthFailure::BadSignature)
        );
    }

    #[test]
    fn malformed_blob() {
        assert_eq!(verify_auth_blob(&[0u8; 120], HOST, 0, 60_000), Err(AuthFailure::Malformed));
        let mut blob = [0u8; AUTH_BLOB_LENGTH];
        blob[0] = 0x02; // wrong version
        assert_eq!(verify_auth_blob(&blob, HOST, 0, 60_000), Err(AuthFailure::Malformed));
    }

    #[test]
    fn b64_round_trip() {
        let (seed, public) = test_key();
        let blob = create_auth_blob(&seed, HOST, &public, 1_700_000_000_000, &[3u8; 16]);
        let text = encode_auth_blob_b64(&blob);
        assert_eq!(text.len(), 162);
        assert_eq!(decode_auth_blob_b64(&text).unwrap(), blob);
        assert!(decode_auth_blob_b64("!!!").is_none());
    }
}
