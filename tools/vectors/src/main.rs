//! Generates the shared Switchback v1 test vectors (docs/08 §1) into
//! `packages/core/test/vectors/*.json`, using the Rust `switchback-proto` codec plus
//! hand-written edge cases. TypeScript (`@cairn/core`) and Rust both consume these files;
//! CI fails if regenerating changes any file without a matching spec change.
//!
//! Usage: `cargo run -p vectors -- --out packages/core/test/vectors`

use serde_json::{json, Value};
use switchback_proto::auth::{
    build_auth_message, create_auth_blob, decode_auth_blob, encode_auth_blob_b64,
    derive_auth_message_key, AUTH_BLOB_LENGTH,
};
use switchback_proto::crypto::ed25519_public_key;
use switchback_proto::frames::{decode_client_frame, encode, frame_type};
use switchback_proto::endpoint_id_from_bytes;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("valid hex"))
        .collect()
}

fn write_json(dir: &std::path::Path, name: &str, value: &Value) {
    let path = dir.join(name);
    let text = format!("{}\n", serde_json::to_string_pretty(value).unwrap());
    std::fs::write(&path, text).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
    println!("wrote {}", path.display());
}

/// Deterministic test identity: seed bytes 1..=32.
fn test_secret() -> [u8; 32] {
    let mut seed = [0u8; 32];
    for (i, b) in seed.iter_mut().enumerate() {
        *b = (i + 1) as u8;
    }
    seed
}

/// The 8 canonical small-order Ed25519 public key encodings (ZIP-215 test set). Strict
/// decoders either reject these as points or accept them as small-order; either way
/// verification must report `bad-key` (doc 01 §3.2 check 3 precedes check 4).
const SMALL_ORDER_KEYS: [&str; 8] = [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0100000000000000000000000000000000000000000000000000000000000000",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
];

// Ed25519 group order L; an S value of exactly L is non-canonical (S must be < L).
const GROUP_ORDER_LE: &str = "edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010";

const HOST: &str = "cairn.example.net";
const TIMESTAMP_MS: u64 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// auth.json
// ---------------------------------------------------------------------------

fn gen_auth() -> Value {
    let secret = test_secret();
    let endpoint = ed25519_public_key(&secret);
    let nonce: [u8; 16] = core::array::from_fn(|i| i as u8);
    let blob = create_auth_blob(&secret, HOST, &endpoint, TIMESTAMP_MS, &nonce);

    let mut verify: Vec<Value> = Vec::new();
    let mut case = |name: &str, blob_hex: String, host: &str, now_ms: u64, expected: &str| {
        verify.push(json!({
            "name": name,
            "blob_hex": blob_hex,
            "host": host,
            "now_ms": now_ms,
            "skew_ms": 60_000,
            "expected": expected,
        }));
    };

    let base = hex(&blob);
    case("valid", base.clone(), HOST, TIMESTAMP_MS, "ok");
    case("valid-query-auth", base.clone(), HOST, TIMESTAMP_MS, "ok"); // same blob via ?auth=
    case("skew-boundary-plus", base.clone(), HOST, TIMESTAMP_MS + 60_000, "ok");
    case("skew-boundary-minus", base.clone(), HOST, TIMESTAMP_MS - 60_000, "ok");
    case("stale-past", base.clone(), HOST, TIMESTAMP_MS + 60_001, "stale");
    case("stale-future", base.clone(), HOST, TIMESTAMP_MS - 60_001, "stale");

    // Signed for HOST but presented to another host: signature mismatch.
    case("wrong-host", base.clone(), "evil.example.net", TIMESTAMP_MS, "bad-signature");

    // Flip one bit in the signature.
    let mut bad_sig = blob;
    bad_sig[60] ^= 0x01;
    case("bad-signature", hex(&bad_sig), HOST, TIMESTAMP_MS, "bad-signature");

    // Non-canonical S = L.
    let mut noncanon = blob;
    let s_le = unhex(GROUP_ORDER_LE);
    noncanon[57..121].fill(0); // clear R and S
    noncanon[89..121].copy_from_slice(&s_le); // S := L (non-canonical)
    case("noncanonical-s", hex(&noncanon), HOST, TIMESTAMP_MS, "bad-signature");

    // Each small-order key substituted for the endpoint.
    for (i, key_hex) in SMALL_ORDER_KEYS.iter().enumerate() {
        let mut swapped = blob;
        swapped[1..33].copy_from_slice(&unhex(key_hex));
        case(&format!("small-order-{i}"), hex(&swapped), HOST, TIMESTAMP_MS, "bad-key");
    }

    // Structural failures.
    case("wrong-length", base[..base.len() - 2].to_string(), HOST, TIMESTAMP_MS, "malformed");
    let mut wrong_version = blob;
    wrong_version[0] = 0x02;
    case("wrong-version", hex(&wrong_version), HOST, TIMESTAMP_MS, "malformed");

    let mut parity_material = b"cairn.example.net".to_vec();
    parity_material.push(0x00);
    parity_material.extend_from_slice(&[0u8; 56]);
    let parity_key = derive_auth_message_key(&parity_material);

    json!({
        "version": 1,
        "blake3_parity": {
            "context": "switchback v1 connect auth",
            "key_material_hex": hex(&parity_material),
            "expected_key_hex": hex(&parity_key),
        },
        "create": {
            "secret_seed_hex": hex(&secret),
            "endpoint_hex": hex(&endpoint),
            "endpoint_id": endpoint_id_from_bytes(&endpoint),
            "host": HOST,
            "timestamp_ms": TIMESTAMP_MS,
            "nonce_hex": hex(&nonce),
            "blob_hex": base,
            "blob_b64": encode_auth_blob_b64(&blob),
        },
        "verify": verify,
    })
}

