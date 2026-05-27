//! Text extraction. Streams the file up to `max_bytes` only — never reads
//! the full file. Optional Tika fallback for rich formats when an endpoint
//! is configured.

use std::io::Read;
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
    let truncated = meta.len() > max_bytes;
    // Stream-read only up to `max_bytes`. Avoids the memory spike of
    // loading large files just to slice them.
    let cap = max_bytes.min(meta.len()) as usize;
    let file = std::fs::File::open(&host).map_err(|e| RpcError::Internal(e.to_string()))?;
    let mut take = file.take(cap as u64);
    let mut buf = Vec::with_capacity(cap.min(64 * 1024));
    take
        .read_to_end(&mut buf)
        .map_err(|e| RpcError::Internal(e.to_string()))?;
    let mime = mime_guess::from_path(&host)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    if let Ok(s) = std::str::from_utf8(&buf) {
        return Ok(ExtractTextResult {
            text: s.to_string(),
            mime,
            truncated,
            source: "text",
            _error: None,
        });
    }
    // Tika rich-format fallback. When an endpoint is configured, POST the
    // (bounded) bytes and use the returned text. On any failure (no endpoint,
    // network error, HTTP non-2xx, body too large), fall through to
    // metadata-only with the reason in `_error`.
    if let Some(endpoint) = tika_endpoint {
        match tika_extract(endpoint, &buf, &mime).await {
            Ok(text) => {
                return Ok(ExtractTextResult {
                    text,
                    mime,
                    truncated,
                    source: "rich",
                    _error: None,
                });
            }
            Err(reason) => {
                return Ok(ExtractTextResult {
                    text: String::new(),
                    mime,
                    truncated,
                    source: "metadata",
                    _error: Some(reason),
                });
            }
        }
    }
    Ok(ExtractTextResult {
        text: String::new(),
        mime,
        truncated,
        source: "metadata",
        _error: Some("no_text_decode_no_tika".to_string()),
    })
}

async fn tika_extract(
    endpoint: &str,
    bytes: &[u8],
    mime: &str,
) -> Result<String, String> {
    let url = format!("{}/tika", endpoint.trim_end_matches('/'));
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Err(format!("tika_client_build: {e}")),
    };
    let res = client
        .put(&url)
        .header("Accept", "text/plain")
        .header("Content-Type", mime)
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|e| format!("tika_request: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("tika_http_{}", res.status().as_u16()));
    }
    res.text().await.map_err(|e| format!("tika_body: {e}"))
}

