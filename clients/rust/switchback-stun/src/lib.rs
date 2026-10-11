//! RFC 5389 STUN (docs/09-C5, ADR-004): Binding Request/Response with
//! XOR-MAPPED-ADDRESS, sent from the endpoint's own UDP socket. Used for reflexive
//! address discovery in candidate exchange (M7).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// STUN magic cookie (RFC 5389 §6).
pub const MAGIC_COOKIE: u32 = 0x2112_A442;
/// BINDING-REQUEST / BINDING-RESPONSE message types.
pub const MSG_BINDING_REQUEST: u16 = 0x0001;
pub const MSG_BINDING_RESPONSE: u16 = 0x0101;
/// XOR-MAPPED-ADDRESS attribute type.
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;

/// A discovered reflexive address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MappedAddress {
    pub addr: SocketAddr,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum StunError {
    #[error("message too short for a STUN header")]
    TooShort,
    #[error("not a STUN message (first bits or magic cookie)")]
    NotStun,
    #[error("unexpected message type 0x{0:04x}")]
    UnexpectedType(u16),
    #[error("transaction id mismatch")]
    TransactionMismatch,
    #[error("malformed attribute {0:#06x}")]
    MalformedAttribute(u16),
    #[error("no XOR-MAPPED-ADDRESS in the response")]
    NoMappedAddress,
    #[error("unsupported address family {0}")]
    UnsupportedFamily(u8),
}

/// True if `bytes` looks like a STUN message (first two bits 0, magic cookie at 4..8).
/// Used to demultiplex STUN from QUIC on the endpoint's UDP socket (docs/09-C5).
pub fn is_stun_message(bytes: &[u8]) -> bool {
    bytes.len() >= 20 && bytes[0] & 0b1100_0000 == 0 && u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) == MAGIC_COOKIE
}

/// Build a Binding Request with the given transaction id.
pub fn binding_request(transaction_id: [u8; 12]) -> Vec<u8> {
    let mut out = Vec::with_capacity(20);
    out.extend_from_slice(&MSG_BINDING_REQUEST.to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes()); // no attributes
    out.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
    out.extend_from_slice(&transaction_id);
    out
}

/// Parse a Binding Response and extract XOR-MAPPED-ADDRESS.
pub fn parse_binding_response(bytes: &[u8], expected_transaction: [u8; 12]) -> Result<MappedAddress, StunError> {
    if bytes.len() < 20 {
        return Err(StunError::TooShort);
    }
    if !is_stun_message(bytes) {
        return Err(StunError::NotStun);
    }
    let msg_type = u16::from_be_bytes([bytes[0], bytes[1]]);
    if msg_type != MSG_BINDING_RESPONSE {
        return Err(StunError::UnexpectedType(msg_type));
    }
    if bytes[8..20] != expected_transaction {
        return Err(StunError::TransactionMismatch);
    }
    let length = u16::from_be_bytes([bytes[2], bytes[3]]) as usize;
    if bytes.len() < 20 + length {
        return Err(StunError::TooShort);
    }
    // Walk attributes.
    let mut pos = 20;
    let end = 20 + length;
    while pos + 4 <= end {
        let attr_type = u16::from_be_bytes([bytes[pos], bytes[pos + 1]]);
        let attr_len = u16::from_be_bytes([bytes[pos + 2], bytes[pos + 3]]) as usize;
        let value_start = pos + 4;
        if value_start + attr_len > end {
            return Err(StunError::MalformedAttribute(attr_type));
        }
        if attr_type == ATTR_XOR_MAPPED_ADDRESS {
            return parse_xor_mapped(&bytes[value_start..value_start + attr_len], &expected_transaction);
        }
        // Attributes are padded to 4-byte boundaries.
        pos = value_start + attr_len.div_ceil(4) * 4;
    }
    Err(StunError::NoMappedAddress)
}

fn parse_xor_mapped(value: &[u8], transaction: &[u8; 12]) -> Result<MappedAddress, StunError> {
    if value.len() < 4 {
        return Err(StunError::MalformedAttribute(ATTR_XOR_MAPPED_ADDRESS));
    }
    let family = value[1];
    let port = u16::from_be_bytes([value[2], value[3]]) ^ (MAGIC_COOKIE as u16);
    match family {
        0x01 => {
            if value.len() < 8 {
                return Err(StunError::MalformedAttribute(ATTR_XOR_MAPPED_ADDRESS));
            }
            let xaddr = u32::from_be_bytes([value[4], value[5], value[6], value[7]]);
            let addr = Ipv4Addr::from(xaddr ^ MAGIC_COOKIE);
            Ok(MappedAddress {
                addr: SocketAddr::new(IpAddr::V4(addr), port),
            })
        }
        0x02 => {
            if value.len() < 20 {
                return Err(StunError::MalformedAttribute(ATTR_XOR_MAPPED_ADDRESS));
            }
            let mut raw = [0u8; 16];
            raw.copy_from_slice(&value[4..20]);
            let mut mask = Vec::with_capacity(16);
            mask.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
            mask.extend_from_slice(transaction);
            for (byte, mask_byte) in raw.iter_mut().zip(mask) {
                *byte ^= mask_byte;
            }
            let addr = Ipv6Addr::from(raw);
            Ok(MappedAddress {
                addr: SocketAddr::new(IpAddr::V6(addr), port),
            })
        }
        other => Err(StunError::UnsupportedFamily(other)),
    }
}

