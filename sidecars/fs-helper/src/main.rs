//! synapse-device-fs-helper — stdio JSON-RPC sidecar for the TS device-runtime
//! filesystem builtin.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use clap::Parser;
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

mod blobs;
mod extract;
mod history;
mod index;
mod manifest;
mod path;
mod rpc;
mod search;

use rpc::{RpcError, RpcRequest, RpcResponse};

#[derive(Parser, Debug, Clone)]
#[command(name = "synapse-device-fs-helper", version)]
pub struct Cli {
    #[arg(long)]
    pub root: PathBuf,
    #[arg(long)]
    pub work_dir: PathBuf,
    /// Shared content-addressed store directory. When set, the helper can
    /// serve the CAS + manifest RPCs (fs.cas.*, fs.manifest.*, fs.dir.sync)
    /// against this store. Distinct from --work-dir (which holds the
    /// per-device-ephemeral history/index sqlite). A supervisor drives a
    /// one-shot helper with --cas-dir to materialize/commit file spaces.
    #[arg(long)]
    pub cas_dir: Option<PathBuf>,
    #[arg(long)]
    pub tika_endpoint: Option<String>,
    #[arg(long, default_value = "")]
    pub fs_index_ignore: String,
    #[arg(long, default_value_t = 524_288_000)]
    pub max_snapshot_bytes: u64,
    #[arg(long, default_value_t = 52_428_800)]
    pub max_extract_bytes: u64,
    #[arg(long, default_value_t = 5_242_880)]
    pub max_diff_source_bytes: u64,
    #[arg(long, default_value_t = 1_048_576)]
    pub max_diff_output_bytes: u64,
    #[arg(long, default_value_t = 200)]
    pub max_search_limit: u32,
    #[arg(long, default_value_t = 200)]
    pub max_history_list_limit: u32,
    #[arg(long, default_value_t = 10_000)]
    pub max_offset: u32,
    #[arg(long, default_value_t = 5_368_709_120)]
    pub max_history_bytes: u64,
    #[arg(long, default_value_t = 100)]
    pub max_versions_per_path: u32,
    #[arg(long, default_value_t = 5)]
    pub keep_recent_versions: u32,
}

