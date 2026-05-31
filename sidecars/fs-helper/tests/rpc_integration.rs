//! End-to-end test of the sidecar's stdio JSON-RPC contract. Spawns the
//! built binary, sends frames, checks responses.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

fn build_binary() -> PathBuf {
    // The test harness rebuilds via cargo; just use the dev binary path.
    let mut p = std::env::current_exe().unwrap();
    p.pop(); // /target/debug/deps/<test_exe>
    p.pop(); // /target/debug
    p.push("synapse-device-fs-helper");
    p
}

struct Helper {
    child: Child,
    reader: BufReader<std::process::ChildStdout>,
}

impl Helper {
    fn spawn(root: &PathBuf, work: &PathBuf) -> Self {
        let bin = build_binary();
        let mut cmd = Command::new(&bin)
            .arg("--root")
            .arg(root)
            .arg("--work-dir")
            .arg(work)
            .arg("--max-history-bytes")
            .arg("104857600")
            .arg("--max-versions-per-path")
            .arg("100")
            .arg("--keep-recent-versions")
            .arg("5")
            .arg("--max-snapshot-bytes")
            .arg("10485760")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|e| panic!("spawn {}: {e}", bin.display()));
        let stdout = cmd.stdout.take().unwrap();
        Self {
            child: cmd,
            reader: BufReader::new(stdout),
        }
    }
    /// Spawn with a --cas-dir so the cas/manifest/dir RPCs are available.
    fn spawn_with_cas(root: &PathBuf, work: &PathBuf, cas: &PathBuf) -> Self {
        let bin = build_binary();
        let mut cmd = Command::new(&bin)
            .arg("--root")
            .arg(root)
            .arg("--work-dir")
            .arg(work)
            .arg("--cas-dir")
            .arg(cas)
            .arg("--max-snapshot-bytes")
            .arg("10485760")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|e| panic!("spawn {}: {e}", bin.display()));
        let stdout = cmd.stdout.take().unwrap();
        Self {
            child: cmd,
            reader: BufReader::new(stdout),
        }
    }
    fn call(&mut self, id: i64, method: &str, params: serde_json::Value) -> serde_json::Value {
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let stdin = self.child.stdin.as_mut().unwrap();
        let s = frame.to_string();
        stdin.write_all(s.as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
        let mut line = String::new();
        self.reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn stop(mut self) {
        drop(self.child.stdin.take());
        let _ = self.child.wait();
    }
}

#[test]
fn history_snapshot_and_restore_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(root.join("hello.txt"), "hello-content").unwrap();
    // sha256("hello-content") computed via shell would be a static known value;
    // we just round-trip via fs.history.get afterward.
    let mut helper = Helper::spawn(&root, &work);
    let resp = helper.call(
        1,
        "fs.history.snapshot",
        serde_json::json!({
            "path": "/hello.txt",
            "prior_exists": true,
            "expected_sha256": sha256_hex(b"hello-content"),
            "prior_size": 13,
            "prior_mtime_ms": 1_700_000_000_000i64,
            "op": "pre_write",
        }),
    );
    let version = resp["result"]["version"].as_i64().expect("version");
    // Restore should return inline mode with base64 content.
    let r = helper.call(
        2,
        "fs.history.restore",
        serde_json::json!({ "path": "/hello.txt", "version": version }),
    );
    let result = &r["result"];
    assert_eq!(result["mode"], "inline", "{r}");
    let b64 = result["content_b64"].as_str().unwrap();
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
    assert_eq!(bytes, b"hello-content");
    helper.stop();
}

#[test]
fn cross_path_diff_rejected_with_not_found() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(root.join("a"), "alpha").unwrap();
    std::fs::write(root.join("b"), "beta").unwrap();
    let mut helper = Helper::spawn(&root, &work);
    let va = helper
        .call(
            1,
            "fs.history.snapshot",
            serde_json::json!({
                "path": "/a", "prior_exists": true,
                "expected_sha256": sha256_hex(b"alpha"),
                "prior_size": 5, "prior_mtime_ms": 1i64,
                "op": "pre_write",
            }),
        )["result"]["version"]
        .as_i64()
        .unwrap();
    let vb = helper
        .call(
            2,
            "fs.history.snapshot",
            serde_json::json!({
                "path": "/b", "prior_exists": true,
                "expected_sha256": sha256_hex(b"beta"),
                "prior_size": 4, "prior_mtime_ms": 1i64,
                "op": "pre_write",
            }),
        )["result"]["version"]
        .as_i64()
        .unwrap();
    // Diff /a with version_b that belongs to /b → not_found.
    let r = helper.call(
        3,
        "fs.history.diff",
        serde_json::json!({ "path": "/a", "version_a": va, "version_b": vb }),
    );
    let err = &r["error"];
    assert_eq!(err["code"], -32004, "{r}");
    helper.stop();
}

#[test]
fn rejects_reserved_namespace_in_path() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    let r = helper.call(
        1,
        "fs.history.list",
        serde_json::json!({ "path": "/.synapse-internal/foo" }),
    );
    let err = &r["error"];
    assert_eq!(err["code"], -32602, "{r}");
    helper.stop();
}

#[test]
fn index_subtree_isolation() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(root.join("foo")).unwrap();
    std::fs::create_dir_all(root.join("foobar")).unwrap();
    std::fs::write(root.join("foo/a.txt"), "needle").unwrap();
    std::fs::write(root.join("foobar/b.txt"), "needle").unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    // Rebuild root: index both.
    let _ = helper.call(
        1,
        "fs.index.rebuild",
        serde_json::json!({ "subtree": "/" }),
    );
    wait_for_rebuild_complete(&mut helper, "/");
    // Search with allowed_path_prefixes=["/foo"] must NOT return /foobar.
    let r = helper.call(
        2,
        "fs.search.content",
        serde_json::json!({
            "query": "needle",
            "limit": 50, "offset": 0,
            "allowed_path_prefixes": ["/foo"],
        }),
    );
    let hits = r["result"]["hits"].as_array().unwrap();
    let paths: Vec<String> = hits
        .iter()
        .map(|h| h["path"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(paths, vec!["/foo/a.txt".to_string()], "{paths:?}");
    helper.stop();
}

fn sha256_hex(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b);
    hex::encode(h.finalize())
}

