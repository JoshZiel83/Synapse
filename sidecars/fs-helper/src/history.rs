//! SQLite-backed history store with GC.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension, Row};
use similar::TextDiff;

use crate::blobs::BlobStore;
use crate::path::{canonical, host_path, under_prefix};
use crate::rpc::{
    HistoryDiffResult, HistoryGetResult, HistoryListEntry, HistoryListInput,
    HistoryListResult, HistoryRestoreResult, HistorySnapshotInput, HistorySnapshotResult,
    RpcError,
};

pub struct HistoryLimits {
    pub max_history_bytes: u64,
    pub max_versions_per_path: u32,
    pub keep_recent_versions: u32,
    pub max_snapshot_bytes: u64,
}

pub struct HistoryStore {
    conn: Connection,
    blobs: BlobStore,
    limits: HistoryLimits,
    work_dir: std::path::PathBuf,
}

impl HistoryStore {
    pub fn open(work_dir: &Path, limits: HistoryLimits) -> Result<Self, RpcError> {
        let blobs = BlobStore::open(work_dir)?;
        let db_path = work_dir.join("history.sqlite");
        let conn = Connection::open(&db_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS versions (
                version INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL,
                op TEXT NOT NULL,
                prior_exists INTEGER NOT NULL,
                blob_sha256 TEXT,
                prior_size INTEGER NOT NULL,
                prior_mtime_ms INTEGER,
                recorded_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS versions_by_path ON versions(path, version);
             CREATE TABLE IF NOT EXISTS blobs_refcount (
                sha256 TEXT PRIMARY KEY,
                count INTEGER NOT NULL
             );",
        )?;
        Ok(Self { conn, blobs, limits, work_dir: work_dir.to_path_buf() })
    }

    pub fn snapshot(
        &mut self,
        root: &Path,
        input: &HistorySnapshotInput,
        is_delete: bool,
    ) -> Result<HistorySnapshotResult, RpcError> {
        let canon = canonical(&input.path)?;
        let op = if is_delete {
            "delete".to_string()
        } else {
            input.op.clone()
        };
        if input.prior_exists {
            if input.prior_size > self.limits.max_snapshot_bytes {
                return Err(RpcError::HistoryQuotaExceeded(format!(
                    "snapshot_too_large: {} bytes (cap {})",
                    input.prior_size, self.limits.max_snapshot_bytes
                )));
            }
            self.gc()?;
            let stored = self.total_blob_bytes()?;
            if stored.saturating_add(input.prior_size) > self.limits.max_history_bytes {
                return Err(RpcError::HistoryQuotaExceeded(format!(
                    "history_quota_exceeded: would push past {} bytes",
                    self.limits.max_history_bytes
                )));
            }
        }
        let (blob_sha, dedup) = if input.prior_exists {
            let src = host_path(root, &canon)?;
            let (sha, _size, dedup) = self
                .blobs
                .put_streaming(&src, input.expected_sha256.as_deref())?;
            self.bump_refcount(&sha, 1)?;
            (Some(sha), dedup)
        } else {
            (None, false)
        };
        let recorded_at = now_rfc3339();
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO versions(path, op, prior_exists, blob_sha256, prior_size, prior_mtime_ms, recorded_at) VALUES (?,?,?,?,?,?,?)",
            params![
                canon, op, input.prior_exists as i64, blob_sha,
                input.prior_size as i64, input.prior_mtime_ms, recorded_at,
            ],
        )?;
        let version = tx.last_insert_rowid();
        tx.commit()?;
        self.prune_per_path(&canon)?;
        Ok(HistorySnapshotResult { version, blob_dedup: dedup })
    }

    pub fn get(&self, path: &str, version: i64) -> Result<HistoryGetResult, RpcError> {
        let canon = canonical(path)?;
        let mut stmt = self.conn.prepare(
            "SELECT op, prior_exists, blob_sha256, prior_size, prior_mtime_ms, recorded_at FROM versions WHERE path = ? AND version = ?",
        )?;
        let row = stmt
            .query_row(params![canon, version], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)? != 0,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .optional()?
            .ok_or_else(|| RpcError::NotFound(format!("{path}@{version}")))?;
        Ok(HistoryGetResult {
            prior_exists: row.1,
            size: row.3 as u64,
            sha256: row.2,
            mtime_ms: row.4,
            op: row.0,
            recorded_at: row.5,
        })
    }

