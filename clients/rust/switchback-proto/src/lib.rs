//! Switchback v1 protocol: frame codec, connect-auth blob, z-base-32 EndpointIds.
//!
//! Mirrors `@cairn/core` (docs/01); the two implementations are pinned to each other through
//! the shared JSON vectors in `packages/core/test/vectors` (docs/08 §1).

pub mod auth;
pub mod crypto;
pub mod frames;
pub mod keys;

pub use auth::{
    build_auth_message, create_auth_blob, decode_auth_blob, encode_auth_blob, encode_auth_blob_b64,
    normalize_host, verify_auth_blob, AuthBlob, AuthBlobParts, AuthFailure, AUTH_BLOB_LENGTH,
    AUTH_BLOB_VERSION, AUTH_NONCE_LENGTH,
};
pub use crypto::{
    blake3_derive_key, ed25519_public_key, ed25519_sign, ed25519_verify_strict,
    CONNECT_AUTH_CONTEXT, CONNECT_AUTH_CONTEXT as AUTH_CONTEXT,
};
pub use frames::{
    decode_client_frame, decode_relay_frame, forward_transform, ClientFrame, FrameError, FrameType,
    RelayFrame, MAX_FRAME_PAYLOAD, MAX_WEBSOCKET_MESSAGE,
};
pub use keys::{
    endpoint_id_from_bytes, endpoint_id_to_bytes, is_valid_endpoint_key, is_valid_endpoint_id,
    ENDPOINT_ID_LENGTH, ENDPOINT_KEY_LENGTH, ZBASE32_ALPHABET,
};

/// The wire protocol token (doc 01 §1).
pub const PROTOCOL_VERSION_TOKEN: &str = "switchback.v1";
