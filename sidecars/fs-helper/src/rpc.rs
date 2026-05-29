//! JSON-RPC request/response shapes + the shared RpcError enum.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    #[serde(rename = "jsonrpc")]
    pub _jsonrpc: Option<String>,
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct RpcResponse {
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcErrPayload>,
}

#[derive(Debug, Serialize)]
pub struct RpcErrPayload {
    pub code: i32,
    pub message: String,
}

impl RpcResponse {
    pub fn ok(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }
    pub fn err(id: Value, code: i32, message: String) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(RpcErrPayload { code, message }),
        }
    }
}

#[derive(Debug, Error)]
pub enum RpcError {
    #[error("invalid_params: {0}")]
    InvalidParams(String),
    #[error("not_found: {0}")]
    NotFound(String),
    #[error("history_quota_exceeded: {0}")]
    HistoryQuotaExceeded(String),
    #[error("cas_mismatch: {0}")]
    CasMismatch(String),
    #[error("internal: {0}")]
    Internal(String),
    #[error("method_not_found: {0}")]
    MethodNotFound(String),
}

impl From<rusqlite::Error> for RpcError {
    fn from(e: rusqlite::Error) -> Self {
        RpcError::Internal(format!("sqlite: {e}"))
    }
}
impl From<std::io::Error> for RpcError {
    fn from(e: std::io::Error) -> Self {
        RpcError::Internal(format!("io: {e}"))
    }
}
impl From<anyhow::Error> for RpcError {
    fn from(e: anyhow::Error) -> Self {
        RpcError::Internal(format!("{e:#}"))
    }
}

// ─────────────────────────── inputs ──────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct HistorySnapshotInput {
    pub path: String,
    pub prior_exists: bool,
    #[serde(default)]
    pub expected_sha256: Option<String>,
    pub prior_size: u64,
    #[serde(default)]
    pub prior_mtime_ms: Option<i64>,
    #[serde(default = "default_op")]
    pub op: String,
}
fn default_op() -> String {
    "pre_write".to_string()
}

#[derive(Debug, Deserialize)]
pub struct HistoryGetInput {
    pub path: String,
    pub version: i64,
}

#[derive(Debug, Deserialize, Default)]
pub struct HistoryListInput {
    pub path: Option<String>,
    #[serde(default)]
    pub allowed_path_prefixes: Option<Vec<String>>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct HistoryDiffInput {
    pub path: String,
    pub version_a: i64,
    pub version_b: i64,
}

#[derive(Debug, Deserialize)]
pub struct HistoryRestoreInput {
    pub path: String,
    pub version: i64,
}

#[derive(Debug, Deserialize, Default)]
pub struct IndexRebuildInput {
    pub subtree: Option<String>,
    #[serde(default)]
    pub _ignore_patterns: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Default)]
pub struct IndexStatusInput {
    pub subtree: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct IndexUpsertInput {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct IndexRemoveInput {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct SearchContentInput {
    pub query: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub glob: Option<String>,
    pub limit: u32,
    pub offset: u32,
    pub allowed_path_prefixes: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct SearchPathInput {
    pub query: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub glob: Option<String>,
    pub limit: u32,
    pub offset: u32,
    pub allowed_path_prefixes: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ExtractTextInput {
    pub path: String,
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

// ─────────────────────────── outputs ─────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct HistorySnapshotResult {
    pub version: i64,
    pub blob_dedup: bool,
}

#[derive(Debug, Serialize)]
pub struct HistoryGetResult {
    pub prior_exists: bool,
    pub size: u64,
    pub sha256: Option<String>,
    pub mtime_ms: Option<i64>,
    pub op: String,
    pub recorded_at: String,
}

#[derive(Debug, Serialize)]
pub struct HistoryListEntry {
    pub version: i64,
    pub path: String,
    pub op: String,
    pub prior_exists: bool,
    pub size: u64,
    pub sha256: Option<String>,
    pub mtime_ms: Option<i64>,
    pub recorded_at: String,
}
#[derive(Debug, Serialize)]
pub struct HistoryListResult {
    pub entries: Vec<HistoryListEntry>,
}

#[derive(Debug, Serialize)]
pub struct HistoryDiffResult {
    pub is_text: bool,
    pub unified: Option<String>,
    pub meta_diff: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_truncated: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct HistoryRestoreResult {
    pub mode: &'static str, // "inline" | "tmp_token" | "delete"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_b64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmp_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct IndexRebuildResult {
    pub task_id: String,
}

#[derive(Debug, Serialize)]
pub struct IndexStatusResult {
    pub subtree: String,
    pub last_indexed_at: Option<String>,
    pub doc_count: i64,
    pub queue_depth: i64,
    pub errors: IndexErrors,
}
#[derive(Debug, Serialize)]
pub struct IndexErrors {
    pub extract_failed: i64,
    pub watcher_starved: i64,
}

#[derive(Debug, Serialize)]
pub struct SearchContentHit {
    pub path: String,
    pub score: f64,
    pub snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_no: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_offset: Option<u32>,
}
#[derive(Debug, Serialize)]
pub struct SearchContentResult {
    pub hits: Vec<SearchContentHit>,
}

#[derive(Debug, Serialize)]
pub struct SearchPathHit {
    pub path: String,
    pub score: f64,
}
#[derive(Debug, Serialize)]
pub struct SearchPathResult {
    pub hits: Vec<SearchPathHit>,
}

#[derive(Debug, Serialize)]
pub struct ExtractTextResult {
    pub text: String,
    pub mime: String,
    pub truncated: bool,
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub _error: Option<String>,
}