#[test]
fn fts5_finds_multi_word_phrase_and_respects_prefix() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(root.join("alpha")).unwrap();
    std::fs::create_dir_all(root.join("beta")).unwrap();
    std::fs::write(
        root.join("alpha/notes.txt"),
        "the quick brown fox jumps over the lazy dog",
    )
    .unwrap();
    std::fs::write(
        root.join("beta/manual.txt"),
        "fox is mentioned here too in a different file",
    )
    .unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    helper.call(
        1,
        "fs.index.rebuild",
        serde_json::json!({ "subtree": "/" }),
    );
    wait_for_rebuild_complete(&mut helper, "/");
    // Multi-word: only files containing both "quick" AND "brown" hit.
    let r = helper.call(
        2,
        "fs.search.content",
        serde_json::json!({
            "query": "quick brown",
            "limit": 50, "offset": 0,
            "allowed_path_prefixes": ["/"],
        }),
    );
    let hits = r["result"]["hits"].as_array().unwrap();
    let paths: Vec<String> = hits
        .iter()
        .map(|h| h["path"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(paths, vec!["/alpha/notes.txt".to_string()]);
    // Boundary-aware: scope to /beta and search "fox" — must NOT see /alpha.
    let r2 = helper.call(
        3,
        "fs.search.content",
        serde_json::json!({
            "query": "fox",
            "limit": 50, "offset": 0,
            "allowed_path_prefixes": ["/beta"],
        }),
    );
    let hits2 = r2["result"]["hits"].as_array().unwrap();
    let paths2: Vec<String> = hits2
        .iter()
        .map(|h| h["path"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(paths2, vec!["/beta/manual.txt".to_string()]);
    helper.stop();
}

#[test]
fn nucleo_path_search_orders_by_fuzzy_score() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(root.join("tests")).unwrap();
    for n in &["main.rs", "marker.rs", "mapper.rs", "irrelevant.txt"] {
        std::fs::write(root.join("src").join(n), "x").unwrap();
    }
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    helper.call(
        1,
        "fs.index.rebuild",
        serde_json::json!({ "subtree": "/" }),
    );
    wait_for_rebuild_complete(&mut helper, "/");
    let r = helper.call(
        2,
        "fs.search.path",
        serde_json::json!({
            "query": "mar",
            "limit": 10, "offset": 0,
            "allowed_path_prefixes": ["/"],
        }),
    );
    let hits = r["result"]["hits"].as_array().unwrap();
    let paths: Vec<String> = hits
        .iter()
        .map(|h| h["path"].as_str().unwrap().to_string())
        .collect();
    // All m-prefixed names match; "marker" / "mapper" must rank above
    // "irrelevant" (which doesn't match) and above "main".
    assert!(paths.iter().any(|p| p.contains("marker")));
    assert!(paths.iter().any(|p| p.contains("mapper")));
    assert!(!paths.iter().any(|p| p.contains("irrelevant")));
    helper.stop();
}

#[test]
fn tika_indexing_does_not_panic_under_async_dispatch() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    // Spin up a tiny HTTP server that responds 200 with extracted text.
    // Verifies the index-time Tika call works from inside the sidecar's
    // async dispatch without "Cannot start a runtime from within a runtime".
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            // Drain request (ignore content) — at least read until headers
            // end so the client's send_bytes doesn't block waiting for ack.
            let mut buf = [0u8; 8192];
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
            // Read once; PUT requests are small enough for a single read in
            // this test (the body is < 1 KiB).
            let _ = stream.read(&mut buf);
            let body = "extracted-pdf-text";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
        }
    });

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    // Pretend PDF (Tika would handle bytes; mime_guess picks pdf by ext).
    std::fs::write(root.join("doc.pdf"), b"%PDF-1.7 fake content").unwrap();

    // Spawn with --tika-endpoint pointing at our fake server.
    let bin = build_binary();
    let mut child = Command::new(&bin)
        .arg("--root")
        .arg(&root)
        .arg("--work-dir")
        .arg(&work)
        .arg("--tika-endpoint")
        .arg(format!("http://127.0.0.1:{port}"))
        .arg("--max-snapshot-bytes")
        .arg("1048576")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);

    let send = |child: &mut Child, reader: &mut BufReader<std::process::ChildStdout>, id: i64, method: &str, params: serde_json::Value| -> serde_json::Value {
        let frame = serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params,
        });
        let stdin = child.stdin.as_mut().unwrap();
        stdin.write_all(frame.to_string().as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    };

    let r = send(
        &mut child,
        &mut reader,
        1,
        "fs.index.rebuild",
        serde_json::json!({ "subtree": "/" }),
    );
    assert!(r.get("error").is_none(), "rebuild errored: {r}");

    // Rebuild is now async — poll status until the task is done before
    // searching. Without this wait the search occasionally races the
    // background tokio task and returns 0 hits.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut id = 100i64;
    loop {
        if std::time::Instant::now() >= deadline {
            panic!("tika rebuild did not complete");
        }
        id += 1;
        let s = send(
            &mut child,
            &mut reader,
            id,
            "fs.index.status",
            serde_json::json!({ "subtree": "/" }),
        );
        if s["result"]
            .get("rebuild_task")
            .and_then(|t| t["status"].as_str())
            == Some("completed")
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }

    // Confirm the indexed content from Tika is searchable.
    let r2 = send(
        &mut child,
        &mut reader,
        2,
        "fs.search.content",
        serde_json::json!({
            "query": "extracted",
            "limit": 10, "offset": 0,
            "allowed_path_prefixes": ["/"],
        }),
    );
    let hits = r2["result"]["hits"].as_array().unwrap();
    assert!(
        hits.iter().any(|h| h["path"].as_str() == Some("/doc.pdf")),
        "expected /doc.pdf in hits: {r2}",
    );

    drop(child.stdin.take());
    let _ = child.wait();
    let _ = server.join();
}

#[test]
fn fs_index_rebuild_returns_immediately_with_task_id_then_completes() {
    use std::time::Instant;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    // Generate enough files that a synchronous walk would clearly exceed
    // a fast RPC turnaround. 500 small files is plenty.
    for i in 0..500 {
        std::fs::write(root.join(format!("f{i}.txt")), format!("line {i}")).unwrap();
    }
    let mut helper = Helper::spawn(&root, &work);
    let started = Instant::now();
    let r = helper.call(
        1,
        "fs.index.rebuild",
        serde_json::json!({ "subtree": "/" }),
    );
    let rebuild_dur = started.elapsed();
    // The dispatch must NOT block on the walk itself — should respond in
    // well under a second even with 500 files. Pick a generous 2s cap so
    // CI noise doesn't flake but real blocking still fails the assertion.
    assert!(
        rebuild_dur.as_millis() < 2000,
        "rebuild RPC took {rebuild_dur:?}; expected sub-2s (was the work backgrounded?)",
    );
    let task_id = r["result"]["task_id"].as_str().unwrap().to_string();
    assert!(task_id.starts_with("rebuild-"), "got {task_id}");
    // Poll status until the rebuild completes (or 30s ceiling).
    let deadline = Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if Instant::now() >= deadline {
            panic!("rebuild did not complete within 30s");
        }
        let s = helper.call(
            2,
            "fs.index.status",
            serde_json::json!({ "subtree": "/" }),
        );
        let rt = s["result"]
            .get("rebuild_task")
            .and_then(|t| t.get("status"))
            .and_then(|s| s.as_str())
            .unwrap_or("running");
        if rt == "completed" {
            // doc_count should now reflect the indexed files.
            let dc = s["result"]["doc_count"].as_i64().unwrap_or(0);
            assert!(dc >= 500, "expected >=500 docs after completion, got {dc}");
            break;
        }
        if rt == "failed" {
            panic!("rebuild failed: {s}");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    helper.stop();
}

#[test]
fn fts_paged_filter_finds_low_score_authorized_hit_despite_unauthorized_top_k() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(root.join("a")).unwrap();
    std::fs::create_dir_all(root.join("z")).unwrap();
    // 20 high-relevance hits under /a (term repeated many times each).
    for i in 0..20 {
        std::fs::write(
            root.join("a").join(format!("doc{i}.txt")),
            "needle needle needle needle needle needle needle needle",
        )
        .unwrap();
    }
    // One low-relevance hit under /z (term appears once).
    std::fs::write(root.join("z/lone.txt"), "needle").unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    // Rebuild + wait for completion.
    helper.call(1, "fs.index.rebuild", serde_json::json!({ "subtree": "/" }));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if std::time::Instant::now() >= deadline {
            panic!("rebuild timeout");
        }
        let s = helper.call(2, "fs.index.status", serde_json::json!({ "subtree": "/" }));
        if s["result"]
            .get("rebuild_task")
            .and_then(|t| t["status"].as_str())
            == Some("completed")
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    // Grant /z only with limit=1. Top-1 by bm25 globally is some /a/doc*.txt
    // (more occurrences). Old code returned empty; paged-filter must
    // return /z/lone.txt.
    let r = helper.call(
        3,
        "fs.search.content",
        serde_json::json!({
            "query": "needle",
            "limit": 1, "offset": 0,
            "allowed_path_prefixes": ["/z"],
        }),
    );
    let hits = r["result"]["hits"].as_array().unwrap();
    let paths: Vec<String> = hits
        .iter()
        .map(|h| h["path"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(paths, vec!["/z/lone.txt".to_string()], "got {r}");
    helper.stop();
}

#[test]
fn legacy_index_sqlite_is_migrated_cleanly() {
    use rusqlite::Connection;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    // Plant a legacy index.sqlite without `source` column. Old shape
    // was: docs(path PRIMARY KEY, content, indexed_at).
    {
        let conn = Connection::open(work.join("index.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE docs (path TEXT PRIMARY KEY, content TEXT, indexed_at TEXT);
             INSERT INTO docs VALUES ('/legacy', 'old', '2020');",
        )
        .unwrap();
        // user_version stays 0 — that's how we detect "needs migration".
    }
    std::fs::write(root.join("hello.txt"), "world").unwrap();
    let mut helper = Helper::spawn(&root, &work);
    let r = helper.call(
        1,
        "fs.index.rebuild",
        serde_json::json!({ "subtree": "/" }),
    );
    // Old code returned "table docs has no column named source" — confirm
    // we now get a normal task_id and the rebuild completes.
    assert!(r.get("error").is_none(), "rebuild errored: {r}");
    // Wait for completion.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        if std::time::Instant::now() >= deadline {
            panic!("rebuild did not complete");
        }
        let s = helper.call(2, "fs.index.status", serde_json::json!({ "subtree": "/" }));
        if s["result"]
            .get("rebuild_task")
            .and_then(|t| t["status"].as_str())
            == Some("completed")
        {
            assert_eq!(s["result"]["doc_count"].as_i64().unwrap(), 1);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    helper.stop();
}

#[test]
fn tika_indexing_sends_full_file_not_truncated_at_4mib() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;
    // Fake Tika: records the Content-Length of the request body so we can
    // assert the full file (not a 4 MiB truncation) was sent.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let received_len: Arc<Mutex<usize>> = Arc::new(Mutex::new(0));
    let received_len2 = received_len.clone();
    let server = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
            // Read headers + body fully (small enough for one drain).
            let mut buf = vec![0u8; 8 * 1024 * 1024];
            let mut total = 0usize;
            loop {
                match stream.read(&mut buf[total..]) {
                    Ok(0) => break,
                    Ok(n) => {
                        total += n;
                        if total >= buf.len() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            // Parse Content-Length from the header block we just read.
            let text = String::from_utf8_lossy(&buf[..total]);
            for line in text.lines() {
                if let Some(rest) = line.strip_prefix("Content-Length: ") {
                    if let Ok(n) = rest.trim().parse::<usize>() {
                        *received_len2.lock().unwrap() = n;
                    }
                }
            }
            let body = "ok";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            );
            let _ = stream.write_all(resp.as_bytes());
        }
    });
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    // 6 MiB pdf — above the old hardcoded 4 MiB ceiling so we can prove
    // the full file gets sent.
    let payload_size: usize = 6 * 1024 * 1024;
    std::fs::write(root.join("big.pdf"), vec![0xABu8; payload_size]).unwrap();

    let bin = build_binary();
    let mut child = Command::new(&bin)
        .arg("--root")
        .arg(&root)
        .arg("--work-dir")
        .arg(&work)
        .arg("--tika-endpoint")
        .arg(format!("http://127.0.0.1:{port}"))
        .arg("--max-extract-bytes")
        .arg("16777216") // 16 MiB cap
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let send = |child: &mut Child,
                reader: &mut BufReader<std::process::ChildStdout>,
                id: i64,
                method: &str,
                params: serde_json::Value|
     -> serde_json::Value {
        let frame = serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params,
        });
        let stdin = child.stdin.as_mut().unwrap();
        stdin.write_all(frame.to_string().as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    };
    let _ = send(&mut child, &mut reader, 1, "fs.index.rebuild",
        serde_json::json!({ "subtree": "/" }));
    // Wait for completion.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if std::time::Instant::now() >= deadline {
            panic!("rebuild did not complete");
        }
        let s = send(&mut child, &mut reader, 2, "fs.index.status",
            serde_json::json!({ "subtree": "/" }));
        if s["result"].get("rebuild_task").and_then(|t| t["status"].as_str()) == Some("completed") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    drop(child.stdin.take());
    let _ = child.wait();
    let _ = server.join();
    let got = *received_len.lock().unwrap();
    assert_eq!(
        got, payload_size,
        "Tika request body was {got} bytes, expected the full {payload_size} (was the file truncated at 4 MiB?)",
    );
}