    pub fn list(
        &self,
        input: &HistoryListInput,
        max_limit: u32,
        max_offset: u32,
    ) -> Result<HistoryListResult, RpcError> {
        let limit = input.limit.unwrap_or(50);
        if limit == 0 || limit > max_limit {
            return Err(RpcError::InvalidParams(format!("limit_out_of_range: 1..={max_limit}")));
        }
        let offset = input.offset.unwrap_or(0);
        if offset > max_offset {
            return Err(RpcError::InvalidParams(format!("offset_out_of_range: 0..={max_offset}")));
        }
        // Eagerly validate the path arg if present so /.synapse-internal/...
        // rejects with invalid_path regardless of SQL state.
        let path_canon: Option<String> = match &input.path {
            Some(p) => Some(canonical(p)?),
            None => None,
        };
        let mut stmt = self.conn.prepare(
            "SELECT version, path, op, prior_exists, blob_sha256, prior_size, prior_mtime_ms, recorded_at FROM versions ORDER BY version DESC",
        )?;
        let rows = stmt.query_map([], row_to_entry)?;
        let mut entries: Vec<HistoryListEntry> = Vec::new();
        for r in rows {
            let e = r?;
            if let Some(canon) = &path_canon {
                if e.path != *canon { continue; }
            } else if let Some(prefixes) = &input.allowed_path_prefixes {
                if !prefixes.iter().any(|pref| under_prefix(&e.path, pref)) { continue; }
            } else {
                continue;
            }
            entries.push(e);
        }
        let sliced = entries.into_iter().skip(offset as usize).take(limit as usize).collect();
        Ok(HistoryListResult { entries: sliced })
    }

    pub fn diff(
        &self,
        path: &str,
        va: i64,
        vb: i64,
        max_source_bytes: u64,
        max_output_bytes: u64,
    ) -> Result<HistoryDiffResult, RpcError> {
        let a = self.get(path, va)?;
        let b = self.get(path, vb)?;
        if a.size > max_source_bytes || b.size > max_source_bytes {
            return Ok(HistoryDiffResult {
                is_text: false, unified: None,
                meta_diff: serde_json::json!({ "size_a": a.size, "size_b": b.size }),
                source_truncated: Some(true), output_truncated: None,
            });
        }
        let bytes_a = match &a.sha256 { Some(s) => self.blobs.read(s)?, None => Vec::new() };
        let bytes_b = match &b.sha256 { Some(s) => self.blobs.read(s)?, None => Vec::new() };
        let text_a = match std::str::from_utf8(&bytes_a) { Ok(s) => s.to_string(), Err(_) => {
            return Ok(HistoryDiffResult {
                is_text: false, unified: None,
                meta_diff: serde_json::json!({ "size_a": a.size, "size_b": b.size }),
                source_truncated: None, output_truncated: None,
            });
        }};
        let text_b = match std::str::from_utf8(&bytes_b) { Ok(s) => s.to_string(), Err(_) => {
            return Ok(HistoryDiffResult {
                is_text: false, unified: None,
                meta_diff: serde_json::json!({ "size_a": a.size, "size_b": b.size }),
                source_truncated: None, output_truncated: None,
            });
        }};
        let diff = TextDiff::from_lines(&text_a, &text_b);
        let mut unified = String::new();
        let mut output_truncated = false;
        for hunk in diff
            .unified_diff()
            .context_radius(3)
            .header(&format!("{path}@{va}"), &format!("{path}@{vb}"))
            .iter_hunks()
        {
            let s = format!("{}", hunk);
            if unified.len().saturating_add(s.len()) as u64 > max_output_bytes {
                output_truncated = true;
                break;
            }
            unified.push_str(&s);
        }
        Ok(HistoryDiffResult {
            is_text: true,
            unified: Some(unified),
            meta_diff: serde_json::json!({ "size_delta": (b.size as i64) - (a.size as i64) }),
            source_truncated: None,
            output_truncated: if output_truncated { Some(true) } else { None },
        })
    }

    pub fn restore(
        &self,
        root: &Path,
        path: &str,
        version: i64,
    ) -> Result<HistoryRestoreResult, RpcError> {
        let g = self.get(path, version)?;
        if !g.prior_exists {
            return Ok(HistoryRestoreResult {
                mode: "delete", content_b64: None, tmp_token: None,
                sha256: None, size: None,
            });
        }
        let sha = g.sha256.clone().ok_or_else(|| {
            RpcError::Internal(format!("history row {path}@{version} prior_exists=true but blob_sha256 NULL"))
        })?;
        const INLINE_THRESHOLD: u64 = 8 * 1024 * 1024;
        // Decide on mode using the recorded metadata size — NOT the full
        // blob bytes. Otherwise a 5 GiB historical blob would be slurped
        // into memory just to discover it's too big for inline mode.
        if g.size <= INLINE_THRESHOLD {
            let bytes = self.blobs.read(&sha)?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            return Ok(HistoryRestoreResult {
                mode: "inline",
                content_b64: Some(b64),
                tmp_token: None,
                sha256: Some(sha),
                size: Some(g.size),
            });
        }
        // Stage large blob to /.synapse-internal/restore/restore-<32hex>
        // via streaming copy (stage_to streams through 64 KiB buffer).
        let token = format!("restore-{}", make_token());
        let dest = root.join(".synapse-internal").join("restore").join(&token);
        std::fs::create_dir_all(dest.parent().unwrap())?;
        self.blobs.stage_to(&sha, &dest)?;
        let _ = self.work_dir.exists(); // touch field
        Ok(HistoryRestoreResult {
            mode: "tmp_token",
            content_b64: None,
            tmp_token: Some(token),
            sha256: Some(sha),
            size: Some(g.size),
        })
    }

