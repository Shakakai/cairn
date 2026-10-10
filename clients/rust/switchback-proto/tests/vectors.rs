//! The shared protocol vectors (docs/08 §1), consumed from the same JSON files as the
//! TypeScript `@cairn/core` suite. Both implementations must pass every case, both directions.

use serde_json::Value;
use switchback_proto::auth::{create_auth_blob, derive_auth_message_key, verify_auth_blob};
use switchback_proto::crypto::ed25519_public_key;
use switchback_proto::endpoint_id_from_bytes;
use switchback_proto::frames::{
    decode_client_frame, decode_relay_frame, encode, forward_transform, ClientFrame, FrameError,
    FrameType, RelayFrame,
};

fn vectors_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join("packages/core/test/vectors")
}

fn load(name: &str) -> Value {
    let path = vectors_dir().join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap()
}

fn unhex(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2));
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn arr32(v: &Value) -> [u8; 32] {
    unhex(v.as_str().unwrap()).try_into().unwrap()
}

fn frame_error_code(result: Result<ClientFrame, FrameError>) -> u16 {
    result.unwrap_err().code
}

#[test]
fn blake3_parity() {
    let auth = load("auth.json");
    let p = &auth["blake3_parity"];
    let material = unhex(p["key_material_hex"].as_str().unwrap());
    let key = derive_auth_message_key(&material);
    let expected = p["expected_key_hex"].as_str().unwrap();
    assert_eq!(hex(&key), expected);
    assert_eq!(expected, "31f4b855e7853ca9cd7425ce3b3651246683de3a1927a097b9e3a2a15c80509a");
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn auth_create_case() {
    let auth = load("auth.json");
    let c = &auth["create"];
    let seed: [u8; 32] = unhex(c["secret_seed_hex"].as_str().unwrap()).try_into().unwrap();
    let endpoint: [u8; 32] = unhex(c["endpoint_hex"].as_str().unwrap()).try_into().unwrap();
    let nonce: [u8; 16] = unhex(c["nonce_hex"].as_str().unwrap()).try_into().unwrap();
    let ts = c["timestamp_ms"].as_u64().unwrap();

    assert_eq!(ed25519_public_key(&seed), endpoint);
    assert_eq!(endpoint_id_from_bytes(&endpoint), c["endpoint_id"].as_str().unwrap());

    let blob = create_auth_blob(&seed, c["host"].as_str().unwrap(), &endpoint, ts, &nonce);
    assert_eq!(hex(&blob), c["blob_hex"].as_str().unwrap());

    let verified = verify_auth_blob(&blob, c["host"].as_str().unwrap(), ts, 60_000).unwrap();
    assert_eq!(verified.endpoint_bytes, endpoint);
}

#[test]
fn auth_verify_cases() {
    let auth = load("auth.json");
    for case in auth["verify"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let blob = unhex(case["blob_hex"].as_str().unwrap());
        let host = case["host"].as_str().unwrap();
        let now = case["now_ms"].as_u64().unwrap();
        let skew = case["skew_ms"].as_u64().unwrap();
        let result = verify_auth_blob(&blob, host, now, skew);
        let expected = case["expected"].as_str().unwrap();
        match expected {
            "ok" => assert!(result.is_ok(), "{name}: expected ok, got {result:?}"),
            reason => {
                let err = result.err().unwrap_or_else(|| panic!("{name}: expected {reason}, got ok"));
                assert_eq!(format!("{err}"), reason, "{name}");
            }
        }
    }
}

#[test]
fn frames_valid_cases() {
    let frames = load("frames.json");
    for case in frames["valid"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let bytes = unhex(case["frame_hex"].as_str().unwrap());
        let d = &case["decoded"];
        match d["type"].as_str().unwrap() {
            "send" => match decode_client_frame(&bytes).unwrap() {
                ClientFrame::Send { dst, ecn, datagram } => {
                    assert_eq!(hex(&dst), d["dst"].as_str().unwrap(), "{name}");
                    assert_eq!(ecn, d["ecn"].as_u64().unwrap() as u8, "{name}");
                    assert_eq!(hex(&datagram), d["datagram_hex"].as_str().unwrap(), "{name}");
                }
                other => panic!("{name}: {other:?}"),
            },
            "sendBatch" => match decode_client_frame(&bytes).unwrap() {
                ClientFrame::SendBatch { dst, ecn, segment_size, datagrams } => {
                    assert_eq!(hex(&dst), d["dst"].as_str().unwrap(), "{name}");
                    assert_eq!(ecn, d["ecn"].as_u64().unwrap() as u8, "{name}");
                    assert_eq!(segment_size, d["segment_size"].as_u64().unwrap() as u16, "{name}");
                    assert_eq!(hex(&datagrams), d["datagrams_hex"].as_str().unwrap(), "{name}");
                }
                other => panic!("{name}: {other:?}"),
            },
            "recv" => {
                assert_eq!(
                    decode_relay_frame(&bytes).unwrap(),
                    RelayFrame::Recv {
                        src: arr32(&d["src"]),
                        ecn: d["ecn"].as_u64().unwrap() as u8,
                        datagram: unhex(d["datagram_hex"].as_str().unwrap()),
                    },
                    "{name}"
                );
                let re = encode::recv(
                    &arr32(&d["src"]),
                    d["ecn"].as_u64().unwrap() as u8,
                    &unhex(d["datagram_hex"].as_str().unwrap()),
                );
                assert_eq!(hex(&re), case["frame_hex"].as_str().unwrap(), "{name} re-encode");
            }
            "recvBatch" => {
                assert_eq!(
                    decode_relay_frame(&bytes).unwrap(),
                    RelayFrame::RecvBatch {
                        src: arr32(&d["src"]),
                        ecn: d["ecn"].as_u64().unwrap() as u8,
                        segment_size: d["segment_size"].as_u64().unwrap() as u16,
                        datagrams: unhex(d["datagrams_hex"].as_str().unwrap()),
                    },
                    "{name}"
                );
            }
            "peerGone" => {
                assert_eq!(
                    decode_relay_frame(&bytes).unwrap(),
                    RelayFrame::PeerGone { peer: arr32(&d["peer"]) },
                    "{name}"
                );
                assert_eq!(hex(&encode::peer_gone(&arr32(&d["peer"]))), case["frame_hex"].as_str().unwrap());
            }
            "status" => {
                assert_eq!(
                    decode_relay_frame(&bytes).unwrap(),
                    RelayFrame::Status { code: d["code"].as_u64().unwrap() as u8 },
                    "{name}"
                );
                assert_eq!(hex(&encode::status(d["code"].as_u64().unwrap() as u8)), case["frame_hex"].as_str().unwrap());
            }
            "restarting" => {
                assert_eq!(
                    decode_relay_frame(&bytes).unwrap(),
                    RelayFrame::Restarting {
                        reconnect_in_ms: d["reconnect_in_ms"].as_u64().unwrap() as u32,
                        try_for_ms: d["try_for_ms"].as_u64().unwrap() as u32,
                    },
                    "{name}"
                );
                assert_eq!(
                    hex(&encode::restarting(
                        d["reconnect_in_ms"].as_u64().unwrap() as u32,
                        d["try_for_ms"].as_u64().unwrap() as u32
                    )),
                    case["frame_hex"].as_str().unwrap()
                );
            }
            "serverInfo" => {
                assert_eq!(
                    decode_relay_frame(&bytes).unwrap(),
                    RelayFrame::ServerInfo {
                        max_payload: d["max_payload"].as_u64().unwrap() as u32,
                        max_conn_age_s: d["max_conn_age_s"].as_u64().unwrap() as u32,
                        region: d["region"].as_str().unwrap().to_string(),
                        conn_id: d["conn_id"].as_str().unwrap().to_string(),
                    },
                    "{name}"
                );
                assert_eq!(
                    hex(&encode::server_info(
                        d["max_payload"].as_u64().unwrap() as u32,
                        d["max_conn_age_s"].as_u64().unwrap() as u32,
                        d["region"].as_str().unwrap(),
                        d["conn_id"].as_str().unwrap()
                    )),
                    case["frame_hex"].as_str().unwrap()
                );
            }
            other => panic!("{name}: unknown vector type {other}"),
        }
    }
}

#[test]
fn frames_invalid_cases() {
    let frames = load("frames.json");
    for case in frames["invalid"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let bytes = unhex(case["frame_hex"].as_str().unwrap());
        let code = case["expected_error"]["code"].as_u64().unwrap() as u16;
        assert_eq!(frame_error_code(decode_client_frame(&bytes)), code, "{name}");
    }
}

#[test]
fn transform_cases() {
    let transform = load("transform.json");
    for case in transform["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let client = unhex(case["client_frame_hex"].as_str().unwrap());
        let src: [u8; 32] = unhex(case["src_key_hex"].as_str().unwrap()).try_into().unwrap();
        let out = forward_transform(&client, &src).unwrap();
        assert_eq!(hex(&out), case["expected_hex"].as_str().unwrap(), "{name}");
    }
}

#[test]
fn server_info_cases() {
    let si = load("server_info.json");
    for case in si["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let bytes = unhex(case["frame_hex"].as_str().unwrap());
        let d = &case["decoded"];
        assert_eq!(
            decode_relay_frame(&bytes).unwrap(),
            RelayFrame::ServerInfo {
                max_payload: d["max_payload"].as_u64().unwrap() as u32,
                max_conn_age_s: d["max_conn_age_s"].as_u64().unwrap() as u32,
                region: d["region"].as_str().unwrap().to_string(),
                conn_id: d["conn_id"].as_str().unwrap().to_string(),
            },
            "{name}"
        );
    }
}

#[test]
fn frame_type_constants_match_doc_01() {
    assert_eq!(FrameType::SERVER_INFO, 0x01);
    assert_eq!(FrameType::SEND, 0x02);
    assert_eq!(FrameType::SEND_BATCH, 0x03);
    assert_eq!(FrameType::RECV, 0x04);
    assert_eq!(FrameType::RECV_BATCH, 0x05);
    assert_eq!(FrameType::PEER_GONE, 0x06);
    assert_eq!(FrameType::STATUS, 0x07);
    assert_eq!(FrameType::RESTARTING, 0x08);
}