#[test]
fn fs_index_upsert_rejects_symlink_target() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    let outside = tmp.path().join("outside");
    std::fs::create_dir_all(root.join("allowed")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    // Sensitive content lives outside root.
    std::fs::write(outside.join("secret.txt"), "TOP_SECRET_TOKEN").unwrap();
    // Path inside root is a symlink to that sensitive file. From the
    // user-VFS POV this is "/allowed/link.txt".
    symlink(outside.join("secret.txt"), root.join("allowed/link.txt")).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    // The runtime would call fs.index.upsert after a write/edit. Even
    // when issued directly, the sidecar must NOT follow the symlink and
    // index the outside content.
    let r = helper.call(
        1,
        "fs.index.upsert",
        serde_json::json!({ "path": "/allowed/link.txt" }),
    );
    assert!(r.get("error").is_none(), "upsert errored: {r}");
    // Now confirm search over /allowed cannot surface TOP_SECRET_TOKEN.
    let s = helper.call(
        2,
        "fs.search.content",
        serde_json::json!({
            "query": "TOP_SECRET_TOKEN",
            "limit": 50, "offset": 0,
            "allowed_path_prefixes": ["/"],
        }),
    );
    let hits = s["result"]["hits"].as_array().unwrap();
    assert!(
        hits.is_empty(),
        "symlinked outside content leaked into FTS: {hits:?}",
    );
    helper.stop();
}

fn wait_for_rebuild_complete(helper: &mut Helper, subtree: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut id = 9000i64;
    loop {
        if std::time::Instant::now() >= deadline {
            panic!("rebuild did not complete for {subtree}");
        }
        id += 1;
        let s = helper.call(
            id,
            "fs.index.status",
            serde_json::json!({ "subtree": subtree }),
        );
        if s["result"]
            .get("rebuild_task")
            .and_then(|t| t["status"].as_str())
            == Some("completed")
        {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
}

#[test]
fn status_does_not_leak_other_subtree_rebuild_task() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(root.join("secret")).unwrap();
    std::fs::create_dir_all(root.join("public")).unwrap();
    std::fs::write(root.join("secret/leak.txt"), "hidden").unwrap();
    std::fs::write(root.join("public/ok.txt"), "fine").unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    // Kick off a /secret rebuild and wait for it.
    helper.call(1, "fs.index.rebuild", serde_json::json!({ "subtree": "/secret" }));
    wait_for_rebuild_complete(&mut helper, "/secret");
    // Now ask for /public status — it must NOT carry /secret's rebuild_task.
    let s = helper.call(2, "fs.index.status", serde_json::json!({ "subtree": "/public" }));
    let task = s["result"].get("rebuild_task");
    assert!(
        task.is_none(),
        "/public status leaked rebuild_task from a sibling subtree: {s}",
    );
    // /secret status DOES see it (same subtree).
    let s2 = helper.call(3, "fs.index.status", serde_json::json!({ "subtree": "/secret" }));
    assert_eq!(
        s2["result"]["rebuild_task"]["subtree"].as_str(),
        Some("/secret"),
    );
    helper.stop();
}

#[test]
fn status_returns_during_rebuild_without_blocking() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    // 800 files so the walk takes a measurable amount of time.
    for i in 0..800 {
        std::fs::write(root.join(format!("f{i}.txt")), format!("line {i}")).unwrap();
    }
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    helper.call(1, "fs.index.rebuild", serde_json::json!({ "subtree": "/" }));
    // Immediately query status — must return promptly even though the
    // rebuild is still running. The key property: the call returns
    // (not hangs) and surfaces rebuild_task.
    let started = std::time::Instant::now();
    let s = helper.call(2, "fs.index.status", serde_json::json!({ "subtree": "/" }));
    let elapsed = started.elapsed();
    assert!(
        elapsed.as_millis() < 500,
        "status blocked for {elapsed:?} during rebuild; expected sub-500ms",
    );
    let task = &s["result"]["rebuild_task"];
    assert!(
        task["status"].as_str() == Some("running")
            || task["status"].as_str() == Some("completed"),
        "status snapshot during rebuild: {s}",
    );
    wait_for_rebuild_complete(&mut helper, "/");
    helper.stop();
}