    // ─── GC ─────────────────────────────────────────────────────────────────

    fn total_blob_bytes(&self) -> Result<u64, RpcError> {
        let total: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(prior_size), 0) FROM versions WHERE blob_sha256 IS NOT NULL",
            [],
            |r| r.get(0),
        )?;
        Ok(total as u64)
    }

    fn prune_per_path(&mut self, path: &str) -> Result<(), RpcError> {
        let cap = self.limits.max_versions_per_path as i64;
        let keep = self.limits.keep_recent_versions as i64;
        if keep > cap { return Ok(()); }
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM versions WHERE path = ?",
            params![path],
            |r| r.get(0),
        )?;
        if count <= cap { return Ok(()); }
        let to_delete = count - cap;
        let rows: Vec<(i64, Option<String>)> = {
            let mut stmt = self.conn.prepare(
                "SELECT version, blob_sha256 FROM versions WHERE path = ? ORDER BY version ASC LIMIT ?",
            )?;
            let collected = stmt
                .query_map(params![path, to_delete], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            collected
        };
        for (v, sha) in rows {
            self.conn.execute("DELETE FROM versions WHERE version = ?", params![v])?;
            if let Some(s) = sha {
                self.bump_refcount(&s, -1)?;
                let refs = self.refcount(&s)?;
                if refs == 0 {
                    let _ = self.blobs.delete(&s);
                }
            }
        }
        Ok(())
    }

    fn gc(&mut self) -> Result<(), RpcError> {
        let stored = self.total_blob_bytes()?;
        let high = self.limits.max_history_bytes * 9 / 10;
        if stored < high { return Ok(()); }
        let low = self.limits.max_history_bytes * 3 / 4;
        let keep = self.limits.keep_recent_versions as i64;
        let candidates: Vec<(i64, String, Option<String>, i64)> = {
            let mut stmt = self.conn.prepare(
                "SELECT version, path, blob_sha256, prior_size FROM versions ORDER BY version ASC",
            )?;
            let collected = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            collected
        };
        let mut current = stored;
        for (v, p, sha, sz) in candidates {
            if current <= low { break; }
            let position: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM versions WHERE path = ? AND version > ?",
                params![p, v],
                |r| r.get(0),
            )?;
            if position < keep { continue; }
            self.conn.execute("DELETE FROM versions WHERE version = ?", params![v])?;
            if let Some(s) = sha {
                self.bump_refcount(&s, -1)?;
                let refs = self.refcount(&s)?;
                if refs == 0 {
                    let _ = self.blobs.delete(&s);
                    current = current.saturating_sub(sz as u64);
                }
            }
        }
        Ok(())
    }

    fn refcount(&self, sha: &str) -> Result<i64, RpcError> {
        Ok(self.conn.query_row(
            "SELECT count FROM blobs_refcount WHERE sha256 = ?",
            params![sha], |r| r.get(0),
        ).optional()?.unwrap_or(0))
    }

    fn bump_refcount(&mut self, sha: &str, delta: i64) -> Result<(), RpcError> {
        let cur = self.refcount(sha)?;
        let next = cur + delta;
        if next <= 0 {
            self.conn.execute("DELETE FROM blobs_refcount WHERE sha256 = ?", params![sha])?;
        } else if cur == 0 {
            self.conn.execute("INSERT INTO blobs_refcount(sha256, count) VALUES(?, ?)", params![sha, next])?;
        } else {
            self.conn.execute("UPDATE blobs_refcount SET count = ? WHERE sha256 = ?", params![next, sha])?;
        }
        Ok(())
    }
}

fn row_to_entry(r: &Row) -> rusqlite::Result<HistoryListEntry> {
    Ok(HistoryListEntry {
        version: r.get(0)?,
        path: r.get(1)?,
        op: r.get(2)?,
        prior_exists: r.get::<_, i64>(3)? != 0,
        size: r.get::<_, i64>(5)? as u64,
        sha256: r.get(4)?,
        mtime_ms: r.get(6)?,
        recorded_at: r.get(7)?,
    })
}

fn now_rfc3339() -> String {
    // Minimal RFC3339-ish stamp without chrono.
    let dur = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
    // Convert epoch seconds to YYYY-MM-DDTHH:MM:SS.mmmZ.
    let (year, mon, day, hh, mm, ss) = epoch_to_ymdhms(secs);
    format!("{year:04}-{mon:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

fn epoch_to_ymdhms(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let hh = (rem / 3_600) as u32;
    let mm = ((rem % 3_600) / 60) as u32;
    let ss = (rem % 60) as u32;
    // Compute YMD via Howard Hinnant's days-from-civil inverse.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let mon = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = (y + if mon <= 2 { 1 } else { 0 }) as i32;
    (year, mon, day, hh, mm, ss)
}

fn make_token() -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(std::process::id().to_be_bytes());
    h.update(now_rfc3339().as_bytes());
    let bytes = h.finalize();
    hex::encode(&bytes[..16])
}