pub struct State {
    pub cli: Cli,
    pub history: Mutex<history::HistoryStore>,
    pub index: Mutex<index::IndexStore>,
    /// Shared content-addressed store (when --cas-dir is set). Behind a
    /// Mutex so concurrent cas/manifest RPCs serialize their filesystem
    /// work; the store ops themselves are atomic but a Mutex keeps the
    /// blocking scans off the async dispatch worker cleanly.
    pub cas: Option<Mutex<blobs::BlobStore>>,
    /// Tracks background fs.index.rebuild tasks so fs.index.status can
    /// surface progress. Rebuild is long-running for large trees; the RPC
    /// itself MUST return immediately with the task_id so the TS client's
    /// short timeout doesn't kill the helper.
    pub tasks: Mutex<std::collections::HashMap<String, RebuildTaskState>>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct RebuildTaskState {
    pub task_id: String,
    pub subtree: String,
    /// "running" | "completed" | "failed"
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    std::fs::create_dir_all(&cli.work_dir)?;
    let history = history::HistoryStore::open(
        &cli.work_dir,
        history::HistoryLimits {
            max_history_bytes: cli.max_history_bytes,
            max_versions_per_path: cli.max_versions_per_path,
            keep_recent_versions: cli.keep_recent_versions,
            max_snapshot_bytes: cli.max_snapshot_bytes,
        },
    )?;
    let index = index::IndexStore::open_with_tika(
        &cli.work_dir,
        &cli.fs_index_ignore,
        cli.tika_endpoint.as_deref(),
        cli.max_extract_bytes,
    )?;
    let cas = match &cli.cas_dir {
        Some(dir) => {
            std::fs::create_dir_all(dir)?;
            Some(Mutex::new(blobs::BlobStore::open(dir)?))
        }
        None => None,
    };
    let state = Arc::new(State {
        cli,
        history: Mutex::new(history),
        index: Mutex::new(index),
        cas,
        tasks: Mutex::new(std::collections::HashMap::new()),
    });

    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = reader.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let Some(text) = handle_frame(&state, &line).await else {
            continue;
        };
        stdout.write_all(text.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
    }
    Ok(())
}

async fn handle_frame(state: &Arc<State>, raw: &str) -> Option<String> {
    let req: RpcRequest = match serde_json::from_str(raw) {
        Ok(r) => r,
        Err(e) => {
            return Some(
                serde_json::to_string(&RpcResponse::err(
                    Value::Null,
                    -32700,
                    format!("parse_error: {e}"),
                ))
                .ok()?,
            );
        }
    };
    let id = req.id.clone().unwrap_or(Value::Null);
    let result = dispatch(state.clone(), req.method.as_str(), req.params.unwrap_or(Value::Null)).await;
    if req.id.is_none() {
        return None;
    }
    match result {
        Ok(v) => Some(serde_json::to_string(&RpcResponse::ok(id, v)).ok()?),
        Err(e) => {
            let (code, msg) = match e {
                RpcError::InvalidParams(m) => (-32602, m),
                RpcError::NotFound(m) => (-32004, m),
                RpcError::HistoryQuotaExceeded(m) => (-32005, m),
                RpcError::CasMismatch(m) => (-32006, m),
                RpcError::Internal(m) => (-32603, m),
                RpcError::MethodNotFound(m) => (-32601, m),
            };
            Some(serde_json::to_string(&RpcResponse::err(id, code, msg)).ok()?)
        }
    }
}

async fn dispatch(
    state: Arc<State>,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    match method {
        "fs.history.snapshot" => {
            let input: rpc::HistorySnapshotInput = serde_json::from_value(params)
                .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
            let mut h = state.history.lock().await;
            let out = h.snapshot(&state.cli.root, &input, false)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "fs.history.snapshot_delete" => {
            let input: rpc::HistorySnapshotInput = serde_json::from_value(params)
                .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
            let mut h = state.history.lock().await;
            let out = h.snapshot(&state.cli.root, &input, true)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "fs.history.get" => {
            let input: rpc::HistoryGetInput = serde_json::from_value(params)
                .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
            let h = state.history.lock().await;
            let out = h.get(&input.path, input.version)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "fs.history.list" => {
            let input: rpc::HistoryListInput = serde_json::from_value(params)
                .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
            let h = state.history.lock().await;
            let out = h.list(
                &input,
                state.cli.max_history_list_limit,
                state.cli.max_offset,
            )?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "fs.history.diff" => {
            let input: rpc::HistoryDiffInput = serde_json::from_value(params)
                .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
            let h = state.history.lock().await;
            let out = h.diff(
                &input.path,
                input.version_a,
                input.version_b,
                state.cli.max_diff_source_bytes,
                state.cli.max_diff_output_bytes,
            )?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "fs.history.restore" => {
            let input: rpc::HistoryRestoreInput = serde_json::from_value(params)
                .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
            let h = state.history.lock().await;
            let out = h.restore(&state.cli.root, &input.path, input.version)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "fs.index.rebuild" => {
            let input: rpc::IndexRebuildInput = serde_json::from_value(params)
                .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
            let subtree = input.subtree.clone().unwrap_or_else(|| "/".into());
            // Validate subtree before queueing — bad input must error
            // synchronously, not silently background a no-op.
            let _ = crate::path::canonical(&subtree)?;
            let task_id = format!("rebuild-{}", new_uuid_like());
            let started_at = now_rfc3339_like();
            let task = RebuildTaskState {
                task_id: task_id.clone(),
                subtree: subtree.clone(),
                status: "running".into(),
                started_at,
                finished_at: None,
                error: None,
            };
            // Insert + GC: bounded retention so a long-lived helper
            // doesn't grow the task map indefinitely. Keep the most
            // recent MAX_TASK_HISTORY by started_at; this includes the
            // one we just inserted (newest).
            {
                let mut tasks = state.tasks.lock().await;
                tasks.insert(task_id.clone(), task);
                const MAX_TASK_HISTORY: usize = 32;
                if tasks.len() > MAX_TASK_HISTORY {
                    let mut by_age: Vec<(String, String)> = tasks
                        .iter()
                        .map(|(k, v)| (k.clone(), v.started_at.clone()))
                        .collect();
                    by_age.sort_by(|a, b| a.1.cmp(&b.1));
                    let drop_n = tasks.len() - MAX_TASK_HISTORY;
                    for (k, _) in by_age.into_iter().take(drop_n) {
                        tasks.remove(&k);
                    }
                }
            }
            // Spawn the actual work as a background task. fs.index.rebuild
            // for a multi-thousand-file subtree easily exceeds the 5s
            // client-side RPC timeout; returning immediately + tracking
            // status separately keeps the helper from being killed.
            let state2 = state.clone();
            let task_id2 = task_id.clone();
            let subtree2 = subtree.clone();
            tokio::task::spawn(async move {
                // spawn_blocking around the sync rebuild so we don't tie
                // up the dispatch worker for the duration of the walk.
                let work_state = state2.clone();
                let join = tokio::task::spawn_blocking(move || -> Result<(), String> {
                    // Acquire the index lock synchronously inside the blocking
                    // task by trying repeatedly via a runtime handle.
                    let handle = tokio::runtime::Handle::current();
                    let mut idx = handle.block_on(work_state.index.lock());
                    idx.rebuild(&work_state.cli.root, Some(&subtree2))
                        .map(|_| ())
                        .map_err(|e| format!("{e}"))
                })
                .await;
                let mut tasks = state2.tasks.lock().await;
                if let Some(t) = tasks.get_mut(&task_id2) {
                    t.finished_at = Some(now_rfc3339_like());
                    match join {
                        Ok(Ok(())) => t.status = "completed".into(),
                        Ok(Err(msg)) => {
                            t.status = "failed".into();
                            t.error = Some(msg);
                        }
                        Err(join_err) => {
                            t.status = "failed".into();
                            t.error = Some(format!("join_error: {join_err}"));
                        }
                    }
                }
            });
            Ok(serde_json::json!({ "task_id": task_id }))
        }
        "fs.index.status" => {
            let input: rpc::IndexStatusInput = serde_json::from_value(params)
                .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
            let requested_subtree =
                crate::path::canonical(input.subtree.as_deref().unwrap_or("/"))?;
            // Read the task table FIRST without touching the index lock —
            // a long-running rebuild holds the index Mutex for the
            // duration of its work, so anything that gates on index.lock()
            // can't reliably surface rebuild_task=running. We snapshot
            // tasks under their own short-lived lock, then read the
            // counts via a **separate read-only SQLite connection** so a
            // /secret rebuild holding the index Mutex doesn't leak its
            // existence to a /public status caller via a `doc_count_pending`
            // sentinel. (The old design did `state.index.try_lock()` and
            // returned `doc_count:-1, doc_count_pending:true` on failure;
            // even after the runtime stripped the unauthorized rebuild_task
            // field, that sentinel was a cross-subtree side channel that
            // said "some rebuild is happening, just not one you're allowed
            // to see".) WAL mode lets the read-only connection observe a
            // consistent snapshot (possibly mid-rebuild stale, which is
            // acceptable — `rebuild_task` already communicates progress
            // to authorized callers).
            let task_snapshot: Option<RebuildTaskState> = {
                let tasks = state.tasks.lock().await;
                tasks
                    .values()
                    .filter(|t| {
                        // Subtree-scoped: include tasks whose subtree is a
                        // descendant OR ancestor of the requested subtree.
                        // A status on `/public` must NOT see a `/secret`
                        // rebuild (the user's repro), but a global
                        // `/`-wide rebuild IS observable from any subtree
                        // status (it affects everything).
                        let s = t.subtree.as_str();
                        crate::path::under_prefix(s, &requested_subtree)
                            || crate::path::under_prefix(
                                &requested_subtree,
                                s,
                            )
                    })
                    .max_by(|a, b| a.started_at.cmp(&b.started_at))
                    .cloned()
            };
            // Read the per-subtree counts via a fresh read-only connection.
            // No mutex contention, no busy-state side channel.
            //
            // Error policy:
            //   - `Ok(None)` from open_status_conn = db file genuinely
            //     absent (helper not fully initialized yet). Emit the
            //     quiet zero stub; nothing has been indexed, so doc_count:0
            //     is correct, not a cover for a real failure.
            //   - Real `Err(_)` from either opening the conn or running
            //     compute_status = SQLite-level failure (corruption,
            //     permissions, schema drift). Propagate as an explicit
            //     `index_status_unavailable` error rather than masking it
            //     as `doc_count:0` — silently lying about an empty index
            //     would let DB corruption masquerade as an idle helper.
            //     This does NOT re-introduce the doc_count_pending side
            //     channel because such failures are global, not per-
            //     subtree (every caller sees the same error regardless
            //     of which subtree they query).
            let mut out = match crate::index::open_status_conn(&state.cli.work_dir)
                .map_err(|e| RpcError::Internal(format!("index_status_unavailable: {e:?}")))?
            {
                None => serde_json::json!({
                    "subtree": requested_subtree,
                    "last_indexed_at": null,
                    "doc_count": 0,
                    "queue_depth": 0,
                    "errors": { "extract_failed": 0, "watcher_starved": 0 },
                }),
                Some(conn) => {
                    let s = crate::index::compute_status(&conn, &requested_subtree)
                        .map_err(|e| RpcError::Internal(format!("index_status_unavailable: {e:?}")))?;
                    serde_json::to_value(s).unwrap()
                }
            };
            if let Some(t) = task_snapshot {
                if let Value::Object(ref mut m) = out {
                    m.insert(
                        "rebuild_task".into(),
                        serde_json::to_value(t).unwrap(),
                    );
                }
            }
            Ok(out)
        }
        "fs.index.task_status" => {
            let input: serde_json::Value = params;
            let task_id = input
                .get("task_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    RpcError::InvalidParams("task_id required".into())
                })?;
            let tasks = state.tasks.lock().await;
            match tasks.get(task_id) {
                Some(t) => Ok(serde_json::to_value(t).unwrap()),
                None => Err(RpcError::NotFound(format!("task {task_id}"))),
            }
        }
        "fs.index.upsert" => {
            let input: rpc::IndexUpsertInput = serde_json::from_value(params)
                .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
            let mut idx = state.index.lock().await;
            idx.upsert(&state.cli.root, &input.path)?;
            Ok(Value::Object(Map::new()))
        }
        "fs.index.remove" => {
            let input: rpc::IndexRemoveInput = serde_json::from_value(params)
                .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
            let mut idx = state.index.lock().await;
            idx.remove(&input.path)?;
            Ok(Value::Object(Map::new()))
        }
        "fs.search.content" => {
            let input: rpc::SearchContentInput = serde_json::from_value(params)
                .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
            let idx = state.index.lock().await;
            let out = search::search_content(
                &idx,
                &input,
                state.cli.max_search_limit,
                state.cli.max_offset,
            )?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "fs.search.path" => {
            let input: rpc::SearchPathInput = serde_json::from_value(params)
                .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
            let idx = state.index.lock().await;
            let out = search::search_path(
                &idx,
                &input,
                state.cli.max_search_limit,
                state.cli.max_offset,
            )?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "fs.extract.text" => {
            let input: rpc::ExtractTextInput = serde_json::from_value(params)
                .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
            let out = extract::extract_text(
                &state.cli.root,
                &input.path,
                input.max_bytes.unwrap_or(state.cli.max_extract_bytes),
                state.cli.tika_endpoint.as_deref(),
            )
            .await?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "fs.cas.put" => cas_put(&state, params).await,
        "fs.cas.has" => cas_has(&state, params).await,
        "fs.cas.gc" => cas_gc(&state, params).await,
        "fs.manifest.materialize" => manifest_materialize(&state, params).await,
        "fs.manifest.scan_commit" => manifest_scan_commit(&state, params).await,
        "fs.dir.sync" => dir_sync(&state, params).await,
        "fs.manifest.cleanup" => manifest_cleanup(&state, params).await,
        other => Err(RpcError::MethodNotFound(other.to_string())),
    }
}

/// Acquire the CAS store lock, or InvalidParams if the helper wasn't
/// started with --cas-dir.
async fn cas_lock<'a>(
    state: &'a Arc<State>,
) -> Result<tokio::sync::MutexGuard<'a, blobs::BlobStore>, RpcError> {
    match &state.cas {
        Some(m) => Ok(m.lock().await),
        None => Err(RpcError::InvalidParams(
            "cas not configured: helper started without --cas-dir".into(),
        )),
    }
}

async fn cas_put(state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
    let input: rpc::CasPutInput = serde_json::from_value(params)
        .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
    let cas = cas_lock(state).await?;
    let (sha256, size, dedup) =
        cas.put_streaming(std::path::Path::new(&input.path), None)?;
    Ok(serde_json::to_value(rpc::CasPutResult { sha256, size, dedup }).unwrap())
}

async fn cas_has(state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
    let input: rpc::CasHasInput = serde_json::from_value(params)
        .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
    let cas = cas_lock(state).await?;
    let exists = cas.exists(&input.sha256);
    Ok(serde_json::to_value(rpc::CasHasResult { exists }).unwrap())
}

async fn cas_gc(state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
    let input: rpc::CasGcInput = serde_json::from_value(params)
        .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
    let cas = cas_lock(state).await?;
    let reachable: std::collections::HashSet<String> =
        input.reachable_sha256.into_iter().collect();
    let mut deleted = 0u64;
    for sha in cas.list_all()? {
        if !reachable.contains(&sha) {
            cas.delete(&sha)?;
            deleted += 1;
        }
    }
    Ok(serde_json::to_value(rpc::CasGcResult { deleted_count: deleted }).unwrap())
}

async fn manifest_materialize(
    state: &Arc<State>,
    params: Value,
) -> Result<Value, RpcError> {
    let input: rpc::ManifestMaterializeInput = serde_json::from_value(params)
        .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
    let cas = cas_lock(state).await?;
    let m = manifest::Manifest::load(&cas, input.manifest_sha256.as_deref())?;
    manifest::materialize(&cas, &m, std::path::Path::new(&input.target_dir))?;
    Ok(Value::Object(Map::new()))
}

async fn manifest_scan_commit(
    state: &Arc<State>,
    params: Value,
) -> Result<Value, RpcError> {
    let input: rpc::ManifestScanCommitInput = serde_json::from_value(params)
        .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
    let cas = cas_lock(state).await?;
    // Scan the live dir → working manifest + any new blobs ingested.
    let (working, new_blobs) =
        manifest::scan_dir(&cas, std::path::Path::new(&input.dir))?;
    let base = manifest::Manifest::load(&cas, input.base_manifest_sha256.as_deref())?;
    let (final_manifest, conflict_paths) = match input.latest_manifest_sha256.as_deref()
    {
        // No latest, or latest == base → no merge needed; working IS the
        // committed tree.
        None => (working, Vec::new()),
        Some(latest_sha)
            if Some(latest_sha) == input.base_manifest_sha256.as_deref() =>
        {
            (working, Vec::new())
        }
        Some(latest_sha) => {
            let latest = manifest::Manifest::load(&cas, Some(latest_sha))?;
            let res = manifest::three_way_merge(&base, &working, &latest);
            (res.merged, res.conflict_paths)
        }
    };
    let manifest_sha256 = final_manifest.store(&cas)?;
    let entries: Vec<rpc::ManifestEntryWire> = final_manifest
        .entries
        .values()
        .map(rpc::ManifestEntryWire::from)
        .collect();
    let entry_count = final_manifest.entry_count() as u64;
    let total_bytes = final_manifest.total_bytes();
    Ok(serde_json::to_value(rpc::ManifestScanCommitResult {
        manifest_sha256,
        entries,
        new_blobs,
        conflict_paths,
        entry_count,
        total_bytes,
    })
    .unwrap())
}

async fn dir_sync(state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
    let input: rpc::DirSyncInput = serde_json::from_value(params)
        .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
    let cas = cas_lock(state).await?;
    let from = manifest::Manifest::load(&cas, input.base_manifest_sha256.as_deref())?;
    let to = manifest::Manifest::load(&cas, Some(&input.to_manifest_sha256))?;
    let res = manifest::dir_sync(&cas, std::path::Path::new(&input.dir), &from, &to)?;
    Ok(serde_json::to_value(rpc::DirSyncResult {
        applied: res.applied,
        deferred_conflicts: res.deferred_conflicts,
        new_base_manifest_sha256: res.new_base_manifest_sha256,
    })
    .unwrap())
}

async fn manifest_cleanup(
    _state: &Arc<State>,
    params: Value,
) -> Result<Value, RpcError> {
    let input: rpc::ManifestCleanupInput = serde_json::from_value(params)
        .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
    for p in &input.paths {
        let path = std::path::Path::new(p);
        if let Ok(meta) = path.symlink_metadata() {
            if meta.file_type().is_dir() {
                let _ = std::fs::remove_dir_all(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    Ok(Value::Object(Map::new()))
}

fn new_uuid_like() -> String {
    // CSPRNG-backed task id (16 bytes hex = 128 bits of entropy). The
    // previous epoch-nanos + pid scheme was guessable; combined with the
    // task_status RPC's exists-vs-denied distinction, an attacker could
    // probe for task existence by trying nearby task_ids. Use getrandom
    // so id space is unpredictable.
    let mut buf = [0u8; 16];
    if getrandom::getrandom(&mut buf).is_err() {
        // Fall back to time+pid; better than failing the whole rebuild.
        use std::time::{SystemTime, UNIX_EPOCH};
        let ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        return format!("{:016x}{:08x}", ns, std::process::id());
    }
    let mut s = String::with_capacity(32);
    for b in buf {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn now_rfc3339_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    let ms = d.subsec_millis();
    format!("epoch:{secs}.{ms:03}")
}
