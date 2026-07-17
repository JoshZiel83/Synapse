//! JSON-RPC request/response shapes + the shared RpcError enum.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Wire protocol version reported by `fs.hello`. TS clients pin an expected
/// value (`FS_HELPER_PROTO_VERSION` in
/// packages/device-runtime/src/builtins/fs-helper-resolve.ts) and fail loud on
/// mismatch, which catches the "same CLI args, drifted RPC semantics" stale-
/// binary class at runtime. BUMP IN LOCKSTEP with the TS constant: any wire-
/// incompatible change to an existing RPC's params/result is a bump; adding a
/// new method or an optional field is not.
pub const PROTO_VERSION: u32 = 2;

/// `fs.hello` result: the handshake every TS client performs on (re)spawn.
/// Intentionally requires no State/CAS so it answers even when the helper was
/// started without --cas-dir.
#[derive(Debug, Serialize)]
pub struct HelloResult {
    pub proto_version: u32,
    pub crate_version: String,
}

#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    #[serde(rename = "jsonrpc")]
    pub _jsonrpc: Option<String>,
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
    /// W3C traceparent injected per-RPC by the device-runtime (§3c carrier)
    /// so this helper's span continues the originating request's trace.
    #[serde(default)]
    pub traceparent: Option<String>,
    /// W3C tracestate, rides alongside `traceparent` (§3c: `{traceparent,
    /// tracestate?}` at the JSON-RPC frame top-level). Vendor members survive
    /// the hop; the device-runtime only forwards values the api pre-sanitized.
    #[serde(default)]
    pub tracestate: Option<String>,
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

// ─────────────────────── CAS + manifest inputs ───────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CasPutInput {
    /// Absolute host path of the source file to ingest into the CAS.
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct CasHasInput {
    pub sha256: String,
}

#[derive(Debug, Deserialize)]
pub struct CasImportUrlInput {
    /// The supervisor-asserted sha256 the fetched bytes MUST hash to.
    pub sha256: String,
    /// Short-lived, single-object presigned GET URL minted by the supervisor.
    pub url: String,
    /// Optional expected object size; when set and the response advertises a
    /// Content-Length, a divergence is rejected up front.
    #[serde(default)]
    pub expected_size: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct CasExportUrlInput {
    /// CAS key of the local blob whose bytes to upload.
    pub sha256: String,
    /// Short-lived, single-object presigned PUT URL minted by the supervisor.
    pub put_url: String,
    /// Extra headers to attach verbatim (e.g. x-amz-checksum-sha256). The
    /// supervisor — not the helper — constructs + signs these into the URL.
    #[serde(default)]
    pub headers: Option<Vec<(String, String)>>,
}

#[derive(Debug, Deserialize)]
pub struct CasGcInput {
    /// The complete reachable set; any blob NOT in this set is deleted.
    pub reachable_sha256: Vec<String>,
    /// Grace window (seconds): blobs modified more recently than this are NEVER
    /// deleted even if unreachable, protecting in-flight commits whose blobs are
    /// on disk before their snapshot row commits. Defaults to 3600 when omitted.
    #[serde(default)]
    pub grace_secs: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct ManifestMaterializeInput {
    /// Manifest blob sha to materialize; None/empty = empty tree.
    #[serde(default)]
    pub manifest_sha256: Option<String>,
    /// Absolute host path of the plain directory to populate.
    pub target_dir: String,
}

#[derive(Debug, Deserialize)]
pub struct ManifestScanCommitInput {
    /// Absolute host path of the live working directory to scan.
    pub dir: String,
    /// What the live dir was materialized from (for 3-way merge base).
    #[serde(default)]
    pub base_manifest_sha256: Option<String>,
    /// Current space head (may have advanced past base); when present and
    /// != base, a 3-way merge is performed.
    #[serde(default)]
    pub latest_manifest_sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DirSyncInput {
    /// Absolute host path of the live working directory to reconcile.
    pub dir: String,
    /// The dir's current base manifest.
    #[serde(default)]
    pub base_manifest_sha256: Option<String>,
    /// The new head manifest to merge toward.
    pub to_manifest_sha256: String,
    /// R12-1: when true, write sidecars + apply non-conflicting incoming changes
    /// but DEFER overwriting the conflicting live paths with head. The caller
    /// durably persists the pending record, then calls fs.dir.apply_head to
    /// finish. Defaults false (legacy one-shot apply).
    #[serde(default)]
    pub defer_conflict_apply: bool,
}

#[derive(Debug, Deserialize)]
pub struct DirApplyHeadInput {
    /// Absolute host path of the live working directory.
    pub dir: String,
    /// The head manifest whose values to apply at the conflict paths.
    pub to_manifest_sha256: String,
    /// The conflict paths (deferred_conflicts from the dir_sync phase) to
    /// overwrite with head now that the pending record is durable.
    pub paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ManifestCleanupInput {
    /// Absolute host paths (scratch dirs) to remove.
    pub paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct SidecarRestoreInput {
    /// Absolute host path of the live mount root to restore the sidecar into.
    pub dir: String,
    /// The mount-relative sidecar VFS leaf (e.g. /.synapse-conflicts/<hash>).
    pub sidecar_vfs: String,
    /// "file" or "symlink".
    pub kind: String,
    /// CAS sha for a file sidecar (its bytes are already in CAS).
    #[serde(default)]
    pub content_sha: Option<String>,
    /// Symlink target for a symlink sidecar.
    #[serde(default)]
    pub target: Option<String>,
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

// ─────────────────────── CAS + manifest outputs ──────────────────────────────

#[derive(Debug, Serialize)]
pub struct CasPutResult {
    pub sha256: String,
    pub size: u64,
    pub dedup: bool,
}

#[derive(Debug, Serialize)]
pub struct CasHasResult {
    pub exists: bool,
}

#[derive(Debug, Serialize)]
pub struct CasGcResult {
    pub deleted_count: u64,
}

#[derive(Debug, Serialize)]
pub struct CasImportUrlResult {
    pub sha256: String,
    pub size: u64,
    pub dedup: bool,
}

#[derive(Debug, Serialize)]
pub struct CasExportUrlResult {
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
}

/// Wire form of a manifest entry returned by scan_commit (so the TS caller
/// can persist path→sha mappings without re-reading the manifest blob).
#[derive(Debug, Serialize)]
pub struct ManifestEntryWire {
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub mode: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

impl From<&crate::manifest::ManifestEntry> for ManifestEntryWire {
    fn from(e: &crate::manifest::ManifestEntry) -> Self {
        let kind = match e.kind {
            crate::manifest::EntryKind::File => "file",
            crate::manifest::EntryKind::Dir => "dir",
            crate::manifest::EntryKind::Symlink => "symlink",
        };
        Self {
            path: e.path.clone(),
            kind: kind.to_string(),
            sha256: e.sha256.clone(),
            mode: e.mode,
            size: e.size,
            target: e.target.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ManifestScanCommitResult {
    pub manifest_sha256: String,
    pub entries: Vec<ManifestEntryWire>,
    pub new_blobs: Vec<String>,
    pub conflict_paths: Vec<String>,
    pub entry_count: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct ConflictSidecar {
    pub original: String,
    pub sidecar: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DirSyncResult {
    pub applied: Vec<String>,
    pub deferred_conflicts: Vec<String>,
    pub conflict_sidecars: Vec<ConflictSidecar>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incomplete: Option<String>,
    pub new_base_manifest_sha256: String,
}
