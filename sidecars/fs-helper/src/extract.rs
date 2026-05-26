//! Text extraction. v1 minimal: reads the file, returns it as text if UTF-8;
//! otherwise returns metadata-only. Tika integration is a hook for future
//! work (config field present, but no HTTP call yet — would add reqwest
//! when rich-format extraction is enabled in the deployment).

use std::path::Path;

use crate::path::host_path;
use crate::rpc::{ExtractTextResult, RpcError};

pub async fn extract_text(
    root: &Path,
    path: &str,
    max_bytes: u64,
    tika_endpoint: Option<&str>,
) -> Result<ExtractTextResult, RpcError> {
    let host = host_path(root, path)?;
    let meta = std::fs::metadata(&host).map_err(|e| RpcError::Internal(e.to_string()))?;
    if !meta.is_file() {
        return Ok(ExtractTextResult {
            text: String::new(),
            mime: "application/x-directory".into(),
            truncated: false,
            source: "metadata",
            _error: Some("not a regular file".into()),
        });
    }
    let read_size = meta.len().min(max_bytes) as usize;
    let bytes = std::fs::read(&host).map_err(|e| RpcError::Internal(e.to_string()))?;
    let truncated = bytes.len() > read_size;
    let slice = &bytes[..read_size.min(bytes.len())];
    let mime = mime_guess::from_path(&host)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    if let Ok(s) = std::str::from_utf8(slice) {
        return Ok(ExtractTextResult {
            text: s.to_string(),
            mime,
            truncated,
            source: "text",
            _error: None,
        });
    }
    // Tika fallback — endpoint configured but HTTP integration is v2.
    let err = if tika_endpoint.is_some() {
        Some("tika_extraction_not_yet_wired".to_string())
    } else {
        Some("no_text_decode_no_tika".to_string())
    };
    Ok(ExtractTextResult {
        text: String::new(),
        mime,
        truncated,
        source: "metadata",
        _error: err,
    })
}
