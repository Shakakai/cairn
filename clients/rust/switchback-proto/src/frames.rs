//! Frame codec for Switchback v1 (doc 01 §4): the eight binary frame types, client-frame
//! validation with close codes, and the relay's byte-rewriting forward transform.
//! Mirrors `@cairn/core/src/frames.ts`.

use crate::keys::is_valid_endpoint_key;

/// Frame type bytes (doc 01 §4.1).
pub mod frame_type {
    pub const SERVER_INFO: u8 = 0x01;
    pub const SEND: u8 = 0x02;
    pub const SEND_BATCH: u8 = 0x03;
    pub const RECV: u8 = 0x04;
    pub const RECV_BATCH: u8 = 0x05;
    pub const PEER_GONE: u8 = 0x06;
    pub const STATUS: u8 = 0x07;
    pub const RESTARTING: u8 = 0x08;
}

/// Alias for the type-byte namespace, mirroring the TS `FrameType` object.
pub use frame_type as FrameType;

/// Largest Send/SendBatch payload the relay accepts (doc 01 §9).
pub const MAX_FRAME_PAYLOAD: usize = 65_536;
/// Largest WebSocket message; enforced by adapters at the socket layer (doc 01 §9).
pub const MAX_WEBSOCKET_MESSAGE: usize = 1 << 20;

/// Frame decode failure carrying the WebSocket close code (doc 01 §8).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("frame error (close {code}): {reason}")]
pub struct FrameError {
    pub code: u16,
    pub reason: &'static str,
}

impl FrameError {
    const fn protocol(reason: &'static str) -> Self {
        FrameError { code: 1002, reason }
    }
    const fn too_big(reason: &'static str) -> Self {
        FrameError { code: 1009, reason }
    }
}

/// A validated client→relay frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientFrame {
    Send {
        dst: [u8; 32],
        ecn: u8,
        /// Payload bytes after `dst ‖ ecn`; may be empty (doc 01 §4.2).
        datagram: Vec<u8>,
    },
    SendBatch {
        dst: [u8; 32],
        ecn: u8,
        segment_size: u16,
        /// All segment bytes back to back; the last segment may be shorter.
        datagrams: Vec<u8>,
    },
}

/// A decoded relay→client frame. Unknown types are tolerated (clients ignore them, doc 01 §1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayFrame {
    ServerInfo {
        max_payload: u32,
        max_conn_age_s: u32,
        region: String,
        conn_id: String,
    },
    Recv {
        src: [u8; 32],
        ecn: u8,
        datagram: Vec<u8>,
    },
    RecvBatch {
        src: [u8; 32],
        ecn: u8,
        segment_size: u16,
        datagrams: Vec<u8>,
    },
    PeerGone {
        peer: [u8; 32],
    },
    Status {
        code: u8,
    },
    Restarting {
        reconnect_in_ms: u32,
        try_for_ms: u32,
    },
    Unknown {
        frame_type: u8,
    },
}

fn read_dst(payload: &[u8]) -> Result<[u8; 32], FrameError> {
    let dst: [u8; 32] = payload[..32].try_into().expect("length checked by caller");
    if !is_valid_endpoint_key(&dst) {
        return Err(FrameError::protocol("dst is not a valid Ed25519 key"));
    }
    Ok(dst)
}

fn read_ecn(payload: &[u8], offset: usize) -> Result<u8, FrameError> {
    let ecn = payload[offset];
    if ecn > 3 {
        return Err(FrameError::protocol("ecn must be 0..3"));
    }
    Ok(ecn)
}

