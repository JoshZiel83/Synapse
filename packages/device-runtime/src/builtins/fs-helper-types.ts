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