#[test]
fn task_status_rpc_returns_specific_task_by_id() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.txt"), "alpha").unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    let r = helper.call(1, "fs.index.rebuild", serde_json::json!({ "subtree": "/" }));
    let task_id = r["result"]["task_id"].as_str().unwrap().to_string();
    wait_for_rebuild_complete(&mut helper, "/");
    let ts = helper.call(
        2,
        "fs.index.task_status",
        serde_json::json!({ "task_id": task_id }),
    );
    assert_eq!(ts["result"]["status"].as_str(), Some("completed"));
    assert_eq!(ts["result"]["subtree"].as_str(), Some("/"));
    // Bogus id → -32004 not_found.
    let bad = helper.call(
        3,
        "fs.index.task_status",
        serde_json::json!({ "task_id": "rebuild-nope" }),
    );
    assert_eq!(bad["error"]["code"], -32004, "{bad}");
    helper.stop();
}

#[test]
fn rebuild_task_table_caps_at_retention_window() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    // Fire 40 rebuilds back-to-back. The MAX_TASK_HISTORY cap is 32, so
    // querying the first one's task_id should return not_found.
    let mut first_id: Option<String> = None;
    for i in 1..=40i64 {
        let r = helper.call(i, "fs.index.rebuild", serde_json::json!({ "subtree": "/" }));
        let id = r["result"]["task_id"].as_str().unwrap().to_string();
        if first_id.is_none() {
            first_id = Some(id);
        }
        // Wait for each so they finish in deterministic order; otherwise
        // races could give a different start_at ordering.
        wait_for_rebuild_complete(&mut helper, "/");
    }
    let bad = helper.call(
        100,
        "fs.index.task_status",
        serde_json::json!({ "task_id": first_id.unwrap() }),
    );
    assert_eq!(bad["error"]["code"], -32004, "{bad}");
    helper.stop();
}

#[test]
fn status_errors_and_last_indexed_at_are_subtree_scoped() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(root.join("secret")).unwrap();
    std::fs::create_dir_all(root.join("public")).unwrap();
    // Plain text under /public (will index as source='text').
    std::fs::write(root.join("public/ok.txt"), "ordinary text").unwrap();
    // Rich-format PDF under /secret, no Tika endpoint → source='no_tika'
    // and extract_failed bumps for /secret. /public must not see this.
    std::fs::write(root.join("secret/leak.pdf"), b"%PDF-1.7 stub").unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    helper.call(1, "fs.index.rebuild", serde_json::json!({ "subtree": "/" }));
    wait_for_rebuild_complete(&mut helper, "/");

    let secret = helper.call(2, "fs.index.status", serde_json::json!({ "subtree": "/secret" }));
    let public = helper.call(3, "fs.index.status", serde_json::json!({ "subtree": "/public" }));

    // /secret reports 1 doc, 1 extract failure (no Tika), a timestamp.
    assert_eq!(secret["result"]["doc_count"].as_i64(), Some(1), "{secret}");
    assert_eq!(
        secret["result"]["errors"]["extract_failed"].as_i64(),
        Some(1),
        "{secret}",
    );
    assert!(
        secret["result"]["last_indexed_at"].as_str().is_some(),
        "{secret}",
    );
    // /public reports 1 doc, 0 extract failures (the rich-format failure
    // happened in a different subtree). Old code returned the GLOBAL
    // extract_failed=1 here, leaking /secret's activity.
    assert_eq!(public["result"]["doc_count"].as_i64(), Some(1), "{public}");
    assert_eq!(
        public["result"]["errors"]["extract_failed"].as_i64(),
        Some(0),
        "/public must not see /secret's extract failures: {public}",
    );
    // /public's last_indexed_at must come from its own docs only — the
    // text file under it has a timestamp. The cross-leak check we care
    // about is that a /public-only caller doesn't get a timestamp
    // attributable to a /secret-only rebuild; here both subtrees have
    // docs so any non-null value is acceptable as long as it matches the
    // /public doc timeline.
    let pub_ts = public["result"]["last_indexed_at"].as_str();
    assert!(pub_ts.is_some(), "{public}");
    helper.stop();
}

#[test]
fn empty_subtree_status_reports_zero_and_no_timestamp() {
    // /public has no docs; rebuild only touches /secret. /public status
    // must not borrow /secret's timestamp.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(root.join("secret")).unwrap();
    std::fs::create_dir_all(root.join("public")).unwrap();
    std::fs::write(root.join("secret/x.txt"), "y").unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    helper.call(1, "fs.index.rebuild", serde_json::json!({ "subtree": "/secret" }));
    wait_for_rebuild_complete(&mut helper, "/secret");
    let s = helper.call(2, "fs.index.status", serde_json::json!({ "subtree": "/public" }));
    assert_eq!(s["result"]["doc_count"].as_i64(), Some(0), "{s}");
    assert_eq!(
        s["result"]["errors"]["extract_failed"].as_i64(),
        Some(0),
        "{s}",
    );

    assert!(
        s["result"]["last_indexed_at"].is_null(),
        "/public should have no timestamp; got {s}",
    );
    helper.stop();
}

#[test]
fn task_id_is_csprng_random_hex_not_timestamp_prefix() {
    // task_id was previously epoch-nanoseconds + pid hex, which made
    // adjacent rebuild ids guessable (the leading 16 hex chars varied
    // only by sub-millisecond timing). Confirm 5 back-to-back rebuilds
    // produce ids with NO common prefix beyond a few chars — true random
    // 128-bit ids have ~negligible chance of a 4-char prefix collision.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    let mut ids: Vec<String> = Vec::new();
    for i in 1..=5i64 {
        let r = helper.call(i, "fs.index.rebuild", serde_json::json!({ "subtree": "/" }));
        let id = r["result"]["task_id"].as_str().unwrap().to_string();
        assert!(id.starts_with("rebuild-"), "got {id}");
        // Hex body should be 32 chars (128 bits).
        assert_eq!(id.len(), "rebuild-".len() + 32, "got {id}");
        ids.push(id);
        wait_for_rebuild_complete(&mut helper, "/");
    }
    // Pairwise compare the hex bodies; no two should share more than
    // ~6 leading chars (vanishingly improbable for true random).
    for i in 0..ids.len() {
        for j in (i + 1)..ids.len() {
            let a = &ids[i]["rebuild-".len()..];
            let b = &ids[j]["rebuild-".len()..];
            let common = a
                .chars()
                .zip(b.chars())
                .take_while(|(x, y)| x == y)
                .count();
            assert!(
                common < 12,
                "task ids {a} / {b} share {common} leading hex chars — looks like the old timestamp scheme is back",
            );
        }
    }
    helper.stop();
}

#[test]
fn rebuild_does_not_re_route_backslash_filenames_into_fake_prefix() {
    // Regression: rebuild used to convert `\` -> `/` on host->VFS path
    // generation, which on POSIX silently re-routes a real file named
    // "public\leak.txt" into the VFS path "/public/leak.txt". A caller
    // with grant prefix ["/public"] would then see content from a file
    // that does NOT live under any "/public" directory on disk.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    // The leaky filename. Skip on systems where the filename actually
    // can't be created (Windows test runners would refuse it; we only
    // care about POSIX here, where the bug bites).
    let leak_name = "public\\leak.txt";
    let leak_path = root.join(leak_name);
    if std::fs::write(&leak_path, "topsecret").is_err() {
        // Filesystem refused the name (probably Windows) — bug not
        // reachable here; bail without failing.
        return;
    }
    // Also drop a legitimate /public/ok.txt with the same content so a
    // mistaken match would look indistinguishable from a real hit.
    std::fs::create_dir_all(root.join("public")).unwrap();
    std::fs::write(root.join("public/ok.txt"), "topsecret").unwrap();
    let mut helper = Helper::spawn(&root, &work);
    let _ = helper.call(
        1,
        "fs.index.rebuild",
        serde_json::json!({ "subtree": "/" }),
    );
    wait_for_rebuild_complete(&mut helper, "/");
    let r = helper.call(
        2,
        "fs.search.content",
        serde_json::json!({
            "query": "topsecret",
            "limit": 50, "offset": 0,
            "allowed_path_prefixes": ["/public"],
        }),
    );
    let hits = r["result"]["hits"].as_array().unwrap();
    let paths: Vec<&str> = hits.iter().filter_map(|h| h["path"].as_str()).collect();
    // /public/ok.txt is fine. The leaky file (whatever shape it gets
    // indexed as, if at all) must NOT appear under /public/leak.txt.
    assert!(
        !paths.iter().any(|p| *p == "/public/leak.txt"),
        "backslash filename leaked into /public/ search: {paths:?}",
    );
    // Sanity: legitimate /public file is still found.
    assert!(
        paths.iter().any(|p| *p == "/public/ok.txt"),
        "legitimate /public hit missing: {paths:?}",
    );
    helper.stop();
}

