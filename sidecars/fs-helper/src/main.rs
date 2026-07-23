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
mod instant;
mod manifest;
mod path;
mod rpc;
mod search;
mod telemetry;

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
    /// SSRF allowlist for axis-B presigned-transfer RPCs (fs.cas.import_url /
    /// fs.cas.export_url): the set of hostnames the helper is permitted to
    /// GET/PUT against. Repeatable AND comma-separated. When set, a presigned
    /// URL whose host is not in this list is rejected with invalid_params. When
    /// unset (None), the host check is skipped — the supervisor mints the URL,
    /// so this is defence-in-depth, but a deployment SHOULD pin it.
    #[arg(long, value_delimiter = ',')]
    pub presign_allow_host: Option<Vec<String>>,
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

/// Structured tracing to STDERR only (stdout is the JSON-RPC protocol channel).
/// Level via SYNAPSE_DEVICE_LOG_LEVEL (default info). The Node parent drains this
/// stderr into the device-runtime log stream.
fn init_logging() {
    let level =
        std::env::var("SYNAPSE_DEVICE_LOG_LEVEL").unwrap_or_else(|_| "info".to_string());
    let filter = tracing_subscriber::EnvFilter::try_new(&level)
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .json()
        .with_writer(std::io::stderr)
        .with_env_filter(filter)
        .try_init();
}

#[tokio::main]
async fn main() -> Result<()> {
    init_logging();
    // OTLP span export (P7) — None unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
    // Held to the end of main so the batch processor is flushed on a clean
    // (stdin-close) shutdown.
    let otel_provider = telemetry::init_tracing();
    tracing::info!(service = "fs-helper", pid = std::process::id(), "fs-helper sidecar starting");
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

    // Run the read loop in an inner fn so a `?` on an I/O error can never skip
    // the OTLP flush below, and so a stop SIGNAL — not just stdin EOF — unwinds
    // to that flush. The device-runtime stops helpers with an EOF grace then
    // SIGTERM (sidecar.ts); the old binary installed NO signal handler, so a
    // SIGTERM'd helper dropped every buffered span. Now signals flush.
    let serve_result = serve(&state).await;
    // Bounded flush (1500 ms) on EITHER a clean stdin close OR a signal — kept
    // strictly inside the supervisor's SIGKILL window (sidecar.ts grants a
    // 2000 ms EOF grace + 2000 ms after SIGTERM; one-shot grants 2000 ms). A
    // dead collector fails fast (connection refused), so the bound is a ceiling,
    // not a cost. shutdown_with_timeout replaces the old unbounded shutdown().
    if let Some(provider) = otel_provider {
        if let Err(err) = provider.shutdown_with_timeout(std::time::Duration::from_millis(1500)) {
            tracing::warn!(error = ?err, "otel flush on shutdown incomplete");
        }
    }
    // Exit deterministically once the batch is on the wire. The OTLP exporter
    // uses reqwest's BLOCKING client (opentelemetry-otlp's default
    // `reqwest-blocking-client` feature), whose background runtime thread — plus
    // the #[tokio::main] multi-thread runtime teardown — otherwise keeps the
    // process alive for SECONDS after shutdown_with_timeout has already flushed,
    // forcing every helper stop into the supervisor's SIGKILL (and defeating the
    // point of handling SIGTERM at all). The spans are exported by the line
    // above, so a hard exit here loses nothing; it just skips the hang. (Distinct
    // from Go's banned os.Exit, which would skip the flush — here we exit strictly
    // AFTER it.)
    match serve_result {
        Ok(()) => std::process::exit(0),
        Err(err) => {
            tracing::error!(error = ?err, "fs-helper read loop error");
            std::process::exit(1);
        }
    }
}

