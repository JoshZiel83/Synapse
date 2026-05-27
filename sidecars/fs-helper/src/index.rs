//! SQLite-backed index with FTS5 virtual table for content search and Tika
//! pipeline integration for rich-format documents (PDF / DOC(X) / PPT(X) /
//! XLS(X) / RTF / HTML).

use std::fs;
use std::io::Read;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use walkdir::WalkDir;

use crate::path::{canonical, host_path, under_prefix};
use crate::rpc::{IndexErrors, IndexRebuildResult, IndexStatusResult, RpcError};

const INDEX_CONTENT_CAP: u64 = 1024 * 1024;

pub struct IndexStore {
    pub conn: Connection,
    pub ignore_segments: Vec<String>,
    pub last_indexed_at: Option<String>,
    pub extract_failed: i64,
    pub tika_endpoint: Option<String>,
}

impl IndexStore {
    pub fn open(work_dir: &Path, ignore: &str) -> Result<Self, RpcError> {
        Self::open_with_tika(work_dir, ignore, None)
    }

    pub fn open_with_tika(
        work_dir: &Path,
        ignore: &str,
        tika_endpoint: Option<&str>,
    ) -> Result<Self, RpcError> {
        let db = Connection::open(work_dir.join("index.sqlite"))?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS docs (
                rowid INTEGER PRIMARY KEY,
                path TEXT UNIQUE NOT NULL,
                extension TEXT,
                mime TEXT,
                size INTEGER,
                mtime_ms INTEGER,
                source TEXT,
                indexed_at TEXT
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
                content,
                tokenize='unicode61'
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
            tika_endpoint: tika_endpoint.map(|s| s.to_string()),
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
            self.delete_subtree(&sub_canon)?;
            self.last_indexed_at = Some(now_stamp());
            return Ok(IndexRebuildResult { task_id: "rebuild-noop".into() });
        }
        self.delete_subtree(&sub_canon)?;
        let ignores = self.ignore_segments.clone();
        for entry in WalkDir::new(&host_sub).follow_links(false).into_iter().filter_map(|e| e.ok()) {
            let p = entry.path();
            let rel = match p.strip_prefix(root) { Ok(r) => r, Err(_) => continue };
            if rel.components().any(|c| ignores.iter().any(|i| *i == c.as_os_str().to_string_lossy())) {
                continue;
            }
            let canon_path = format!("/{}", rel.to_string_lossy().replace('\\', "/"));
            if !entry.file_type().is_file() { continue; }
            self.upsert_host(p, &canon_path)?;
        }
        self.last_indexed_at = Some(now_stamp());
        Ok(IndexRebuildResult { task_id: "rebuild-1".into() })
    }