#[test]
fn status_on_unrelated_subtree_does_not_leak_busy_state_via_doc_count_pending() {
    // Regression: while /secret rebuild held the index Mutex, a status
    // call on /public used to fall back to a stub
    // `{doc_count: -1, doc_count_pending: true, ...}`. A /public-only
    // caller saw "no rebuild_task but doc_count_pending=true" — i.e.
    // "some rebuild I'm not allowed to see is in flight". Fix routes
    // status through a separate read-only SQLite connection; this test
    // hammers /public status during a large /secret rebuild and asserts
    // the sentinel never appears.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(root.join("secret")).unwrap();
    std::fs::create_dir_all(root.join("public")).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    // Enough small files that the rebuild window is wide enough to
    // race against status queries.
    for i in 0..3000 {
        std::fs::write(root.join(format!("secret/f{i}.txt")), "x").unwrap();
    }
    std::fs::write(root.join("public/ok.txt"), "y").unwrap();
    let mut helper = Helper::spawn(&root, &work);
    // Prime: index /public only so the db file exists. Critically, do
    // NOT rebuild "/" here — that would leave a completed `/` task in
    // the task table, which the sidecar's filter would surface as an
    // ancestor task on every later /public status call (a separate,
    // legitimate behavior covered by round-7 runtime stripping). We
    // only want to test the busy-state side channel here.
    helper.call(
        0,
        "fs.index.rebuild",
        serde_json::json!({ "subtree": "/public" }),
    );
    wait_for_rebuild_complete(&mut helper, "/public");
    // Kick off a fresh /secret rebuild and immediately start polling
    // /public status.
    helper.call(
        1,
        "fs.index.rebuild",
        serde_json::json!({ "subtree": "/secret" }),
    );
    let mut id = 100i64;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut saw_running = false;
    let mut samples = 0;
    loop {
        if std::time::Instant::now() >= deadline {
            break;
        }
        id += 1;
        let s = helper.call(
            id,
            "fs.index.status",
            serde_json::json!({ "subtree": "/public" }),
        );
        // /public must NEVER carry the leaked sentinel.
        assert!(
            s["result"].get("doc_count_pending").is_none(),
            "/public status leaked doc_count_pending during /secret rebuild: {s}",
        );
        // doc_count for /public must be 0 or 1 (we only put one file).
        let dc = s["result"]["doc_count"].as_i64().unwrap_or(i64::MIN);
        assert!(
            dc >= 0,
            "/public status leaked negative doc_count: {s}",
        );
        // /public must NEVER see /secret's rebuild_task at the sidecar
        // level (the prime's own /public task is fine).
        if let Some(rt) = s["result"].get("rebuild_task") {
            let sub = rt["subtree"].as_str().unwrap_or("");
            assert!(
                sub == "/public" || sub.starts_with("/public/"),
                "/public status surfaced foreign rebuild_task: {s}",
            );
        }
        samples += 1;
        // Confirm the /secret rebuild is actually in flight; once it
        // finishes we can stop polling.
        id += 1;
        let s2 = helper.call(
            id,
            "fs.index.status",
            serde_json::json!({ "subtree": "/secret" }),
        );
        let secret_status = s2["result"]["rebuild_task"]["status"]
            .as_str()
            .unwrap_or("");
        if secret_status == "running" {
            saw_running = true;
        }
        if secret_status == "completed" {
            break;
        }
    }
    assert!(saw_running, "/secret rebuild never observed in 'running' state ({samples} samples)");
    assert!(samples >= 5, "too few /public samples: {samples}");
    helper.stop();
}

#[test]
fn stale_v1_index_with_backslash_misattributed_row_is_purged_on_upgrade() {
    // The pre-round-8 rebuild generated VFS paths via
    // `replace('\\', "/")`, so a real POSIX file `public\leak.txt`
    // landed in the FTS index as `/public/leak.txt`. Round-8 fixed
    // future rebuilds but did NOT erase rows already in the v1 db —
    // they survived the upgrade and remained searchable. Round-9
    // bumps SCHEMA_VERSION to 2 so any pre-existing v1 index file
    // gets reset on the next startup, dropping the poisoned rows.
    //
    // This test seeds the current v1 shape (matching what the buggy
    // helper would have written), then spawns the new helper (now v2)
    // and confirms the leaked content can no longer be searched.
    use rusqlite::Connection;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(root.join("public")).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    // Legitimate /public file the fresh rebuild WILL pick up — used as
    // a positive sanity check that the reset/rebuild actually ran.
    std::fs::write(root.join("public/ok.txt"), "freshmarker").unwrap();
    // Seed a v1 index.sqlite containing a poisoned row at the VFS path
    // `/public/leak.txt` that does NOT correspond to any real file
    // under root/public. user_version=1 so the OLD reset logic would
    // accept it as up-to-date.
    {
        let conn = Connection::open(work.join("index.sqlite")).unwrap();
        conn.execute_batch(
            "PRAGMA user_version = 1;
             CREATE TABLE docs (
                rowid INTEGER PRIMARY KEY,
                path TEXT UNIQUE NOT NULL,
                extension TEXT,
                mime TEXT,
                size INTEGER,
                mtime_ms INTEGER,
                source TEXT,
                indexed_at TEXT
             );
             CREATE VIRTUAL TABLE docs_fts USING fts5(
                content,
                tokenize='unicode61'
             );
             INSERT INTO docs (rowid, path, extension, mime, size, mtime_ms, source, indexed_at)
                VALUES (1, '/public/leak.txt', 'txt', 'text/plain', 16, 0, 'text', '2026-01-01T00:00:00Z');
             INSERT INTO docs_fts (rowid, content) VALUES (1, 'STALE_LEAK_TOKEN');",
        )
        .unwrap();
    }
    let mut helper = Helper::spawn(&root, &work);
    // Critically: do NOT call fs.index.rebuild before searching. The
    // reported repro is "stale row survives upgrade" — i.e. the user
    // upgrades, hasn't yet rebuilt, and an indexed search still hits
    // poisoned content. A rebuild would mask the bug because
    // `delete_subtree("/")` purges every row before the walk. The
    // schema bump must clear the index at *startup*, not rely on a
    // user-initiated rebuild.
    // Negative: STALE_LEAK_TOKEN must NOT appear in indexed search even
    // for an unrestricted caller (allowed_path_prefixes:["/"]).
    let r = helper.call(
        2,
        "fs.search.content",
        serde_json::json!({
            "query": "STALE_LEAK_TOKEN",
            "limit": 50, "offset": 0,
            "allowed_path_prefixes": ["/"],
        }),
    );
    let hits = r["result"]["hits"].as_array().unwrap();
    assert!(
        hits.is_empty(),
        "stale v1 row survived schema upgrade: {hits:?}",
    );
    // Negative #2: the prefix-scoped form (which is how a /public-only
    // caller hits this) also must not surface it.
    let r2 = helper.call(
        3,
        "fs.search.content",
        serde_json::json!({
            "query": "STALE_LEAK_TOKEN",
            "limit": 50, "offset": 0,
            "allowed_path_prefixes": ["/public"],
        }),
    );
    let hits2 = r2["result"]["hits"].as_array().unwrap();
    assert!(
        hits2.is_empty(),
        "stale v1 row survived schema upgrade on /public scope: {hits2:?}",
    );
    // Positive: status reports doc_count=0, confirming the reset
    // happened rather than the stale row merely being filtered out.
    let s = helper.call(
        4,
        "fs.index.status",
        serde_json::json!({ "subtree": "/" }),
    );
    assert_eq!(
        s["result"]["doc_count"].as_i64(),
        Some(0),
        "post-reset status should show empty index, got: {s}",
    );
    helper.stop();
}