/// The stdio JSON-RPC read loop, factored out of `main` so a `?` on a read/write
/// error cannot bypass the OTLP flush in `main`. Returns when stdin closes
/// (EOF), a stop signal fires, or an I/O error occurs. On unix it races
/// SIGTERM/SIGINT against the next line so a signalled helper stops promptly and
/// still reaches the flush; `next_line()` is cancel-safe, so a line in flight is
/// never truncated by the select.
#[cfg(unix)]
async fn serve(state: &Arc<State>) -> Result<()> {
    use tokio::signal::unix::{signal, SignalKind};
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();
    // Signal streams are created ONCE (not per-iteration) so a signal delivered
    // mid-dispatch is observed on the next select rather than lost to a
    // freshly-constructed stream.
    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sigint = signal(SignalKind::interrupt())?;
    loop {
        tokio::select! {
            biased;
            _ = sigterm.recv() => {
                tracing::info!("fs-helper stopping (SIGTERM)");
                break;
            }
            _ = sigint.recv() => {
                tracing::info!("fs-helper stopping (SIGINT)");
                break;
            }
            line = reader.next_line() => {
                match line? {
                    None => {
                        tracing::info!("fs-helper stopping (stdin closed)");
                        break;
                    }
                    Some(line) => process_line(state, &mut stdout, &line).await?,
                }
            }
        }
    }
    Ok(())
}

/// Non-unix has no POSIX signal to await, so the loop relies on stdin EOF for
/// shutdown (Node's `kill('SIGTERM')` maps to TerminateProcess there, which no
/// handler can intercept — the supervisor's EOF grace is what buys the flush).
#[cfg(not(unix))]
async fn serve(state: &Arc<State>) -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = reader.next_line().await? {
        process_line(state, &mut stdout, &line).await?;
    }
    Ok(())
}