// ---------------------------------------------------------------------------
// frames.json
// ---------------------------------------------------------------------------

fn gen_frames() -> Value {
    let endpoint = ed25519_public_key(&test_secret());
    let key_hex = hex(&endpoint);

    let mut valid: Vec<Value> = Vec::new();
    let mut vcase = |name: &str, frame_hex: String, decoded: Value| {
        valid.push(json!({ "name": name, "frame_hex": frame_hex, "decoded": decoded }));
    };

    let send_hex = hex(&[
        &[frame_type::SEND][..],
        &endpoint[..],
        &[2],
        b"hello",
    ]
    .concat());
    vcase(
        "send",
        send_hex,
        json!({"type": "send", "dst": key_hex, "ecn": 2, "datagram_hex": hex(b"hello")}),
    );

    let send_empty_hex = hex(&[&[frame_type::SEND][..], &endpoint[..], &[0]].concat());
    vcase(
        "send-empty-datagram",
        send_empty_hex,
        json!({"type": "send", "dst": key_hex, "ecn": 0, "datagram_hex": ""}),
    );

    let batch_hex = hex(&[&[frame_type::SEND_BATCH][..], &endpoint[..], &[0], &[0, 4], b"abcdefgh"].concat());
    vcase(
        "send-batch",
        batch_hex,
        json!({"type": "sendBatch", "dst": key_hex, "ecn": 0, "segment_size": 4, "datagrams_hex": hex(b"abcdefgh")}),
    );

    let recv_hex = hex(&[&[frame_type::RECV][..], &endpoint[..], &[2], b"hello"].concat());
    vcase(
        "recv",
        recv_hex,
        json!({"type": "recv", "src": key_hex, "ecn": 2, "datagram_hex": hex(b"hello")}),
    );

    let recv_batch_hex = hex(&[&[frame_type::RECV_BATCH][..], &endpoint[..], &[1], &[0, 4], b"abcdefgh"].concat());
    vcase(
        "recv-batch",
        recv_batch_hex,
        json!({"type": "recvBatch", "src": key_hex, "ecn": 1, "segment_size": 4, "datagrams_hex": hex(b"abcdefgh")}),
    );

    let peer_gone_hex = hex(&encode::peer_gone(&endpoint));
    vcase("peer-gone", peer_gone_hex, json!({"type": "peerGone", "peer": key_hex}));

    let status_hex = hex(&encode::status(2));
    vcase("status", status_hex, json!({"type": "status", "code": 2}));

    let restarting_hex = hex(&encode::restarting(250, 10_000));
    vcase(
        "restarting",
        restarting_hex,
        json!({"type": "restarting", "reconnect_in_ms": 250, "try_for_ms": 10_000}),
    );

    let server_info_hex = hex(&encode::server_info(65_536, 3_600, "iad", "conn-1"));
    vcase(
        "server-info",
        server_info_hex,
        json!({"type": "serverInfo", "max_payload": 65_536, "max_conn_age_s": 3_600, "region": "iad", "conn_id": "conn-1"}),
    );

    let mut invalid: Vec<Value> = Vec::new();
    let mut icase = |name: &str, frame_hex: String, code: u16, class: &str| {
        invalid.push(json!({
            "name": name,
            "frame_hex": frame_hex,
            "expected_error": {"code": code, "class": class},
        }));
    };

    // Send with 32-byte payload (dst but no ecn byte).
    icase("send-too-short", hex(&[&[frame_type::SEND][..], &endpoint[..]].concat()), 1002, "protocol");
    // ecn out of range.
    icase("send-bad-ecn-4", hex(&[&[frame_type::SEND][..], &endpoint[..], &[4], b"x"].concat()), 1002, "protocol");
    icase("send-bad-ecn-255", hex(&[&[frame_type::SEND][..], &endpoint[..], &[255], b"x"].concat()), 1002, "protocol");
    // Small-order dst.
    let small = unhex(SMALL_ORDER_KEYS[1]);
    icase("send-small-order-dst", hex(&[&[frame_type::SEND][..], &small[..], &[0], b"x"].concat()), 1002, "protocol");
    // Payload beyond 65 536 after the type byte.
    let oversize = [
        &[frame_type::SEND][..],
        &endpoint[..],
        &[0],
        &vec![0u8; 65_536 - 31][..],
    ]
    .concat();
    icase("send-oversize-payload", hex(&oversize), 1009, "too_big");
    // SendBatch without full header.
    icase(
        "send-batch-too-short",
        hex(&[&[frame_type::SEND_BATCH][..], &endpoint[..], &[0], &[0]].concat()),
        1002,
        "protocol",
    );
    // segment_size 0.
    icase(
        "send-batch-segment-size-0",
        hex(&[&[frame_type::SEND_BATCH][..], &endpoint[..], &[0], &[0, 0], b"x"].concat()),
        1002,
        "protocol",
    );
    // Reserved and unknown client types.
    icase("reserved-type-00", hex(&[0x00]), 1002, "protocol");
    icase("unknown-type-09", hex(&[0x09]), 1002, "protocol");
    // Relay→client types sent by a client.
    icase("server-info-from-client", hex(&encode::server_info(65_536, 0, "", "")), 1002, "protocol");

    json!({ "version": 1, "valid": valid, "invalid": invalid })
}

