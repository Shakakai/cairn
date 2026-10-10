//! z-base-32 EndpointId text form (docs/01 §3.2, docs/02): Zooko's human-oriented base-32 —
//! alphabet below, bits consumed least-significant-bit first within each byte, unpadded.
//! 32 bytes encode to 52 characters; the last carries a single bit.

/// z-base-32 alphabet.
pub const ZBASE32_ALPHABET: &[u8; 32] = b"ybndrfg8ejkmcpqxot1uwisza345h769";
/// z-base-32 text length of a 32-byte key.
pub const ENDPOINT_ID_LENGTH: usize = 52;
/// Byte length of an Ed25519 public key.
pub const ENDPOINT_KEY_LENGTH: usize = 32;

fn decode_value(code: u8) -> Option<u8> {
    match code {
        b'y' => Some(0),
        b'b' => Some(1),
        b'n' => Some(2),
        b'd' => Some(3),
        b'r' => Some(4),
        b'f' => Some(5),
        b'g' => Some(6),
        b'8' => Some(7),
        b'e' => Some(8),
        b'j' => Some(9),
        b'k' => Some(10),
        b'm' => Some(11),
        b'c' => Some(12),
        b'p' => Some(13),
        b'q' => Some(14),
        b'x' => Some(15),
        b'o' => Some(16),
        b't' => Some(17),
        b'1' => Some(18),
        b'u' => Some(19),
        b'w' => Some(20),
        b'i' => Some(21),
        b's' => Some(22),
        b'z' => Some(23),
        b'a' => Some(24),
        b'3' => Some(25),
        b'4' => Some(26),
        b'5' => Some(27),
        b'h' => Some(28),
        b'7' => Some(29),
        b'6' => Some(30),
        b'9' => Some(31),
        _ => None,
    }
}

/// Error returned for malformed z-base-32 input.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyParseError {
    #[error("endpoint id: character not in z-base-32 alphabet")]
    InvalidCharacter,
    #[error("endpoint id: must be 52 characters")]
    InvalidLength,
    #[error("endpoint id: non-canonical trailing bits")]
    NonCanonical,
}

/// Encode 32 key bytes to their canonical z-base-32 EndpointId.
pub fn endpoint_id_from_bytes(bytes: &[u8; 32]) -> String {
    let mut out = String::with_capacity(ENDPOINT_ID_LENGTH);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for &byte in bytes.iter() {
        buffer |= u32::from(byte) << bits;
        bits += 8;
        while bits >= 5 {
            out.push(ZBASE32_ALPHABET[(buffer & 0x1f) as usize] as char);
            buffer >>= 5;
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(ZBASE32_ALPHABET[(buffer & 0x1f) as usize] as char);
    }
    out
}

/// Decode a z-base-32 EndpointId to key bytes.
pub fn endpoint_id_to_bytes(id: &str) -> Result<[u8; 32], KeyParseError> {
    if id.len() != ENDPOINT_ID_LENGTH {
        return Err(KeyParseError::InvalidLength);
    }
    let mut out = [0u8; 32];
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    let mut written = 0usize;
    for &code in id.as_bytes() {
        let value = decode_value(code).ok_or(KeyParseError::InvalidCharacter)?;
        buffer |= u32::from(value) << bits;
        bits += 5;
        if bits >= 8 {
            if written >= ENDPOINT_KEY_LENGTH {
                return Err(KeyParseError::InvalidLength);
            }
            out[written] = (buffer & 0xff) as u8;
            written += 1;
            buffer >>= 8;
            bits -= 8;
        }
    }
    if written != ENDPOINT_KEY_LENGTH || (bits > 0 && buffer != 0) {
        return Err(KeyParseError::NonCanonical);
    }
    Ok(out)
}

/// True iff `id` decodes as a canonical EndpointId.
pub fn is_valid_endpoint_id(id: &str) -> bool {
    endpoint_id_to_bytes(id).is_ok()
}

/// True iff `bytes` is a usable endpoint key: a valid, canonical, non-small-order Ed25519
/// point (doc 01 §3.2 check 3 and §4.2 dst rule).
pub fn is_valid_endpoint_key(bytes: &[u8; 32]) -> bool {
    use ed25519_dalek::VerifyingKey;
    match VerifyingKey::from_bytes(bytes) {
        Ok(key) => !key.is_weak(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn z32_fixed_vectors() {
        assert_eq!(endpoint_id_from_bytes(&[0u8; 32]), "y".repeat(52));
        assert_eq!(endpoint_id_from_bytes(&[0xffu8; 32]), format!("{}b", "9".repeat(51)));
    }

    #[test]
    fn z32_round_trip() {
        let bytes = [0xabu8; 32];
        let id = endpoint_id_from_bytes(&bytes);
        assert_eq!(id.len(), 52);
        assert_eq!(endpoint_id_to_bytes(&id).unwrap(), bytes);
        assert!(is_valid_endpoint_id(&id));
        assert!(!is_valid_endpoint_id(&id.to_uppercase()));
        assert!(!is_valid_endpoint_id(&id[..51]));
        // Corrupt one character: must fail to decode (or decode to a different key, never panic).
        let mut bad = id.into_bytes();
        bad[0] = b'0';
        let _ = endpoint_id_to_bytes(std::str::from_utf8(&bad).unwrap());
    }
}
