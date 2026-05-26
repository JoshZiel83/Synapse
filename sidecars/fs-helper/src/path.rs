//! Canonical path + boundary-aware prefix matcher. Mirrors the TS
//! canonicalVfsPath / pathUnderPrefix semantics so the sidecar applies the
//! same rules to every incoming path argument.

use std::path::{Path, PathBuf};

use crate::rpc::RpcError;

const INTERNAL_NAMESPACE: &str = "/.synapse-internal";
const INTERNAL_PREFIX: &str = "/.synapse-internal/";

const DOS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
    "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6",
    "LPT7", "LPT8", "LPT9",
];

/// Same 4-step gate as TS canonicalVfsPath.
pub fn canonical(input: &str) -> Result<String, RpcError> {
    if input != input.trim() {
        return Err(RpcError::InvalidParams(
            "invalid_path: leading/trailing whitespace".into(),
        ));
    }
    if input.contains('\\') {
        return Err(RpcError::InvalidParams(
            "invalid_path: backslash not allowed".into(),
        ));
    }
    if input.len() >= 2 && input.as_bytes()[1] == b':' && input.as_bytes()[0].is_ascii_alphabetic() {
        return Err(RpcError::InvalidParams(
            "invalid_path: drive-letter prefix".into(),
        ));
    }
    if input.contains(':') {
        return Err(RpcError::InvalidParams(
            "invalid_path: colon not allowed".into(),
        ));
    }
    if input == INTERNAL_NAMESPACE || input == "/.synapse-internal/" {
        return Err(RpcError::InvalidParams("invalid_path: reserved".into()));
    }
    let raw_segments: Vec<&str> = input.split('/').filter(|s| !s.is_empty()).collect();
    for seg in &raw_segments {
        if *seg == "." || *seg == ".." {
            continue;
        }
        if seg.ends_with('.') || seg.ends_with(' ') {
            return Err(RpcError::InvalidParams(format!(
                "invalid_path: segment ends in '.' or ' ': {seg:?}"
            )));
        }
        let upper = seg
            .split('.')
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        if DOS_RESERVED.iter().any(|r| *r == upper) {
            return Err(RpcError::InvalidParams(format!(
                "invalid_path: DOS reserved: {seg:?}"
            )));
        }
    }
    let mut stack: Vec<&str> = Vec::new();
    for seg in &raw_segments {
        if *seg == "." {
            continue;
        }
        if *seg == ".." {
            stack.pop();
            continue;
        }
        stack.push(seg);
    }
    let mut canonical = String::from("/");
    canonical.push_str(&stack.join("/"));
    if canonical == INTERNAL_NAMESPACE || canonical.starts_with(INTERNAL_PREFIX) {
        return Err(RpcError::InvalidParams("invalid_path: reserved".into()));
    }
    Ok(canonical)
}

/// Boundary-aware prefix match; `/` matches anything.
pub fn under_prefix(path: &str, prefix: &str) -> bool {
    if prefix == "/" {
        return true;
    }
    if path == prefix {
        return true;
    }
    let mut needle = String::from(prefix);
    needle.push('/');
    path.starts_with(&needle)
}

/// Translate canonical "/foo/bar" into a host PathBuf under `root`. Does not
/// follow symlinks (the sidecar trusts the TS layer to have done that
/// already; sidecar callers stage tmps in /.synapse-internal/ which sits on
/// the same mount).
pub fn host_path(root: &Path, canonical_path: &str) -> Result<PathBuf, RpcError> {
    let canonical = canonical(canonical_path)?;
    let mut p = root.to_path_buf();
    let stripped = canonical.trim_start_matches('/');
    if !stripped.is_empty() {
        for seg in stripped.split('/') {
            p.push(seg);
        }
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_basic() {
        assert_eq!(canonical("").unwrap(), "/");
        assert_eq!(canonical("/foo").unwrap(), "/foo");
        assert_eq!(canonical("foo").unwrap(), "/foo");
        assert_eq!(canonical("/foo/../bar").unwrap(), "/bar");
        assert_eq!(canonical("/../etc").unwrap(), "/etc");
    }

    #[test]
    fn canonical_rejects_internal() {
        assert!(canonical("/.synapse-internal").is_err());
        assert!(canonical("/.synapse-internal/tmp/x").is_err());
        assert!(canonical("/.synapse-internal/.").is_err());
        assert!(canonical("/.synapse-internal/foo/..").is_err());
    }

    #[test]
    fn canonical_rejects_dos() {
        assert!(canonical("/CON").is_err());
        assert!(canonical("/con.txt").is_err());
        assert!(canonical("/LPT9").is_err());
        assert!(canonical("/console.log").is_ok()); // not reserved
    }

    #[test]
    fn under_prefix_boundary() {
        assert!(under_prefix("/foo", "/"));
        assert!(under_prefix("/foo/bar", "/foo"));
        assert!(under_prefix("/foo", "/foo"));
        assert!(!under_prefix("/foobar", "/foo"));
        assert!(!under_prefix("/foo2", "/foo"));
    }
}
