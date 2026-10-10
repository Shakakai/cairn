//! App-facing Switchback endpoint crate (1.0.0 at first release).
//!
//! M0 scaffold — implemented per docs/09-client.md in later milestones.

/// Crate version reported to the relay in client tooling.
pub const CRATE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    #[test]
    fn scaffold() {
        assert!(!super::CRATE_VERSION.is_empty());
    }
}
