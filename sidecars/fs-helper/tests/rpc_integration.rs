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