    fn delete_subtree(&mut self, canon: &str) -> Result<(), RpcError> {
        let victims: Vec<(i64, String)> = {
            let mut stmt = self.conn.prepare("SELECT rowid, path FROM docs")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            let mut out = Vec::new();
            for row in rows {
                let (rid, p) = row?;
                if canon == "/" || under_prefix(&p, canon) {
                    out.push((rid, p));
                }
            }
            out
        };
        let tx = self.conn.transaction()?;
        for (rid, _p) in victims {
            tx.execute("DELETE FROM docs WHERE rowid = ?", params![rid])?;
            tx.execute("DELETE FROM docs_fts WHERE rowid = ?", params![rid])?;
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
        let meta = match fs::metadata(host) { Ok(m) => m, Err(_) => return Ok(()) };
        if !meta.is_file() { return Ok(()); }
        let size = meta.len() as i64;
        let mtime_ms = meta.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64).unwrap_or(0);
        let ext = host.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
        let mime = mime_guess::from_path(host).first_or_octet_stream().essence_str().to_string();
        let (content, source) = self.extract_for_index(host, &mime, &ext, meta.len());
        let indexed_at = now_stamp();
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO docs(path, extension, mime, size, mtime_ms, source, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET extension=excluded.extension, mime=excluded.mime, size=excluded.size, mtime_ms=excluded.mtime_ms, source=excluded.source, indexed_at=excluded.indexed_at",
            params![canon_path, ext, mime, size, mtime_ms, source, indexed_at],
        )?;
        let rowid: i64 = tx.query_row(
            "SELECT rowid FROM docs WHERE path = ?",
            params![canon_path], |r| r.get(0),
        )?;
        tx.execute("DELETE FROM docs_fts WHERE rowid = ?", params![rowid])?;
        if !content.is_empty() {
            tx.execute(
                "INSERT INTO docs_fts(rowid, content) VALUES (?, ?)",
                params![rowid, content],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn extract_for_index(
        &mut self, host: &Path, mime: &str, ext: &str, size: u64,
    ) -> (String, &'static str) {
        // Rich-format MIME + Tika configured → call Tika.
        if is_rich_format(mime, ext) {
            if let Some(endpoint) = self.tika_endpoint.clone() {
                match tika_extract_blocking(&endpoint, host, mime, INDEX_CONTENT_CAP * 4) {
                    Ok(text) => return (text, "rich"),
                    Err(_) => {
                        self.extract_failed += 1;
                        return (String::new(), "extract_failed");
                    }
                }
            }
            // No Tika endpoint → mark and skip content.
            self.extract_failed += 1;
            return (String::new(), "no_tika");
        }
        // Plain text path: cap-bounded stream-read.
        if size > INDEX_CONTENT_CAP {
            self.extract_failed += 1;
            return (String::new(), "too_large");
        }
        let mut buf = Vec::with_capacity(size as usize);
        let read_result = fs::File::open(host).and_then(|f| {
            f.take(INDEX_CONTENT_CAP).read_to_end(&mut buf).map(|_| ())
        });
        if read_result.is_err() {
            self.extract_failed += 1;
            return (String::new(), "read_failed");
        }
        match String::from_utf8(buf) {
            Ok(s) => (s, "text"),
            Err(_) => {
                self.extract_failed += 1;
                (String::new(), "binary")
            }
        }
    }

    pub fn remove(&mut self, path: &str) -> Result<(), RpcError> {
        let canon = canonical(path)?;
        let rowid: Option<i64> = self.conn.query_row(
            "SELECT rowid FROM docs WHERE path = ?",
            params![canon], |r| r.get(0),
        ).optional()?;
        if let Some(rid) = rowid {
            self.conn.execute("DELETE FROM docs WHERE rowid = ?", params![rid])?;
            self.conn.execute("DELETE FROM docs_fts WHERE rowid = ?", params![rid])?;
        }
        Ok(())
    }

    pub fn status(&self, subtree: &str) -> Result<IndexStatusResult, RpcError> {
        let canon = canonical(subtree)?;
        let count: i64 = if canon == "/" {
            self.conn.query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0))
                .optional()?.unwrap_or(0)
        } else {
            let mut stmt = self.conn.prepare("SELECT path FROM docs")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            let mut n: i64 = 0;
            for r in rows {
                if under_prefix(&r?, &canon) { n += 1; }
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

    /// FTS5-backed content search. Emits up to `limit` hits ordered by bm25.
    pub fn fts_search<F: FnMut(&str, f64, &str)>(
        &self, query: &str, allowed_prefixes: &[String], limit: usize, mut hit: F,
    ) -> Result<(), RpcError> {
        let mut stmt = self.conn.prepare(
            "SELECT docs.path, bm25(docs_fts) AS score,
                    snippet(docs_fts, 0, '', '', '...', 32) AS snip
             FROM docs_fts JOIN docs ON docs.rowid = docs_fts.rowid
             WHERE docs_fts MATCH ?
             ORDER BY score
             LIMIT ?",
        )?;
        let escaped = fts5_escape(query);
        let over_fetch = (limit as i64) * 4;
        let rows = stmt.query_map(params![escaped, over_fetch], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, String>(2)?))
        })?;
        let mut emitted = 0usize;
        for row in rows {
            let (p, score, snip) = row?;
            if !allowed_prefixes.is_empty()
                && !allowed_prefixes.iter().any(|pref| under_prefix(&p, pref))
            { continue; }
            hit(&p, -score, &snip);
            emitted += 1;
            if emitted >= limit { break; }
        }
        Ok(())
    }

    /// All paths under allowed_prefixes — used by search_path nucleo fuzzy.
    pub fn iter_paths<F: FnMut(&str)>(
        &self, allowed_prefixes: &[String], mut visit: F,
    ) -> Result<(), RpcError> {
        let mut stmt = self.conn.prepare("SELECT path FROM docs")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for r in rows {
            let p = r?;
            if allowed_prefixes.is_empty()
                || allowed_prefixes.iter().any(|pref| under_prefix(&p, pref))
            { visit(&p); }
        }
        Ok(())
    }
}

fn now_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let s = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    format!("ts:{s}")
}

pub fn allowed(path: &str, prefixes: &[String]) -> bool {
    if prefixes.is_empty() { return false; }
    prefixes.iter().any(|p| under_prefix(path, p))
}

fn is_rich_format(mime: &str, ext: &str) -> bool {
    let m = mime.to_ascii_lowercase();
    let e = ext.to_ascii_lowercase();
    matches!(m.as_str(),
        "application/pdf"
        | "application/msword"
        | "application/vnd.ms-excel"
        | "application/vnd.ms-powerpoint"
        | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        | "application/rtf" | "text/rtf"
        | "text/html" | "application/xhtml+xml"
        | "application/epub+zip"
    ) || matches!(e.as_str(),
        "pdf" | "doc" | "docx" | "ppt" | "pptx" | "xls" | "xlsx"
        | "rtf" | "html" | "htm" | "epub" | "odt" | "ods" | "odp"
    )
}

fn fts5_escape(q: &str) -> String {
    let trimmed = q.trim();
    if trimmed.is_empty() { return "\"\"".into(); }
    trimmed.split_whitespace().map(|tok| {
        let esc = tok.replace('"', "\"\"");
        format!("\"{esc}\"")
    }).collect::<Vec<_>>().join(" ")
}

fn tika_extract_blocking(
    endpoint: &str, host: &Path, mime: &str, max_bytes: u64,
) -> Result<String, String> {
    let url = format!("{}/tika", endpoint.trim_end_matches('/'));
    let meta = std::fs::metadata(host).map_err(|e| e.to_string())?;
    let cap = max_bytes.min(meta.len()) as usize;
    let file = std::fs::File::open(host).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(cap.min(64 * 1024));
    file.take(cap as u64).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let mime_owned = mime.to_string();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    rt.block_on(async move {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let res = client.put(&url)
            .header("Accept", "text/plain")
            .header("Content-Type", &mime_owned)
            .body(buf)
            .send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("tika_http_{}", res.status().as_u16()));
        }
        res.text().await.map_err(|e| e.to_string())
    })
}
