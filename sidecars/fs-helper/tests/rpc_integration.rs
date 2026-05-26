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