/// Validate and decode a client→relay frame (doc 01 §4.1–4.2).
pub fn decode_client_frame(bytes: &[u8]) -> Result<ClientFrame, FrameError> {
    let Some((&frame_type, payload)) = bytes.split_first() else {
        return Err(FrameError::protocol("empty frame"));
    };
    if frame_type != frame_type::SEND && frame_type != frame_type::SEND_BATCH {
        return Err(FrameError::protocol("unexpected client frame type"));
    }
    if payload.len() > MAX_FRAME_PAYLOAD {
        return Err(FrameError::too_big("payload exceeds 65536"));
    }

    if frame_type == frame_type::SEND {
        if payload.len() < 33 {
            return Err(FrameError::protocol("Send payload must be at least 33 bytes"));
        }
        return Ok(ClientFrame::Send {
            dst: read_dst(payload)?,
            ecn: read_ecn(payload, 32)?,
            datagram: payload[33..].to_vec(),
        });
    }

    if payload.len() < 35 {
        return Err(FrameError::protocol("SendBatch payload must be at least 35 bytes"));
    }
    let segment_size = u16::from_be_bytes([payload[33], payload[34]]);
    if segment_size == 0 {
        return Err(FrameError::protocol("segment_size must be >= 1"));
    }
    Ok(ClientFrame::SendBatch {
        dst: read_dst(payload)?,
        ecn: read_ecn(payload, 32)?,
        segment_size,
        datagrams: payload[35..].to_vec(),
    })
}

/// The relay's forwarding rewrite (doc 01 §4.3): `Send→Recv`, `SendBatch→RecvBatch`, dst key
/// replaced by the sender's key.
pub fn forward_transform(bytes: &[u8], src: &[u8; 32]) -> Result<Vec<u8>, FrameError> {
    let frame = decode_client_frame(bytes)?; // validates fully
    let out_type = match frame {
        ClientFrame::Send { .. } => frame_type::RECV,
        ClientFrame::SendBatch { .. } => frame_type::RECV_BATCH,
    };
    let mut out = Vec::with_capacity(bytes.len());
    out.push(out_type);
    out.extend_from_slice(src);
    out.extend_from_slice(&bytes[33..]); // dst(32) + ecn(1) line up after the type rewrite
    Ok(out)
}

// ---------------------------------------------------------------------------
// Relay → client encoding
// ---------------------------------------------------------------------------

/// Encoders for the relay→client frame types.
pub mod encode {
    use super::frame_type;

    pub fn server_info(max_payload: u32, max_conn_age_s: u32, region: &str, conn_id: &str) -> Vec<u8> {
        let region = region.as_bytes();
        let conn_id = conn_id.as_bytes();
        assert!(region.len() <= 255 && conn_id.len() <= 255, "region/conn_id too long");
        let mut out = Vec::with_capacity(1 + 4 + 4 + 1 + region.len() + 1 + conn_id.len());
        out.push(frame_type::SERVER_INFO);
        out.extend_from_slice(&max_payload.to_be_bytes());
        out.extend_from_slice(&max_conn_age_s.to_be_bytes());
        out.push(region.len() as u8);
        out.extend_from_slice(region);
        out.push(conn_id.len() as u8);
        out.extend_from_slice(conn_id);
        out
    }

    pub fn recv(src: &[u8; 32], ecn: u8, datagram: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(1 + 32 + 1 + datagram.len());
        out.push(frame_type::RECV);
        out.extend_from_slice(src);
        out.push(ecn);
        out.extend_from_slice(datagram);
        out
    }

    pub fn recv_batch(src: &[u8; 32], ecn: u8, segment_size: u16, datagrams: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(1 + 32 + 1 + 2 + datagrams.len());
        out.push(frame_type::RECV_BATCH);
        out.extend_from_slice(src);
        out.push(ecn);
        out.extend_from_slice(&segment_size.to_be_bytes());
        out.extend_from_slice(datagrams);
        out
    }

    pub fn peer_gone(peer: &[u8; 32]) -> Vec<u8> {
        let mut out = Vec::with_capacity(33);
        out.push(frame_type::PEER_GONE);
        out.extend_from_slice(peer);
        out
    }

    pub fn status(code: u8) -> Vec<u8> {
        vec![frame_type::STATUS, code]
    }

