//! Endpoint identity in the QUIC TLS certificate (ADR-013).
//!
//! Every endpoint generates a self-signed TLS certificate at startup whose DER carries a
//! custom extension: `endpoint_id(32) || ed25519_signature(tls_spki || endpoint_id) ||
//! tls_spki`. Both sides verify the extension on connect, binding the QUIC connection to
//! the Ed25519 EndpointId from doc 01 — the relay routes by key, and this proof lets a
//! peer be sure *which* key it is talking to. Carrying the SPKI in the extension means
//! verification needs no general X.509 parsing.

use rcgen::{CertificateParams, CustomExtension, DistinguishedName, KeyPair};
use switchback_proto::{ed25519_public_key, ed25519_sign, ed25519_verify_strict};

use crate::EndpointId;

/// OID for the Switchback identity extension: 1.3.6.1.4.1.57264.99.1 ("Switchback
/// identity proof v1", private-enterprise arc).
const IDENTITY_EXTENSION_OID: &[u64] = &[1, 3, 6, 1, 4, 1, 57264, 99, 1];

pub struct IdentityCertificate {
    /// rustls-ready DER certificate.
    pub cert_der: Vec<u8>,
    /// DER private key (PKCS#8).
    pub key_der: Vec<u8>,
}

/// Build the signed TLS certificate for `secret_key`.
pub fn generate_certificate(secret_key: &[u8; 32]) -> Result<IdentityCertificate, rcgen::Error> {
    let endpoint_id = ed25519_public_key(secret_key);
    let key_pair = KeyPair::generate()?;
    let spki = key_pair.public_key_raw().to_vec();

    let mut message = Vec::with_capacity(spki.len() + 32);
    message.extend_from_slice(&spki);
    message.extend_from_slice(&endpoint_id);
    let signature = ed25519_sign(&message, secret_key);

    // extension payload: endpoint_id || signature || spki
    let mut payload = Vec::with_capacity(32 + 64 + spki.len());
    payload.extend_from_slice(&endpoint_id);
    payload.extend_from_slice(&signature);
    payload.extend_from_slice(&spki);

    let mut params = CertificateParams::new(Vec::<String>::new())?;
    params.distinguished_name = DistinguishedName::new();
    params
        .custom_extensions
        .push(CustomExtension::from_oid_content(IDENTITY_EXTENSION_OID, payload));

    let cert = params.self_signed(&key_pair)?;
    Ok(IdentityCertificate {
        cert_der: cert.der().to_vec(),
        key_der: key_pair.serialize_der(),
    })
}

/// Verified peer identity extracted from a presented certificate.
pub struct PeerIdentity {
    /// The Ed25519 EndpointId the peer proved control of.
    pub endpoint_id: EndpointId,
}

/// Verify a peer's certificate and return its proven EndpointId.
pub fn verify_peer(certs: &[rustls_pki_types::CertificateDer<'_>]) -> Result<PeerIdentity, IdentityError> {
    let leaf = certs.first().ok_or(IdentityError::NoCertificate)?;
    let payload = extract_identity_extension(leaf.as_ref()).ok_or(IdentityError::MissingExtension)?;
    if payload.len() < 96 {
        return Err(IdentityError::MalformedExtension);
    }
    let mut claimed_id = [0u8; 32];
    claimed_id.copy_from_slice(&payload[..32]);
    let mut signature = [0u8; 64];
    signature.copy_from_slice(&payload[32..96]);
    let spki = &payload[96..];

    let mut message = Vec::with_capacity(spki.len() + 32);
    message.extend_from_slice(spki);
    message.extend_from_slice(&claimed_id);
    if !ed25519_verify_strict(&signature, &message, &claimed_id) {
        return Err(IdentityError::BadSignature);
    }
    Ok(PeerIdentity {
        endpoint_id: switchback_proto::endpoint_id_from_bytes(&claimed_id),
    })
}

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("peer presented no certificate")]
    NoCertificate,
    #[error("certificate is missing the Switchback identity extension")]
    MissingExtension,
    #[error("identity extension is malformed")]
    MalformedExtension,
    #[error("identity signature does not verify")]
    BadSignature,
}