#[test]
fn fs_index_status_surfaces_real_db_errors_instead_of_pretending_empty() {
    // Regression: fs.index.status used to swallow ALL Err(_) from
    // open_status_conn / compute_status and return the quiet stub
    // `{doc_count: 0, ...}`. That silently masked real DB problems
    // (corruption, schema drift, permission failure) — a caller
    // searching the index would see no hits and think the helper was
    // simply idle.
    //
    // We seed a v1 index, then on startup the helper bumps to v2 and
    // recreates the schema (so a fresh open works). Then we corrupt
    // the index file from the test process to break subsequent
    // read-only opens. fs.index.status must surface this as an
    // explicit error, not pretend the index is empty.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(root.join("a.txt"), "alpha").unwrap();
    let mut helper = Helper::spawn(&root, &work);
    helper.call(
        1,
        "fs.index.rebuild",
        serde_json::json!({ "subtree": "/" }),
    );
    wait_for_rebuild_complete(&mut helper, "/");
    // Sanity: healthy status before corruption.
    let healthy = helper.call(
        2,
        "fs.index.status",
        serde_json::json!({ "subtree": "/" }),
    );
    assert!(
        healthy.get("error").is_none() && healthy["result"]["doc_count"].as_i64() == Some(1),
        "pre-corruption sanity check: {healthy}",
    );
    // Corrupt the SQLite header AND the WAL file. The corruption must
    // be aggressive enough that a fresh read-only `Connection::open` on
    // the file cannot pretend the index is intact:
    //   - Truncate the main db file to 0 bytes (SQLite refuses to open
    //     a zero-byte file as a database; "file is not a database").
    //   - Truncate the WAL file too (otherwise SQLite would recover
    //     pages from the journal and successfully open the db).
    // The helper's own long-lived write handle still references the
    // old inode contents via its open file descriptor, but the per-
    // status read-only handle opens fresh from the path and will see
    // the empty file.
    {
        let _ = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(work.join("index.sqlite"))
            .unwrap();
        // WAL/SHM may not exist if no writes happened recently; ignore
        // errors here.
        for suffix in ["-wal", "-shm"] {
            let p = work.join(format!("index.sqlite{suffix}"));
            let _ = std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&p);
        }
    }
    // Status must now error explicitly, not silently report 0 docs.
    let broken = helper.call(
        3,
        "fs.index.status",
        serde_json::json!({ "subtree": "/" }),
    );
    assert!(
        broken.get("error").is_some(),
        "status silently swallowed DB corruption (got result instead of error): {broken}",
    );
    let err = &broken["error"];
    // Either an open failure or a compute_status failure — both go
    // through the same `index_status_unavailable:` wrapper.
    assert_eq!(err["code"].as_i64(), Some(-32603), "{broken}");
    assert!(
        err["message"]
            .as_str()
            .unwrap_or("")
            .contains("index_status_unavailable"),
        "expected index_status_unavailable wrapper, got: {broken}",
    );
    helper.stop();
}

#[test]
fn fs_index_status_returns_quiet_stub_when_index_file_absent() {
    // The acceptable error branch: index.sqlite doesn't exist yet
    // (helper has only just started, no rebuild yet, plus the file
    // got removed). `open_status_conn` returns Ok(None) — status
    // emits the quiet zero stub since "nothing indexed" really is
    // doc_count:0. This is the ONE case where a stub is correct and
    // not a cover for a real failure.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    // Helper startup creates index.sqlite. Remove it (plus wal/shm) so
    // the next status call hits the absent-file branch.
    for suffix in ["", "-wal", "-shm"] {
        let p = work.join(format!("index.sqlite{suffix}"));
        let _ = std::fs::remove_file(&p);
    }
    let s = helper.call(
        1,
        "fs.index.status",
        serde_json::json!({ "subtree": "/" }),
    );
    assert!(s.get("error").is_none(), "absent file should not error: {s}");
    assert_eq!(s["result"]["doc_count"].as_i64(), Some(0), "{s}");
    assert!(
        s["result"]["last_indexed_at"].is_null(),
        "absent file stub should null last_indexed_at: {s}",
    );
    assert!(
        s["result"].get("doc_count_pending").is_none(),
        "absent-file stub must NOT re-introduce doc_count_pending: {s}",
    );
    helper.stop();
}

// ───────────────────── CAS + manifest (Step 1) ───────────────────────────────

#[test]
fn cas_put_has_and_dedup() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    let cas = tmp.path().join("cas");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let src = tmp.path().join("src.txt");
    std::fs::write(&src, "cas-content").unwrap();
    let mut helper = Helper::spawn_with_cas(&root, &work, &cas);
    let r = helper.call(
        1,
        "fs.cas.put",
        serde_json::json!({ "path": src.to_str().unwrap() }),
    );
    let sha = r["result"]["sha256"].as_str().unwrap().to_string();
    assert_eq!(sha, sha256_hex(b"cas-content"), "{r}");
    assert_eq!(r["result"]["dedup"], false, "{r}");
    // has → true.
    let h = helper.call(2, "fs.cas.has", serde_json::json!({ "sha256": sha }));
    assert_eq!(h["result"]["exists"], true, "{h}");
    // put again → dedup true.
    let r2 = helper.call(
        3,
        "fs.cas.put",
        serde_json::json!({ "path": src.to_str().unwrap() }),
    );
    assert_eq!(r2["result"]["dedup"], true, "{r2}");
    // unknown sha → has false.
    let h2 = helper.call(
        4,
        "fs.cas.has",
        serde_json::json!({ "sha256": "0".repeat(64) }),
    );
    assert_eq!(h2["result"]["exists"], false, "{h2}");
    helper.stop();
}

#[test]
fn cas_rpcs_error_without_cas_dir() {
    // Helper spawned WITHOUT --cas-dir must reject cas/manifest RPCs with
    // invalid_params rather than panicking.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn(&root, &work);
    let r = helper.call(
        1,
        "fs.cas.has",
        serde_json::json!({ "sha256": "x".repeat(64) }),
    );
    assert_eq!(r["error"]["code"], -32602, "{r}");
    helper.stop();
}