/// Send a Binding Request from `socket` to `server` and wait for the response.
/// `socket` must be connected or unconnected; this uses send_to/recv_from so either
/// works. Returns the discovered reflexive address.
pub async fn bind(
    socket: &tokio::net::UdpSocket,
    server: SocketAddr,
    timeout: std::time::Duration,
) -> Result<MappedAddress, BindError> {
    let mut transaction = [0u8; 12];
    getrandom::getrandom(&mut transaction).map_err(|e| BindError::Io(e.to_string()))?;
    let request = binding_request(transaction);
    socket.send_to(&request, server).await.map_err(|e| BindError::Io(e.to_string()))?;

    let mut buf = [0u8; 512];
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(BindError::Timeout);
        }
        let (len, from) = tokio::time::timeout(remaining, socket.recv_from(&mut buf))
            .await
            .map_err(|_| BindError::Timeout)?
            .map_err(|e| BindError::Io(e.to_string()))?;
        if from != server || !is_stun_message(&buf[..len]) {
            continue; // not our STUN response (e.g. a QUIC datagram)
        }
        if let Ok(mapped) = parse_binding_response(&buf[..len], transaction) {
            return Ok(mapped);
        }
        // A STUN response from our server with a different transaction: keep waiting.
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BindError {
    #[error("io: {0}")]
    Io(String),
    #[error("timed out waiting for the STUN response")]
    Timeout,
}

#[cfg(test)]
mod tests {
    use super::*;

    const TX: [u8; 12] = *b"abcdefghijkl";

    #[test]
    fn request_layout() {
        let req = binding_request(TX);
        assert_eq!(req.len(), 20);
        assert_eq!(&req[0..2], &MSG_BINDING_REQUEST.to_be_bytes());
        assert_eq!(&req[4..8], &MAGIC_COOKIE.to_be_bytes());
        assert_eq!(&req[8..20], &TX);
        assert!(is_stun_message(&req));
    }

    #[test]
    fn response_ipv4() {
        let port: u16 = 54321;
        let ip = Ipv4Addr::new(203, 0, 113, 7);
        let mut response = Vec::new();
        response.extend_from_slice(&MSG_BINDING_RESPONSE.to_be_bytes());
        // attribute: 4 header + 8 value = 12 bytes
        response.extend_from_slice(&12u16.to_be_bytes());
        response.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        response.extend_from_slice(&TX);
        response.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        response.extend_from_slice(&8u16.to_be_bytes());
        response.push(0);
        response.push(0x01);
        response.extend_from_slice(&(port ^ (MAGIC_COOKIE as u16)).to_be_bytes());
        response.extend_from_slice(&(u32::from(ip) ^ MAGIC_COOKIE).to_be_bytes());

        let mapped = parse_binding_response(&response, TX).unwrap();
        assert_eq!(mapped.addr, SocketAddr::new(IpAddr::V4(ip), port));
    }

    #[test]
    fn response_ipv6() {
        let port: u16 = 4433;
        let ip = Ipv6Addr::LOCALHOST;
        let mut xaddr = ip.octets();
        let mut mask = Vec::new();
        mask.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        mask.extend_from_slice(&TX);
        for (b, m) in xaddr.iter_mut().zip(mask) {
            *b ^= m;
        }
        let mut response = Vec::new();
        response.extend_from_slice(&MSG_BINDING_RESPONSE.to_be_bytes());
        response.extend_from_slice(&24u16.to_be_bytes());
        response.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        response.extend_from_slice(&TX);
        response.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        response.extend_from_slice(&20u16.to_be_bytes());
        response.push(0);
        response.push(0x02);
        response.extend_from_slice(&(port ^ (MAGIC_COOKIE as u16)).to_be_bytes());
        response.extend_from_slice(&xaddr);

        let mapped = parse_binding_response(&response, TX).unwrap();
        assert_eq!(mapped.addr, SocketAddr::new(IpAddr::V6(ip), port));
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse_binding_response(&[], TX), Err(StunError::TooShort));
        assert_eq!(parse_binding_response(&[0xff; 30], TX), Err(StunError::NotStun));
        let mut wrong_tx = binding_request(TX);
        wrong_tx[0..2].copy_from_slice(&MSG_BINDING_RESPONSE.to_be_bytes());
        assert_eq!(parse_binding_response(&wrong_tx, *b"xxxxxxxxxxxx"), Err(StunError::TransactionMismatch));
    }

    #[test]
    fn demux_header_check() {
        assert!(!is_stun_message(&[]));
        assert!(!is_stun_message(&[0xc0; 20])); // QUIC short header has high bits set
        let quic_long = [0xc3u8; 20]; // QUIC long header
        assert!(!is_stun_message(&quic_long));
    }
}
