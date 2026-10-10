//! Crypto wrappers: BLAKE3 derive-key mode and strict Ed25519 (doc 01 §3.2 check 4 —
//! `ed25519-dalek` `verify_strict`: canonical S and R, no small-order keys).

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};

/// BLAKE3 derive-key context for connect auth (doc 01 §3.2).
pub const CONNECT_AUTH_CONTEXT: &str = "switchback v1 connect auth";

pub const DERIVED_KEY_LENGTH: usize = 32;
pub const SIGNATURE_LENGTH: usize = 64;

/// BLAKE3 in derive-key mode (parity with `@noble/hashes` `blake3(data, { context })`).
pub fn blake3_derive_key(context: &str, key_material: &[u8]) -> [u8; 32] {
    blake3::derive_key(context, key_material)
}

/// Strict Ed25519 verification: canonical S and R, and the key must not be small-order.
/// Returns false on any malformation (never panics).
pub fn ed25519_verify_strict(sig: &[u8; 64], msg: &[u8], pub_key: &[u8; 32]) -> bool {
    use ed25519_dalek::Signature;
    let Ok(key) = VerifyingKey::from_bytes(pub_key) else {
        return false;
    };
    if key.is_weak() {
        return false;
    }
    let Ok(signature) = Signature::from_slice(sig) else {
        return false;
    };
    // from_slice accepts any 64 bytes; verify_strict enforces canonical S.
    key.verify_strict(msg, &signature).is_ok()
}

/// Deterministic Ed25519 signature (RFC 8032); used by tooling and tests.
pub fn ed25519_sign(msg: &[u8], secret_key: &[u8; 32]) -> [u8; 64] {
    let signing = SigningKey::from_bytes(secret_key);
    signing.sign(msg).to_bytes()
}

/// Derive the 32-byte Ed25519 public key from a secret key seed.
pub fn ed25519_public_key(secret_key: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(secret_key).verifying_key().to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hex_literal::hex;

    /// Parity vector (AGENTS.md): context "switchback v1 connect auth", key material
    /// utf8("cairn.example.net") || 0x00 || 56 zero bytes.
    #[test]
    fn blake3_derive_key_parity() {
        let mut material = b"cairn.example.net".to_vec();
        material.push(0x00);
        material.extend_from_slice(&[0u8; 56]);
        let key = blake3_derive_key(CONNECT_AUTH_CONTEXT, &material);
        assert_eq!(
            key,
            hex!("31f4b855e7853ca9cd7425ce3b3651246683de3a1927a097b9e3a2a15c80509a")
        );
    }

    #[test]
    fn sign_verify_round_trip() {
        let secret = [7u8; 32];
        let public = ed25519_public_key(&secret);
        let msg = b"switchback test message";
        let sig = ed25519_sign(msg, &secret);
        assert!(ed25519_verify_strict(&sig, msg, &public));
        let mut bad_sig = sig;
        bad_sig[0] ^= 1;
        assert!(!ed25519_verify_strict(&bad_sig, msg, &public));
    }
}
