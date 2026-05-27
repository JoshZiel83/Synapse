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
    let state = Arc::new(State {
        cli,
        history: Mutex::new(history),
        index: Mutex::new(index),
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
            // tasks under their own short-lived lock, then try-lock the
            // index briefly for the cheap counts; if the index is busy
            // (rebuild holding it), return the task info immediately with
            // a `doc_count_pending` marker instead of blocking the RPC.
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
            let try_lock = state.index.try_lock();
            let mut out = match try_lock {
                Ok(idx) => serde_json::to_value(idx.status(&requested_subtree)?)
                    .unwrap(),
                Err(_) => {
                    // Index busy (rebuild in progress). Return a stub
                    // status carrying just the subtree marker; the task
                    // payload below is the load-bearing signal.
                    serde_json::json!({
                        "subtree": requested_subtree,
                        "last_indexed_at": null,
                        "doc_count": -1,
                        "doc_count_pending": true,
                        "queue_depth": 0,
                        "errors": { "extract_failed": 0, "watcher_starved": 0 },
                    })
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
        other => Err(RpcError::MethodNotFound(other.to_string())),
    }
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