/// Handle one input line: skip blanks, dispatch, write the response frame.
async fn process_line(
    state: &Arc<State>,
    stdout: &mut tokio::io::Stdout,
    line: &str,
) -> Result<()> {
    if line.trim().is_empty() {
        return Ok(());
    }
    if let Some(text) = handle_frame(state, line).await {
        stdout.write_all(text.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
    }
    Ok(())
}

async fn handle_frame(state: &Arc<State>, raw: &str) -> Option<String> {
    // Parse FIRST, but start the span BEFORE the parse-error return so a
    // malformed frame (-32700) still produces a SERVER span — it used to return
    // before any span existed. rpc_span builds a `"jsonrpc"` SERVER span with
    // the JSON-RPC creation attributes, parented by the device-runtime's inbound
    // {traceparent, tracestate?} carrier (§3c); record_rpc_outcome names it and
    // sets rpc.method/status once the outcome is known. No-op when OTEL is
    // disabled. Held across dispatch so its duration is the span's.
    let parsed: Result<RpcRequest, _> = serde_json::from_str(raw);
    let request_id = parsed
        .as_ref()
        .ok()
        .and_then(|req| jsonrpc_request_id(req.id.as_ref()));
    let mut span = match &parsed {
        Ok(req) => telemetry::rpc_span(
            req.traceparent.as_deref(),
            req.tracestate.as_deref(),
            request_id.as_deref(),
        ),
        // Unparsable frame: no carrier and no id to read.
        Err(_) => telemetry::rpc_span(None, None, None),
    };

    let req = match parsed {
        Ok(req) => req,
        Err(e) => {
            telemetry::record_rpc_outcome(&mut span, "", Some((-32700, "parse_error")));
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
    let is_notification = req.id.is_none();
    let method = req.method.clone();
    let result =
        dispatch(state.clone(), method.as_str(), req.params.unwrap_or(Value::Null)).await;
    match result {
        Ok(v) => {
            // Record the span outcome BEFORE the notification early-return so a
            // notification still gets a complete span.
            telemetry::record_rpc_outcome(&mut span, &method, None);
            if is_notification {
                return None;
            }
            Some(serde_json::to_string(&RpcResponse::ok(id, v)).ok()?)
        }
        Err(e) => {
            let (code, msg) = match e {
                RpcError::InvalidParams(m) => (-32602, m),
                RpcError::NotFound(m) => (-32004, m),
                RpcError::HistoryQuotaExceeded(m) => (-32005, m),
                RpcError::CasMismatch(m) => (-32006, m),
                RpcError::Internal(m) => (-32603, m),
                RpcError::MethodNotFound(m) => (-32601, m),
            };
            telemetry::record_rpc_outcome(&mut span, &method, Some((code, msg.as_str())));
            if is_notification {
                return None;
            }
            Some(serde_json::to_string(&RpcResponse::err(id, code, msg)).ok()?)
        }
    }
}

/// Render a JSON-RPC id (string or number) for the `jsonrpc.request.id`
/// attribute, returning None for a notification (no id) or a null id so the
/// attribute is OMITTED rather than set to a placeholder. Mirrors the Go cua
/// helper's `jsonrpcRequestID`.
fn jsonrpc_request_id(id: Option<&Value>) -> Option<String> {
    match id {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(other) => Some(other.to_string()),
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
            let started_at = crate::instant::iso_instant_now();
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
                    t.finished_at = Some(crate::instant::iso_instant_now());
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
        "fs.cas.import_url" => cas_import_url(&state, params).await,
        "fs.cas.export_url" => cas_export_url(&state, params).await,
        "fs.cas.gc" => cas_gc(&state, params).await,
        "fs.manifest.materialize" => manifest_materialize(&state, params).await,
        "fs.manifest.scan_commit" => manifest_scan_commit(&state, params).await,
        "fs.dir.sync" => dir_sync(&state, params).await,
        "fs.dir.apply_head" => dir_apply_head(&state, params).await,
        "fs.manifest.cleanup" => manifest_cleanup(&state, params).await,
        "fs.sidecar.restore" => sidecar_restore(&state, params).await,
        // Handshake: no State/CAS needed, so it answers even without
        // --cas-dir. Ignores params (forward-compatible). TS clients call this
        // first on every (re)spawn and fail loud if proto_version mismatches.
        "fs.hello" => Ok(serde_json::to_value(rpc::HelloResult {
            proto_version: rpc::PROTO_VERSION,
            crate_version: env!("CARGO_PKG_VERSION").to_string(),
        })
        .unwrap()),
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

/// Enforce the `--presign-allow-host` SSRF allowlist against a presigned URL.
/// When the allowlist is unset, the check is skipped (defence-in-depth — the
/// supervisor mints the URL). When set, the URL must parse and its host must be
/// a member, else InvalidParams. Mirrors storage/ssrf.ts's host gate (the full
/// DNS-resolve protection lives in the TS supervisor; the helper only pins the
/// host since it never minted the URL).
fn enforce_presign_host(state: &Arc<State>, url: &str) -> Result<(), RpcError> {
    let Some(allow) = state.cli.presign_allow_host.as_ref() else {
        return Ok(());
    };
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| RpcError::InvalidParams(format!("invalid presign url: {e}")))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| RpcError::InvalidParams("presign url has no host".into()))?;
    // reqwest lowercases the host when it parses the URL, so a byte-exact compare
    // would fail-closed against an uppercase allowlist entry (e.g.
    // "S3.example.com"). Compare ASCII-case-insensitively so an uppercase
    // allowlist entry still matches the lowercased parsed host.
    if allow.iter().any(|h| h.eq_ignore_ascii_case(host)) {
        Ok(())
    } else {
        Err(RpcError::InvalidParams(format!(
            "host not in presign-allow-host: {host}"
        )))
    }
}

/// Per-call presigned-transfer HTTP client. Built with `redirect::Policy::none()`
/// so a 3xx response is surfaced as an error rather than followed: the SSRF
/// allowlist (`enforce_presign_host`) only checks the ORIGINAL url, so following
/// a redirect to an arbitrary host would bypass it. Credential-free + short-lived
/// (the helper holds only the presigned URL), built fresh per call so no long-
/// lived creds accrue.
fn presign_http_client() -> Result<reqwest::Client, RpcError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| RpcError::Internal(format!("http client build failed: {e}")))
}

async fn cas_import_url(state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
    let input: rpc::CasImportUrlInput = serde_json::from_value(params)
        .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
    // SSRF check BEFORE the transfer; redirect-none client so a 3xx errors
    // rather than escaping the allowlist by hopping to another host.
    enforce_presign_host(state, &input.url)?;
    let client = presign_http_client()?;
    // Network GET runs WITHOUT cas_lock held (so a slow transfer doesn't
    // serialize all CAS ops); the lock is taken only for the put_bytes step.
    let body = blobs::fetch_url_body(&client, &input.url, input.expected_size).await?;
    let (sha256, size, dedup) = {
        let cas = cas_lock(state).await?;
        cas.ingest_imported_bytes(&input.sha256, &body)?
    };
    Ok(serde_json::to_value(rpc::CasImportUrlResult { sha256, size, dedup }).unwrap())
}

async fn cas_export_url(state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
    let input: rpc::CasExportUrlInput = serde_json::from_value(params)
        .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
    // SSRF check BEFORE the transfer; redirect-none client (see import).
    enforce_presign_host(state, &input.put_url)?;
    let headers = input.headers.unwrap_or_default();
    // Read the local blob under cas_lock, then release it before the network PUT
    // so the transfer doesn't serialize all CAS ops.
    let bytes = {
        let cas = cas_lock(state).await?;
        cas.read_for_export(&input.sha256)?
    };
    let client = presign_http_client()?;
    let (size, etag) =
        blobs::put_url_body(&client, &input.put_url, bytes, &headers).await?;
    Ok(serde_json::to_value(rpc::CasExportUrlResult { size, etag }).unwrap())
}

async fn cas_gc(state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
    let input: rpc::CasGcInput = serde_json::from_value(params)
        .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
    let cas = cas_lock(state).await?;
    let reachable: std::collections::HashSet<String> =
        input.reachable_sha256.into_iter().collect();
    // Default 1h grace: never delete a blob younger than this, so a concurrent
    // commit (which writes blobs to the CAS before committing the snapshot row
    // that makes them reachable) can't be raced into corruption.
    let grace_secs = input.grace_secs.unwrap_or(3600);
    let (deleted, _skipped_young) = cas.gc_sweep(&reachable, grace_secs)?;
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
    let res = manifest::dir_sync(
        &cas,
        std::path::Path::new(&input.dir),
        &from,
        &to,
        input.defer_conflict_apply,
    )?;
    Ok(serde_json::to_value(rpc::DirSyncResult {
        applied: res.applied,
        deferred_conflicts: res.deferred_conflicts,
        conflict_sidecars: res
            .conflict_sidecars
            .into_iter()
            .map(|c| rpc::ConflictSidecar {
                original: c.original,
                sidecar: c.sidecar,
                kind: c.kind,
                content_sha: c.content_sha,
                target: c.target,
            })
            .collect(),
        incomplete: res.incomplete,
        new_base_manifest_sha256: res.new_base_manifest_sha256,
    })
    .unwrap())
}

async fn dir_apply_head(
    state: &Arc<State>,
    params: Value,
) -> Result<Value, RpcError> {
    let input: rpc::DirApplyHeadInput = serde_json::from_value(params)
        .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
    let cas = cas_lock(state).await?;
    let to = manifest::Manifest::load(&cas, Some(&input.to_manifest_sha256))?;
    manifest::apply_head_for_conflicts(
        &cas,
        std::path::Path::new(&input.dir),
        &to,
        &input.paths,
    )?;
    Ok(Value::Object(Map::new()))
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

async fn sidecar_restore(
    state: &Arc<State>,
    params: Value,
) -> Result<Value, RpcError> {
    let input: rpc::SidecarRestoreInput = serde_json::from_value(params)
        .map_err(|e| RpcError::InvalidParams(e.to_string()))?;
    let cas = cas_lock(state).await?;
    manifest::restore_sidecar(
        &cas,
        std::path::Path::new(&input.dir),
        &input.sidecar_vfs,
        &input.kind,
        input.content_sha.as_deref(),
        input.target.as_deref(),
    )?;
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
