// Shared types between the TS fs-helper-client and the Rust sidecar JSON-RPC
// contract. Kept in a dedicated file so both the client and any future
// integration tests can import without pulling the full filesystem builtin
// surface.

export interface HistoryGetInput {
  path: string
  version: number
}
export interface HistoryGetResult {
  prior_exists: boolean
  size: number
  sha256: string | null
  mtime_ms: number | null
  op: "pre_write" | "pre_edit" | "pre_restore" | "delete"
  recorded_at: string
}

export interface HistorySnapshotInput {
  path: string
  prior_exists: boolean
  expected_sha256?: string | null
  prior_size: number
  prior_mtime_ms: number | null
  op: "pre_write" | "pre_edit" | "pre_restore"
}
export interface HistorySnapshotResult {
  version: number
  blob_dedup: boolean
}
export interface HistorySnapshotDeleteInput {
  path: string
  prior_exists: boolean
  expected_sha256?: string | null
  prior_size: number
  prior_mtime_ms: number | null
}

export interface HistoryListInput {
  path?: string
  allowed_path_prefixes?: string[]
  limit?: number
  offset?: number
}
export interface HistoryListEntry {
  version: number
  path: string
  op: string
  prior_exists: boolean
  size: number
  sha256: string | null
  mtime_ms: number | null
  recorded_at: string
}
export interface HistoryListResult {
  entries: HistoryListEntry[]
}

export interface HistoryDiffInput {
  path: string
  version_a: number
  version_b: number
}
export interface HistoryDiffResult {
  is_text: boolean
  unified?: string
  meta_diff: Record<string, unknown>
  source_truncated?: boolean
  output_truncated?: boolean
}

export interface HistoryRestoreInput {
  path: string
  version: number
}
export interface HistoryRestoreResult {
  mode: "inline" | "tmp_token" | "delete"
  content_b64?: string
  tmp_token?: string
  sha256?: string
  size?: number
}

export interface IndexRebuildInput {
  subtree?: string
}
export interface IndexRebuildResult {
  task_id: string
}
export interface IndexStatusInput {
  subtree?: string
}
export interface IndexStatusResult {
  subtree: string
  last_indexed_at: string | null
  doc_count: number
  queue_depth: number
  errors: {
    extract_failed: number
    watcher_starved: number
  }
  rebuild_task?: IndexTaskStatusResult
}

export interface IndexTaskStatusInput {
  task_id: string
}
export interface IndexTaskStatusResult {
  task_id: string
  subtree: string
  status: "running" | "completed" | "failed"
  started_at: string
  finished_at: string | null
  error: string | null
}
export interface IndexUpsertInput {
  path: string
}
export interface IndexRemoveInput {
  path: string
}

export interface SearchContentInput {
  query: string
  regex?: boolean
  glob?: string
  limit: number
  offset: number
  allowed_path_prefixes: string[]
}
export interface SearchContentHit {
  path: string
  score: number
  snippet: string
  line_no?: number
  byte_offset?: number
}
export interface SearchContentResult {
  hits: SearchContentHit[]
}

export interface SearchPathInput {
  query: string
  regex?: boolean
  glob?: string
  limit: number
  offset: number
  allowed_path_prefixes: string[]
}
export interface SearchPathHit {
  path: string
  score: number
}
export interface SearchPathResult {
  hits: SearchPathHit[]
}

export interface ExtractTextInput {
  path: string
  max_bytes?: number
}
export interface ExtractTextResult {
  text: string
  mime: string
  truncated: boolean
  source: "text" | "rich" | "metadata"
  _error?: string
}

// ─────────────────────── CAS + manifest (Step 1/2) ───────────────────────────

export interface CasPutInput {
  /** Absolute host path of the source file to ingest into the CAS. */
  path: string
}
export interface CasPutResult {
  sha256: string
  size: number
  dedup: boolean
}

export interface CasHasInput {
  sha256: string
}
export interface CasHasResult {
  exists: boolean
}