/// Find the identity extension payload in a DER certificate: locate the OID, then read the
/// OCTET STRING that follows (unwrapping one nested OCTET STRING layer if present).
fn extract_identity_extension(der: &[u8]) -> Option<Vec<u8>> {
    let oid = encode_oid_der(IDENTITY_EXTENSION_OID);
    let pos = find_subslice(der, &oid)?;
    let after = &der[pos + oid.len()..];
    let content = first_octet_string(after)?;
    // Extension values are themselves wrapped in an OCTET STRING by rcgen: if the content
    // starts another OCTET STRING, unwrap it.
    if !content.is_empty() && content[0] == 0x04 {
        let inner = first_octet_string(content)?;
        Some(inner.to_vec())
    } else {
        Some(content.to_vec())
    }
}

/// Payload of the first OCTET STRING (tag 0x04) in `der`, scanning only the header area.
fn first_octet_string(der: &[u8]) -> Option<&[u8]> {
    for i in 0..der.len().saturating_sub(1) {
        if der[i] != 0x04 {
            if i > 64 {
                break;
            }
            continue;
        }
        let first_len = *der.get(i + 1)? as usize;
        let (header, content_len) = if first_len & 0x80 == 0 {
            (2usize, first_len)
        } else {
            let n = first_len & 0x7f;
            if n == 0 || n > 4 {
                continue;
            }
            let mut len = 0usize;
            for j in 0..n {
                len = (len << 8) | *der.get(i + 2 + j)? as usize;
            }
            (2 + n, len)
        };
        let end = i + header + content_len;
        if end <= der.len() {
            return Some(&der[i + header..end]);
        }
    }
    None
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn encode_oid_der(oid: &[u64]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut iter = oid.iter();
    let first = iter.next().copied().unwrap_or(0) * 40 + iter.next().copied().unwrap_or(0);
    encode_base128(&mut out, first);
    for &arc in iter {
        encode_base128(&mut out, arc);
    }
    out
}

fn encode_base128(out: &mut Vec<u8>, mut value: u64) {
    let mut stack = [0u8; 10];
    let mut n = 0;
    loop {
        stack[n] = (value & 0x7f) as u8;
        n += 1;
        value >>= 7;
        if value == 0 {
            break;
        }
    }
    while n > 0 {
        n -= 1;
        let mut byte = stack[n];
        if n > 0 {
            byte |= 0x80;
        }
        out.push(byte);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn certificate_round_trip() {
        let secret = [7u8; 32];
        let cert = generate_certificate(&secret).unwrap();
        let certs = [rustls_pki_types::CertificateDer::from(cert.cert_der)];
        let peer = verify_peer(&certs).unwrap();
        assert_eq!(
            peer.endpoint_id,
            switchback_proto::endpoint_id_from_bytes(&ed25519_public_key(&secret))
        );
    }

    #[test]
    fn reject_tampered_extension() {
        let secret = [7u8; 32];
        let cert = generate_certificate(&secret).unwrap();
        let mut der = cert.cert_der.clone();
        // Flip a bit inside the identity signature region (search near the OID).
        let oid = encode_oid_der(IDENTITY_EXTENSION_OID);
        let pos = find_subslice(&der, &oid).unwrap();
        der[pos + oid.len() + 40] ^= 0x01;
        let certs = [rustls_pki_types::CertificateDer::from(der)];
        assert!(verify_peer(&certs).is_err());
    }

    #[test]
    fn distinct_keys_claim_distinct_ids() {
        let a = generate_certificate(&[1u8; 32]).unwrap();
        let b = generate_certificate(&[2u8; 32]).unwrap();
        let pa = verify_peer(&[rustls_pki_types::CertificateDer::from(a.cert_der)]).unwrap();
        let pb = verify_peer(&[rustls_pki_types::CertificateDer::from(b.cert_der)]).unwrap();
        assert_ne!(pa.endpoint_id, pb.endpoint_id);
    }
}
