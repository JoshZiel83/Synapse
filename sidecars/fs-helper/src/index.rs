//! Simple SQLite-backed index. v1 stores (path, content) in a table; FTS5
//! is optional and not yet wired (rusqlite bundled supports it, but v1
//! keeps the implementation minimal — plan flagged Tantivy as future work).
//! Search uses LIKE / substring with the boundary-aware allowed_path_prefixes
//! filter applied at query time.

use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use walkdir::WalkDir;

use crate::path::{canonical, host_path, under_prefix};
use crate::rpc::{IndexErrors, IndexRebuildResult, IndexStatusResult, RpcError};

pub struct IndexStore {
    pub conn: Connection,
    pub ignore_segments: Vec<String>,
    pub last_indexed_at: Option<String>,
    pub extract_failed: i64,
}

impl IndexStore {
    pub fn open(work_dir: &Path, ignore: &str) -> Result<Self, RpcError> {
        let db = Connection::open(work_dir.join("index.sqlite"))?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS docs (
                path TEXT PRIMARY KEY,
                extension TEXT,
                mime TEXT,
                size INTEGER,
                mtime_ms INTEGER,
                content TEXT,
                indexed_at TEXT
             );",
        )?;
        let ignore_segments: Vec<String> = ignore
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        Ok(Self {
            conn: db,
            ignore_segments,
            last_indexed_at: None,
            extract_failed: 0,
        })
    }

    fn is_ignored(&self, rel: &Path) -> bool {
        rel.components().any(|c| {
            let s = c.as_os_str().to_string_lossy();
            self.ignore_segments.iter().any(|i| i == &s)
        })
    }

    pub fn rebuild(
        &mut self,
        root: &Path,
        subtree: Option<&str>,
    ) -> Result<IndexRebuildResult, RpcError> {
        let sub = subtree.unwrap_or("/");
        let sub_canon = canonical(sub)?;
        let host_sub = host_path(root, &sub_canon)?;
        if !host_sub.exists() {
            // No-op: clear the subtree from the index.
            let pattern = sub_canon.clone();
            self.delete_subtree(&pattern)?;
            self.last_indexed_at = Some(now_stamp());
            return Ok(IndexRebuildResult { task_id: "rebuild-noop".into() });
        }
        // Boundary-aware delete: only entries under `sub_canon`.
        self.delete_subtree(&sub_canon)?;
        // Walk + upsert.
        for entry in WalkDir::new(&host_sub).follow_links(false).into_iter().filter_map(|e| e.ok()) {
            let p = entry.path();
            let rel = match p.strip_prefix(root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            if self.is_ignored(rel) { continue; }
            let canon_path = format!("/{}", rel.to_string_lossy().replace('\\', "/"));
            if entry.file_type().is_dir() { continue; }
            if !entry.file_type().is_file() { continue; }
            self.upsert_host(p, &canon_path)?;
        }
        self.last_indexed_at = Some(now_stamp());
        Ok(IndexRebuildResult { task_id: "rebuild-1".into() })
    }

    fn delete_subtree(&mut self, canon: &str) -> Result<(), RpcError> {
        if canon == "/" {
            self.conn.execute("DELETE FROM docs", [])?;
            return Ok(());
        }
        // Collect candidate paths via boundary-aware Rust filter, then delete
        // by exact path. Using SQL `LIKE` would mis-handle literal `_` / `%`
        // in paths (e.g. `/foo_` would also match `/fooa` under LIKE).
        let mut victims: Vec<String> = Vec::new();
        {
            let mut stmt = self.conn.prepare("SELECT path FROM docs")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            for row in rows {
                let p = row?;
                if under_prefix(&p, canon) {
                    victims.push(p);
                }
            }
        }
        let tx = self.conn.transaction()?;
        for p in victims {
            tx.execute("DELETE FROM docs WHERE path = ?", params![p])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn upsert(&mut self, root: &Path, path: &str) -> Result<(), RpcError> {
        let canon = canonical(path)?;
        let host = host_path(root, &canon)?;
        if !host.exists() {
            self.remove(&canon)?;
            return Ok(());
        }
        self.upsert_host(&host, &canon)
    }

    fn upsert_host(&mut self, host: &Path, canon_path: &str) -> Result<(), RpcError> {
        let meta = match fs::metadata(host) {
            Ok(m) => m,
            Err(_) => return Ok(()),
        };
        if !meta.is_file() {
            return Ok(());
        }
        let size = meta.len() as i64;
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        // Stream up to 1 MiB only — never read the full file. Files larger
        // than the cap are indexed metadata-only (no content).
        const INDEX_CONTENT_CAP: u64 = 1024 * 1024;
        let content = if (meta.len() as u64) > INDEX_CONTENT_CAP {
            self.extract_failed += 1;
            String::new()
        } else {
            let mut buf = Vec::with_capacity(meta.len() as usize);
            match fs::File::open(host).and_then(|f| {
                use std::io::Read;
                f.take(INDEX_CONTENT_CAP).read_to_end(&mut buf).map(|_| ())
            }) {
                Ok(()) => String::from_utf8(buf).unwrap_or_else(|_| {
                    self.extract_failed += 1;
                    String::new()
                }),
                Err(_) => {
                    self.extract_failed += 1;
                    String::new()
                }
            }
        };
        let ext = host
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();
        let mime = mime_guess::from_path(host)
            .first_or_octet_stream()
            .essence_str()
            .to_string();
        let indexed_at = now_stamp();
        self.conn.execute(
            "INSERT INTO docs(path, extension, mime, size, mtime_ms, content, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET extension=excluded.extension, mime=excluded.mime, size=excluded.size, mtime_ms=excluded.mtime_ms, content=excluded.content, indexed_at=excluded.indexed_at",
            params![canon_path, ext, mime, size, mtime_ms, content, indexed_at],
        )?;
        Ok(())
    }

    pub fn remove(&mut self, path: &str) -> Result<(), RpcError> {
        let canon = canonical(path)?;
        self.conn.execute("DELETE FROM docs WHERE path = ?", params![canon])?;
        Ok(())
    }

    pub fn status(&self, subtree: &str) -> Result<IndexStatusResult, RpcError> {
        let canon = canonical(subtree)?;
        let count: i64 = if canon == "/" {
            self.conn
                .query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0))
                .optional()?
                .unwrap_or(0)
        } else {
            // Boundary-aware count via Rust filter (avoids SQL LIKE wildcard
            // collisions on paths containing `_` or `%`).
            let mut stmt = self.conn.prepare("SELECT path FROM docs")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            let mut n: i64 = 0;
            for r in rows {
                if under_prefix(&r?, &canon) {
                    n += 1;
                }
            }
            n
        };
        Ok(IndexStatusResult {
            subtree: canon,
            last_indexed_at: self.last_indexed_at.clone(),
            doc_count: count,
            queue_depth: 0,
            errors: IndexErrors {
                extract_failed: self.extract_failed,
                watcher_starved: 0,
            },
        })
    }

    /// Iterate all docs (path + content) — used by search.
    pub fn all_paths_with_content<F: FnMut(&str, &str)>(&self, mut f: F) -> Result<(), RpcError> {
        let mut stmt = self.conn.prepare("SELECT path, content FROM docs")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (p, c) = row?;
            f(&p, &c);
        }
        Ok(())
    }
}

fn now_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let s = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    format!("ts:{s}")
}

/// Helper for search.rs — boundary-aware filter.
pub fn allowed(path: &str, prefixes: &[String]) -> bool {
    if prefixes.is_empty() { return false; }
    prefixes.iter().any(|p| under_prefix(path, p))
}