export interface CasGcInput {
  /** Complete reachable set; any blob NOT in this set is deleted. */
  reachable_sha256: string[]
  /**
   * Grace window (seconds): blobs modified more recently are never deleted even
   * if unreachable, protecting in-flight commits. Helper default 3600 if omitted.
   */
  grace_secs?: number
}
export interface CasGcResult {
  deleted_count: number
}

export interface ManifestMaterializeInput {
  /** Manifest blob sha to materialize; omit/empty = empty tree. */
  manifest_sha256?: string
  /** Absolute host path of the plain directory to populate. */
  target_dir: string
}

export type ManifestEntryKind = "file" | "dir" | "symlink"
export interface ManifestEntryWire {
  path: string
  kind: ManifestEntryKind
  sha256?: string
  mode: number
  size?: number
  target?: string
}

export interface ManifestScanCommitInput {
  /** Absolute host path of the live working directory to scan. */
  dir: string
  /** What the live dir was materialized from (3-way merge base). */
  base_manifest_sha256?: string
  /** Current space head; when present and != base, a 3-way merge runs. */
  latest_manifest_sha256?: string
}
export interface ManifestScanCommitResult {
  manifest_sha256: string
  entries: ManifestEntryWire[]
  new_blobs: string[]
  conflict_paths: string[]
  entry_count: number
  total_bytes: number
}

export interface DirSyncInput {
  /** Absolute host path of the live working directory to reconcile. */
  dir: string
  /** The dir's current base manifest. */
  base_manifest_sha256?: string
  /** The new head manifest to merge toward. */
  to_manifest_sha256: string
}
/** A preserved local file from a conflict: original VFS path → sidecar path. */
export interface ConflictSidecar {
  original: string
  sidecar: string
  /**
   * What the sidecar leaf holds: "file" = the preserved bytes verbatim (read
   * directly); "symlink" = a small JSON metadata regular file
   * `{"kind":"symlink","target":"…"}` (read the JSON to recover the link target
   * — a raw symlink sidecar would be unreadable via the O_NOFOLLOW fs tools).
   */
  kind: string
  /**
   * CAS sha256 of the preserved bytes for a "file" sidecar (round-11 #1), so the
   * caller can re-materialize it after a teardown that deleted the live dir.
   */
  content_sha?: string
  /** Symlink target for a "symlink" sidecar (round-11 #1 recovery payload). */
  target?: string
}
export interface DirSyncResult {
  applied: string[]
  deferred_conflicts: string[]
  /**
   * The sidecars actually written (head-wins preserved the agent's local file
   * here). Only file/symlink conflicts produce a sidecar; dir/delete/kind
   * conflicts appear in deferred_conflicts but not here. Populated even when the
   * sync stopped early (see `incomplete`) so already-written copies aren't lost.
   */
  conflict_sidecars: ConflictSidecar[]
  /**
   * Absent = the sync fully applied. Present = it STOPPED EARLY on a per-path
   * failure (the string is the reason). On an incomplete sync the live dir is
   * only partially synced, so the caller MUST NOT advance base (no valid
   * new_base) — but the partial `conflict_sidecars` are valid and must still be
   * surfaced to the agent. The next turn re-runs the sync and self-heals.
   */
  incomplete?: string
  /** Advance file_mounts.base_snapshot_id to the snapshot for this sha. */
  new_base_manifest_sha256: string
}

export interface ManifestCleanupInput {
  /** Absolute host paths (scratch dirs) to remove. */
  paths: string[]
}

/** Re-materialize a conflict sidecar from its durable recovery payload after a
 * teardown deleted the prior live dir (round-11 #1). */
export interface SidecarRestoreInput {
  /** Absolute host path of the live mount root to restore the sidecar into. */
  dir: string
  /** The mount-relative sidecar VFS leaf (e.g. /.synapse-conflicts/<hash>). */
  sidecar_vfs: string
  /** "file" or "symlink". */
  kind: string
  /** CAS sha for a file sidecar (its bytes are already in CAS). */
  content_sha?: string
  /** Symlink target for a symlink sidecar. */
  target?: string
}