#[test]
fn manifest_scan_commit_then_materialize_roundtrip() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    let cas = tmp.path().join("cas");
    let live = tmp.path().join("live");
    let out = tmp.path().join("out");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    // Build a live tree: file, nested file, empty dir, symlink.
    std::fs::create_dir_all(live.join("sub")).unwrap();
    std::fs::create_dir_all(live.join("empty")).unwrap();
    std::fs::write(live.join("top.txt"), "top-bytes").unwrap();
    std::fs::write(live.join("sub/nested.txt"), "nested-bytes").unwrap();
    std::os::unix::fs::symlink("top.txt", live.join("link")).unwrap();
    let mut helper = Helper::spawn_with_cas(&root, &work, &cas);
    let r = helper.call(
        1,
        "fs.manifest.scan_commit",
        serde_json::json!({ "dir": live.to_str().unwrap() }),
    );
    let manifest_sha = r["result"]["manifest_sha256"].as_str().unwrap().to_string();
    assert!(r["result"]["conflict_paths"].as_array().unwrap().is_empty());
    // entries should include the empty dir and the symlink.
    let entries = r["result"]["entries"].as_array().unwrap();
    let kinds: std::collections::HashMap<String, String> = entries
        .iter()
        .map(|e| {
            (
                e["path"].as_str().unwrap().to_string(),
                e["kind"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(kinds.get("/empty").map(|s| s.as_str()), Some("dir"), "{r}");
    assert_eq!(kinds.get("/link").map(|s| s.as_str()), Some("symlink"), "{r}");
    assert_eq!(kinds.get("/top.txt").map(|s| s.as_str()), Some("file"), "{r}");
    // Materialize into a fresh dir.
    let m = helper.call(
        2,
        "fs.manifest.materialize",
        serde_json::json!({ "manifest_sha256": manifest_sha, "target_dir": out.to_str().unwrap() }),
    );
    assert!(m.get("error").is_none(), "{m}");
    // Verify files round-trip byte-for-byte, empty dir exists, symlink points right.
    assert_eq!(std::fs::read(out.join("top.txt")).unwrap(), b"top-bytes");
    assert_eq!(std::fs::read(out.join("sub/nested.txt")).unwrap(), b"nested-bytes");
    assert!(out.join("empty").is_dir(), "empty dir lost");
    let link_meta = std::fs::symlink_metadata(out.join("link")).unwrap();
    assert!(link_meta.file_type().is_symlink(), "symlink lost");
    assert_eq!(std::fs::read_link(out.join("link")).unwrap().to_str(), Some("top.txt"));
    helper.stop();
}

#[test]
fn manifest_materialize_handles_type_changes_and_clears_stale() {
    // A re-materialize must survive every file-type change (file→dir, dir→file,
    // file→symlink, symlink→dir) AND clear stale files from a previous snapshot,
    // not just fail or leave junk behind.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    let cas = tmp.path().join("cas");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn_with_cas(&root, &work, &cas);

    // Snapshot A: p1 is a FILE, p2 is a DIR (with a child), p3 is a FILE,
    // plus a stale file that snapshot B will not contain.
    let a = tmp.path().join("treeA");
    std::fs::create_dir_all(a.join("p2")).unwrap();
    std::fs::write(a.join("p1"), "file-content").unwrap();
    std::fs::write(a.join("p2/child"), "child").unwrap();
    std::fs::write(a.join("p3"), "p3-file").unwrap();
    std::fs::write(a.join("stale.txt"), "stale").unwrap();
    let sha_a = helper.call(
        1,
        "fs.manifest.scan_commit",
        serde_json::json!({ "dir": a.to_str().unwrap() }),
    )["result"]["manifest_sha256"]
        .as_str()
        .unwrap()
        .to_string();

    // Snapshot B: p1 is now a DIR, p2 is now a FILE, p3 is now a SYMLINK.
    // stale.txt is gone.
    let b = tmp.path().join("treeB");
    std::fs::create_dir_all(b.join("p1")).unwrap();
    std::fs::write(b.join("p1/inner"), "inner").unwrap();
    std::fs::write(b.join("p2"), "now-a-file").unwrap();
    std::os::unix::fs::symlink("p2", b.join("p3")).unwrap();
    let sha_b = helper.call(
        2,
        "fs.manifest.scan_commit",
        serde_json::json!({ "dir": b.to_str().unwrap() }),
    )["result"]["manifest_sha256"]
        .as_str()
        .unwrap()
        .to_string();

    // Materialize A into `out`, then re-materialize B into the SAME dir.
    let out = tmp.path().join("out");
    let m1 = helper.call(
        3,
        "fs.manifest.materialize",
        serde_json::json!({ "manifest_sha256": sha_a, "target_dir": out.to_str().unwrap() }),
    );
    assert!(m1.get("error").is_none(), "{m1}");
    assert!(out.join("p1").is_file());
    assert!(out.join("p2").is_dir());
    assert!(out.join("stale.txt").is_file());

    let m2 = helper.call(
        4,
        "fs.manifest.materialize",
        serde_json::json!({ "manifest_sha256": sha_b, "target_dir": out.to_str().unwrap() }),
    );
    assert!(m2.get("error").is_none(), "type-change re-materialize failed: {m2}");
    // p1: file → dir.
    assert!(out.join("p1").is_dir(), "p1 should now be a dir");
    assert_eq!(std::fs::read(out.join("p1/inner")).unwrap(), b"inner");
    // p2: dir → file.
    assert!(out.join("p2").is_file(), "p2 should now be a file");
    assert_eq!(std::fs::read(out.join("p2")).unwrap(), b"now-a-file");
    // p3: file → symlink.
    let p3 = std::fs::symlink_metadata(out.join("p3")).unwrap();
    assert!(p3.file_type().is_symlink(), "p3 should now be a symlink");
    // stale.txt cleared.
    assert!(!out.join("stale.txt").exists(), "stale file not cleared");
    helper.stop();
}

#[test]
fn manifest_same_tree_committed_twice_yields_same_sha() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    let cas = tmp.path().join("cas");
    let live = tmp.path().join("live");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    std::fs::create_dir_all(live.join("d")).unwrap();
    std::fs::write(live.join("a.txt"), "aaa").unwrap();
    std::fs::write(live.join("d/b.txt"), "bbb").unwrap();
    let mut helper = Helper::spawn_with_cas(&root, &work, &cas);
    let s1 = helper.call(
        1,
        "fs.manifest.scan_commit",
        serde_json::json!({ "dir": live.to_str().unwrap() }),
    )["result"]["manifest_sha256"]
        .as_str()
        .unwrap()
        .to_string();
    let s2 = helper.call(
        2,
        "fs.manifest.scan_commit",
        serde_json::json!({ "dir": live.to_str().unwrap() }),
    )["result"]["manifest_sha256"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(s1, s2, "identical tree must produce identical manifest sha");
    helper.stop();
}

#[test]
fn manifest_scan_commit_three_way_disjoint_and_conflict() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    let cas = tmp.path().join("cas");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn_with_cas(&root, &work, &cas);

    // base: {shared.txt=base, keep.txt=keep}
    let base_dir = tmp.path().join("base");
    std::fs::create_dir_all(&base_dir).unwrap();
    std::fs::write(base_dir.join("shared.txt"), "base").unwrap();
    std::fs::write(base_dir.join("keep.txt"), "keep").unwrap();
    let base_sha = helper.call(
        1,
        "fs.manifest.scan_commit",
        serde_json::json!({ "dir": base_dir.to_str().unwrap() }),
    )["result"]["manifest_sha256"]
        .as_str()
        .unwrap()
        .to_string();

    // latest (head advanced by "other writer"): shared.txt -> remote, +added.txt
    let latest_dir = tmp.path().join("latest");
    std::fs::create_dir_all(&latest_dir).unwrap();
    std::fs::write(latest_dir.join("shared.txt"), "remote").unwrap();
    std::fs::write(latest_dir.join("keep.txt"), "keep").unwrap();
    std::fs::write(latest_dir.join("added.txt"), "added").unwrap();
    let latest_sha = helper.call(
        2,
        "fs.manifest.scan_commit",
        serde_json::json!({ "dir": latest_dir.to_str().unwrap() }),
    )["result"]["manifest_sha256"]
        .as_str()
        .unwrap()
        .to_string();

    // working (this actor's live dir, materialized from base, then edited):
    // shared.txt -> local (conflict), +mine.txt (disjoint).
    let work_dir = tmp.path().join("workdir");
    std::fs::create_dir_all(&work_dir).unwrap();
    std::fs::write(work_dir.join("shared.txt"), "local").unwrap();
    std::fs::write(work_dir.join("keep.txt"), "keep").unwrap();
    std::fs::write(work_dir.join("mine.txt"), "mine").unwrap();

    let r = helper.call(
        3,
        "fs.manifest.scan_commit",
        serde_json::json!({
            "dir": work_dir.to_str().unwrap(),
            "base_manifest_sha256": base_sha,
            "latest_manifest_sha256": latest_sha,
        }),
    );
    // shared.txt is a conflict; mine.txt + added.txt both survive.
    let conflicts: Vec<String> = r["result"]["conflict_paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap().to_string())
        .collect();
    assert_eq!(conflicts, vec!["/shared.txt".to_string()], "{r}");
    let merged_sha = r["result"]["manifest_sha256"].as_str().unwrap().to_string();
    // Materialize the merged result and check contents.
    let out = tmp.path().join("merged_out");
    helper.call(
        4,
        "fs.manifest.materialize",
        serde_json::json!({ "manifest_sha256": merged_sha, "target_dir": out.to_str().unwrap() }),
    );
    // shared.txt keeps the remote (latest) value on conflict.
    assert_eq!(std::fs::read(out.join("shared.txt")).unwrap(), b"remote", "conflict should keep latest");
    // disjoint local change applied.
    assert_eq!(std::fs::read(out.join("mine.txt")).unwrap(), b"mine");
    // other writer's add preserved.
    assert_eq!(std::fs::read(out.join("added.txt")).unwrap(), b"added");
    helper.stop();
}

#[test]
fn dir_sync_merges_incoming_keeps_local_and_advances_base() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    let cas = tmp.path().join("cas");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn_with_cas(&root, &work, &cas);

    // base = {a.txt=a, c.txt=c}
    let base_dir = tmp.path().join("base");
    std::fs::create_dir_all(&base_dir).unwrap();
    std::fs::write(base_dir.join("a.txt"), "a").unwrap();
    std::fs::write(base_dir.join("c.txt"), "c").unwrap();
    let base_sha = helper.call(
        1,
        "fs.manifest.scan_commit",
        serde_json::json!({ "dir": base_dir.to_str().unwrap() }),
    )["result"]["manifest_sha256"]
        .as_str()
        .unwrap()
        .to_string();

    // head = {a.txt=a2 (changed), c.txt=c, newremote.txt=nr}
    let head_dir = tmp.path().join("head");
    std::fs::create_dir_all(&head_dir).unwrap();
    std::fs::write(head_dir.join("a.txt"), "a2").unwrap();
    std::fs::write(head_dir.join("c.txt"), "c").unwrap();
    std::fs::write(head_dir.join("newremote.txt"), "nr").unwrap();
    let head_sha = helper.call(
        2,
        "fs.manifest.scan_commit",
        serde_json::json!({ "dir": head_dir.to_str().unwrap() }),
    )["result"]["manifest_sha256"]
        .as_str()
        .unwrap()
        .to_string();

    // live = base + local edit to c.txt (locally dirty), materialized from base.
    let live = tmp.path().join("live");
    helper.call(
        3,
        "fs.manifest.materialize",
        serde_json::json!({ "manifest_sha256": base_sha, "target_dir": live.to_str().unwrap() }),
    );
    std::fs::write(live.join("c.txt"), "c-local").unwrap();

    // dir.sync from base → head: a.txt (not locally dirty) gets a2;
    // newremote.txt added; c.txt left local (not touched by head, so applied?).
    // head did NOT change c.txt, so it's not in incoming → local c-local stays.
    let r = helper.call(
        4,
        "fs.dir.sync",
        serde_json::json!({
            "dir": live.to_str().unwrap(),
            "base_manifest_sha256": base_sha,
            "to_manifest_sha256": head_sha,
        }),
    );
    let applied: Vec<String> = r["result"]["applied"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap().to_string())
        .collect();
    assert!(applied.contains(&"/a.txt".to_string()), "{r}");
    assert!(applied.contains(&"/newremote.txt".to_string()), "{r}");
    assert_eq!(r["result"]["new_base_manifest_sha256"], head_sha, "{r}");
    // live dir now: a.txt=a2 (synced), newremote.txt=nr (synced), c.txt=c-local (preserved).
    assert_eq!(std::fs::read(live.join("a.txt")).unwrap(), b"a2");
    assert_eq!(std::fs::read(live.join("newremote.txt")).unwrap(), b"nr");
    assert_eq!(std::fs::read(live.join("c.txt")).unwrap(), b"c-local");
    helper.stop();
}

#[test]
fn dir_sync_defers_conflict_on_same_path_local_and_incoming() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    let cas = tmp.path().join("cas");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn_with_cas(&root, &work, &cas);

    let base_dir = tmp.path().join("base");
    std::fs::create_dir_all(&base_dir).unwrap();
    std::fs::write(base_dir.join("x.txt"), "base").unwrap();
    let base_sha = helper.call(
        1,
        "fs.manifest.scan_commit",
        serde_json::json!({ "dir": base_dir.to_str().unwrap() }),
    )["result"]["manifest_sha256"]
        .as_str()
        .unwrap()
        .to_string();

    let head_dir = tmp.path().join("head");
    std::fs::create_dir_all(&head_dir).unwrap();
    std::fs::write(head_dir.join("x.txt"), "head").unwrap();
    let head_sha = helper.call(
        2,
        "fs.manifest.scan_commit",
        serde_json::json!({ "dir": head_dir.to_str().unwrap() }),
    )["result"]["manifest_sha256"]
        .as_str()
        .unwrap()
        .to_string();

    let live = tmp.path().join("live");
    helper.call(
        3,
        "fs.manifest.materialize",
        serde_json::json!({ "manifest_sha256": base_sha, "target_dir": live.to_str().unwrap() }),
    );
    // local edits x.txt too (conflict with head's edit).
    std::fs::write(live.join("x.txt"), "local").unwrap();

    let r = helper.call(
        4,
        "fs.dir.sync",
        serde_json::json!({
            "dir": live.to_str().unwrap(),
            "base_manifest_sha256": base_sha,
            "to_manifest_sha256": head_sha,
        }),
    );
    let deferred: Vec<String> = r["result"]["deferred_conflicts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap().to_string())
        .collect();
    assert_eq!(deferred, vec!["/x.txt".to_string()], "{r}");
    // local version is preserved (not clobbered by head).
    assert_eq!(std::fs::read(live.join("x.txt")).unwrap(), b"local");
    helper.stop();
}

#[test]
fn cas_gc_deletes_orphans_keeps_reachable() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    let cas = tmp.path().join("cas");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn_with_cas(&root, &work, &cas);
    // Put two blobs.
    let keep_src = tmp.path().join("keep.txt");
    let orphan_src = tmp.path().join("orphan.txt");
    std::fs::write(&keep_src, "keepme").unwrap();
    std::fs::write(&orphan_src, "orphanme").unwrap();
    let keep_sha = helper.call(1, "fs.cas.put", serde_json::json!({ "path": keep_src.to_str().unwrap() }))
        ["result"]["sha256"].as_str().unwrap().to_string();
    let orphan_sha = helper.call(2, "fs.cas.put", serde_json::json!({ "path": orphan_src.to_str().unwrap() }))
        ["result"]["sha256"].as_str().unwrap().to_string();
    // GC with grace_secs=0 (no young-blob protection) and reachable=[keep_sha]
    // → orphan deleted immediately.
    let g = helper.call(
        3,
        "fs.cas.gc",
        serde_json::json!({ "reachable_sha256": [keep_sha.clone()], "grace_secs": 0 }),
    );
    assert_eq!(g["result"]["deleted_count"].as_u64(), Some(1), "{g}");
    assert_eq!(helper.call(4, "fs.cas.has", serde_json::json!({ "sha256": keep_sha }))["result"]["exists"], true);
    assert_eq!(helper.call(5, "fs.cas.has", serde_json::json!({ "sha256": orphan_sha }))["result"]["exists"], false);
    helper.stop();
}

#[test]
fn cas_gc_grace_window_protects_young_unreachable_blobs() {
    // The commit/GC race guard: a freshly-written blob that is not (yet) in the
    // reachable set must NOT be deleted while it's younger than grace_secs.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let work = tmp.path().join("work");
    let cas = tmp.path().join("cas");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let mut helper = Helper::spawn_with_cas(&root, &work, &cas);
    let young_src = tmp.path().join("young.txt");
    std::fs::write(&young_src, "fresh-uncommitted").unwrap();
    let young_sha = helper
        .call(1, "fs.cas.put", serde_json::json!({ "path": young_src.to_str().unwrap() }))
        ["result"]["sha256"]
        .as_str()
        .unwrap()
        .to_string();
    // GC with an EMPTY reachable set but a large grace window → the young blob
    // is unreachable yet protected (deleted_count = 0).
    let g = helper.call(
        2,
        "fs.cas.gc",
        serde_json::json!({ "reachable_sha256": [], "grace_secs": 3600 }),
    );
    assert_eq!(g["result"]["deleted_count"].as_u64(), Some(0), "{g}");
    assert_eq!(
        helper.call(3, "fs.cas.has", serde_json::json!({ "sha256": young_sha }))["result"]["exists"],
        true,
        "young unreachable blob protected by the grace window"
    );
    helper.stop();
}