    pub fn restarting(reconnect_in_ms: u32, try_for_ms: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity(9);
        out.push(frame_type::RESTARTING);
        out.extend_from_slice(&reconnect_in_ms.to_be_bytes());
        out.extend_from_slice(&try_for_ms.to_be_bytes());
        out
    }
}

/// Decode a relay→client frame (docs 01 §4.4–4.6, tests and tools).
pub fn decode_relay_frame(bytes: &[u8]) -> Result<RelayFrame, FrameError> {
    let Some((&frame_type, payload)) = bytes.split_first() else {
        return Err(FrameError::protocol("empty frame"));
    };
    match frame_type {
        frame_type::SERVER_INFO => {
            if payload.len() < 9 {
                return Err(FrameError::protocol("ServerInfo truncated"));
            }
            let max_payload = u32::from_be_bytes(payload[0..4].try_into().unwrap());
            let max_conn_age_s = u32::from_be_bytes(payload[4..8].try_into().unwrap());
            let region_len = payload[8] as usize;
            if payload.len() < 9 + region_len + 1 {
                return Err(FrameError::protocol("ServerInfo region truncated"));
            }
            let region = String::from_utf8_lossy(&payload[9..9 + region_len]).into_owned();
            let conn_offset = 9 + region_len;
            let conn_id_len = payload[conn_offset] as usize;
            if payload.len() < conn_offset + 1 + conn_id_len {
                return Err(FrameError::protocol("ServerInfo conn_id truncated"));
            }
            let conn_id =
                String::from_utf8_lossy(&payload[conn_offset + 1..conn_offset + 1 + conn_id_len]).into_owned();
            Ok(RelayFrame::ServerInfo {
                max_payload,
                max_conn_age_s,
                region,
                conn_id,
            })
        }
        frame_type::RECV => {
            if payload.len() < 33 {
                return Err(FrameError::protocol("Recv payload must be at least 33 bytes"));
            }
            Ok(RelayFrame::Recv {
                src: payload[..32].try_into().unwrap(),
                ecn: payload[32],
                datagram: payload[33..].to_vec(),
            })
        }
        frame_type::RECV_BATCH => {
            if payload.len() < 35 {
                return Err(FrameError::protocol("RecvBatch payload must be at least 35 bytes"));
            }
            Ok(RelayFrame::RecvBatch {
                src: payload[..32].try_into().unwrap(),
                ecn: payload[32],
                segment_size: u16::from_be_bytes([payload[33], payload[34]]),
                datagrams: payload[35..].to_vec(),
            })
        }
        frame_type::PEER_GONE => {
            if payload.len() != 32 {
                return Err(FrameError::protocol("PeerGone payload must be exactly 32 bytes"));
            }
            Ok(RelayFrame::PeerGone {
                peer: payload[..32].try_into().unwrap(),
            })
        }
        frame_type::STATUS => {
            if payload.len() != 1 {
                return Err(FrameError::protocol("Status payload must be exactly 1 byte"));
            }
            Ok(RelayFrame::Status { code: payload[0] })
        }
        frame_type::RESTARTING => {
            if payload.len() != 8 {
                return Err(FrameError::protocol("Restarting payload must be exactly 8 bytes"));
            }
            Ok(RelayFrame::Restarting {
                reconnect_in_ms: u32::from_be_bytes(payload[0..4].try_into().unwrap()),
                try_for_ms: u32::from_be_bytes(payload[4..8].try_into().unwrap()),
            })
        }
        other => Ok(RelayFrame::Unknown { frame_type: other }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_a() -> [u8; 32] {
        let mut seed = [0u8; 32];
        for (i, b) in seed.iter_mut().enumerate() {
            *b = (i + 1) as u8;
        }
        crate::crypto::ed25519_public_key(&seed)
    }

    #[test]
    fn send_round_trip() {
        let key_a = key_a();
        let frame = decode_client_frame(&[&[frame_type::SEND][..], &key_a[..], &[0x02], b"hello"].concat())
            .unwrap();
        match frame {
            ClientFrame::Send { dst, ecn, datagram } => {
                assert_eq!(dst, key_a);
                assert_eq!(ecn, 2);
                assert_eq!(datagram, b"hello");
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn empty_datagram_allowed() {
        let key_a = key_a();
        let bytes = [&[frame_type::SEND][..], &key_a[..], &[0]].concat();
        match decode_client_frame(&bytes).unwrap() {
            ClientFrame::Send { datagram, .. } => assert!(datagram.is_empty()),
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn invalid_frames_close_codes() {
        let key_a = key_a();
        // Too short.
        let short = [&[frame_type::SEND][..], &key_a[..]].concat();
        assert_eq!(decode_client_frame(&short).unwrap_err().code, 1002);
        // Bad ecn.
        let bad_ecn = [&[frame_type::SEND][..], &key_a[..], &[4], b"x"].concat();
        assert_eq!(decode_client_frame(&bad_ecn).unwrap_err().code, 1002);
        // segment_size 0.
        let seg0 = [&[frame_type::SEND_BATCH][..], &key_a[..], &[0], &[0, 0], b"x"].concat();
        assert_eq!(decode_client_frame(&seg0).unwrap_err().code, 1002);
        // Oversize payload.
        let big = [
            &[frame_type::SEND][..],
            &key_a[..],
            &[0],
            &vec![0u8; MAX_FRAME_PAYLOAD - 31][..],
        ]
        .concat();
        assert_eq!(decode_client_frame(&big).unwrap_err().code, 1009);
        // Reserved type from client.
        assert_eq!(decode_client_frame(&[0x00]).unwrap_err().code, 1002);
        assert_eq!(decode_client_frame(&[0x09]).unwrap_err().code, 1002);
    }

    #[test]
    fn forward_transform_rewrites() {
        let key_a = key_a();
        let datagram = b"packet";
        let send = [&[frame_type::SEND][..], &key_a[..], &[3], &datagram[..]].concat();
        let out = forward_transform(&send, &key_a).unwrap();
        assert_eq!(out[0], frame_type::RECV);
        assert_eq!(&out[1..33], &key_a);
        assert_eq!(&out[33..], &send[33..]);

        let batch = [&[frame_type::SEND_BATCH][..], &key_a[..], &[1], &[0, 4], b"abcdefgh"].concat();
        let out = forward_transform(&batch, &key_a).unwrap();
        assert_eq!(out[0], frame_type::RECV_BATCH);
        assert_eq!(&out[1..36], &batch[1..36]);
        assert_eq!(&out[36..], b"abcdefgh");
    }

    #[test]
    fn relay_frames_round_trip() {
        let si = encode::server_info(65_536, 0, "iad", "conn-1");
        match decode_relay_frame(&si).unwrap() {
            RelayFrame::ServerInfo { max_payload, region, conn_id, .. } => {
                assert_eq!(max_payload, 65_536);
                assert_eq!(region, "iad");
                assert_eq!(conn_id, "conn-1");
            }
            other => panic!("unexpected frame: {other:?}"),
        }
        // Trailing bytes tolerated (doc 01 §4.4).
        let mut si_trailing = si.clone();
        si_trailing.extend_from_slice(&[0xde, 0xad]);
        assert!(matches!(decode_relay_frame(&si_trailing).unwrap(), RelayFrame::ServerInfo { .. }));

        assert!(matches!(
            decode_relay_frame(&encode::status(2)).unwrap(),
            RelayFrame::Status { code: 2 }
        ));
        assert!(matches!(
            decode_relay_frame(&encode::restarting(250, 10_000)).unwrap(),
            RelayFrame::Restarting { reconnect_in_ms: 250, try_for_ms: 10_000 }
        ));
        assert!(matches!(
            decode_relay_frame(&encode::peer_gone(&key_a())).unwrap(),
            RelayFrame::PeerGone { peer } if peer == key_a()
        ));
        assert!(matches!(
            decode_relay_frame(&[0x7f, 1, 2, 3]).unwrap(),
            RelayFrame::Unknown { frame_type: 0x7f }
        ));
    }
}