// ---------------------------------------------------------------------------
// transform.json
// ---------------------------------------------------------------------------

fn gen_transform() -> Value {
    let endpoint = ed25519_public_key(&test_secret());
    let other = ed25519_public_key(&[0xa5u8; 32]);

    let mut cases: Vec<Value> = Vec::new();
    let mut tcase = |name: &str, client_hex: Vec<u8>, src_hex: &[u8], expected_hex: Vec<u8>| {
        cases.push(json!({
            "name": name,
            "client_frame_hex": hex(&client_hex),
            "src_key_hex": hex(src_hex),
            "expected_hex": hex(&expected_hex),
        }));
    };

    let send = [&[frame_type::SEND][..], &other[..], &[2], b"hello"].concat();
    let expected = [&[frame_type::RECV][..], &endpoint[..], &[2], b"hello"].concat();
    tcase("send-to-recv", send, &endpoint, expected);

    let send_empty = [&[frame_type::SEND][..], &other[..], &[0]].concat();
    let expected = [&[frame_type::RECV][..], &endpoint[..], &[0]].concat();
    tcase("send-empty-datagram", send_empty, &endpoint, expected);

    let batch = [&[frame_type::SEND_BATCH][..], &other[..], &[1], &[0, 4], b"abcdefgh"].concat();
    let expected = [&[frame_type::RECV_BATCH][..], &endpoint[..], &[1], &[0, 4], b"abcdefgh"].concat();
    tcase("send-batch-to-recv-batch", batch, &endpoint, expected);

    json!({ "version": 1, "cases": cases })
}

// ---------------------------------------------------------------------------
// server_info.json
// ---------------------------------------------------------------------------

fn gen_server_info() -> Value {
    let base = encode::server_info(65_536, 3_600, "iad", "conn-1");
    let decoded = json!({"max_payload": 65_536, "max_conn_age_s": 3_600, "region": "iad", "conn_id": "conn-1"});

    let mut trailing = base.clone();
    trailing.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef]);

    let empty = encode::server_info(65_536, 0, "", "");

    json!({
        "version": 1,
        "cases": [
            {"name": "basic", "frame_hex": hex(&base), "decoded": decoded},
            {"name": "trailing-bytes", "frame_hex": hex(&trailing), "decoded": decoded},
            {"name": "empty-region-and-conn-id", "frame_hex": hex(&empty),
             "decoded": {"max_payload": 65_536, "max_conn_age_s": 0, "region": "", "conn_id": ""}},
        ]
    })
}

// ---------------------------------------------------------------------------
// sanity: the generator must not emit anything the reference implementation rejects
// ---------------------------------------------------------------------------

fn self_check() {
    let secret = test_secret();
    let endpoint = ed25519_public_key(&secret);
    let blob = create_auth_blob(&secret, HOST, &endpoint, TIMESTAMP_MS, &[0u8; 16]);
    assert_eq!(blob.len(), AUTH_BLOB_LENGTH);
    // All "valid" client frames must decode.
    let frames = gen_frames();
    for case in frames["valid"].as_array().unwrap() {
        if case["decoded"]["type"].as_str().unwrap() == "send"
            || case["decoded"]["type"].as_str().unwrap() == "sendBatch"
        {
            decode_client_frame(&unhex(case["frame_hex"].as_str().unwrap())).unwrap();
        }
    }
    // The create-case blob must round-trip structurally.
    let auth = gen_auth();
    let blob = unhex(auth["create"]["blob_hex"].as_str().unwrap());
    assert!(decode_auth_blob(&blob).is_ok());
    let _ = build_auth_message;
}

fn main() {
    self_check();

    let mut out: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => out = args.next(),
            other => panic!("unknown argument: {other}"),
        }
    }
    let default_out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("packages/core/test/vectors");
    let out_dir = out.map(std::path::PathBuf::from).unwrap_or(default_out);
    std::fs::create_dir_all(&out_dir).expect("create vectors dir");

    write_json(&out_dir, "auth.json", &gen_auth());
    write_json(&out_dir, "frames.json", &gen_frames());
    write_json(&out_dir, "transform.json", &gen_transform());
    write_json(&out_dir, "server_info.json", &gen_server_info());
}
