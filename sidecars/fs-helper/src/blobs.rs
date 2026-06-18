//! sha256-addressed blob store under <work_dir>/blobs/<aa>/<sha256>.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::rpc::RpcError;

pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    pub fn open(work_dir: &Path) -> Result<Self, RpcError> {
        let root = work_dir.join("blobs");
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    pub fn blob_path(&self, sha256: &str) -> PathBuf {
        let prefix = &sha256[..2.min(sha256.len())];
        self.root.join(prefix).join(sha256)
    }

    /// Stream-copy `src` into a blob, double-hashing source + blob; verifies
    /// the source hash equals `expected_sha256` if provided. Returns
    /// (sha256, size, dedup_flag). Opens the source with `O_NOFOLLOW` so a
    /// symlink swap between the TS-side safeResolve and this call cannot
    /// redirect the snapshot's target. If blob already exists, no rewrite
    /// is performed and `dedup_flag = true`. NEVER hardlink — plan §2.
    pub fn put_streaming(
        &self,
        src: &Path,
        expected_sha256: Option<&str>,
    ) -> Result<(String, u64, bool), RpcError> {
        let mut src_file = open_nofollow(src)?;
        let mut src_hash = Sha256::new();
        let tmp_path = self.root.join(format!("incoming.{}", uuid_like()));
        let mut tmp_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .truncate(true)
            .open(&tmp_path)?;
        let mut blob_hash = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        let mut total: u64 = 0;
        loop {
            let n = src_file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            src_hash.update(&buf[..n]);
            blob_hash.update(&buf[..n]);
            tmp_file.write_all(&buf[..n])?;
            total += n as u64;
        }
        tmp_file.sync_all()?;
        drop(tmp_file);
        let src_sha = hex::encode(src_hash.finalize());
        let blob_sha = hex::encode(blob_hash.finalize());
        if src_sha != blob_sha {
            let _ = fs::remove_file(&tmp_path);
            return Err(RpcError::Internal(
                "hash divergence: source vs blob".into(),
            ));
        }
        if let Some(exp) = expected_sha256 {
            if exp != src_sha {
                let _ = fs::remove_file(&tmp_path);
                return Err(RpcError::CasMismatch(format!(
                    "source sha {} != expected {}",
                    src_sha, exp
                )));
            }
        }
        let final_path = self.blob_path(&src_sha);
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent)?;
        }
        if final_path.exists() {
            let _ = fs::remove_file(&tmp_path);
            return Ok((src_sha, total, true));
        }
        fs::rename(&tmp_path, &final_path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                fs::set_permissions(&final_path, fs::Permissions::from_mode(0o600));
        }
        Ok((src_sha, total, false))
    }

    pub fn read(&self, sha256: &str) -> Result<Vec<u8>, RpcError> {
        let p = self.blob_path(sha256);
        Ok(fs::read(&p)?)
    }

    /// True if a blob with this sha256 is present.
    pub fn exists(&self, sha256: &str) -> bool {
        self.blob_path(sha256).exists()
    }

    /// Size in bytes of a stored blob, or None if absent.
    pub fn size_of(&self, sha256: &str) -> Result<Option<u64>, RpcError> {
        let p = self.blob_path(sha256);
        match fs::metadata(&p) {
            Ok(m) => Ok(Some(m.len())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Store in-memory bytes into the CAS with the same atomic + dedup
    /// semantics as `put_streaming`. Used for manifest blobs computed in
    /// memory by scan_commit. Returns (sha256, size, dedup_flag).
    pub fn put_bytes(&self, bytes: &[u8]) -> Result<(String, u64, bool), RpcError> {
        let sha = hex::encode(Sha256::digest(bytes));
        let final_path = self.blob_path(&sha);
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent)?;
        }
        if final_path.exists() {
            return Ok((sha, bytes.len() as u64, true));
        }
        let tmp_path = self.root.join(format!("incoming.{}", uuid_like()));
        {
            let mut tmp_file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .truncate(true)
                .open(&tmp_path)?;
            tmp_file.write_all(bytes)?;
            tmp_file.sync_all()?;
        }
        if final_path.exists() {
            let _ = fs::remove_file(&tmp_path);
            return Ok((sha, bytes.len() as u64, true));
        }
        fs::rename(&tmp_path, &final_path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                fs::set_permissions(&final_path, fs::Permissions::from_mode(0o600));
        }
        Ok((sha, bytes.len() as u64, false))
    }

    /// Ingest already-fetched axis-B body bytes into the CAS. Split out of the
    /// former `import_url` so the network GET (`fetch_url_body`) runs WITHOUT the
    /// `cas_lock` held — only this content-addressed store step takes the lock.
    /// The supervisor asserts `sha256`; after storing we re-verify the
    /// content-addressed sha equals it and reject a mismatch with `CasMismatch`
    /// (put_bytes is content-addressed so no delete is needed — a mismatched body
    /// simply landed under a DIFFERENT sha, never overwriting the asserted one).
    /// Returns (sha, size, dedup).
    pub fn ingest_imported_bytes(
        &self,
        sha256: &str,
        body: &[u8],
    ) -> Result<(String, u64, bool), RpcError> {
        let (sha, size, dedup) = self.put_bytes(body)?;
        if sha != sha256 {
            return Err(RpcError::CasMismatch(format!(
                "imported sha {sha} != supervisor-asserted {sha256}"
            )));
        }
        Ok((sha, size, dedup))
    }

    /// Read the local blob `sha256`'s bytes for an axis-B export (NotFound if
    /// absent, mirroring `copy_to`). Split out of the former `export_to_url` so
    /// the network PUT (`put_url_body`) runs WITHOUT the `cas_lock` held — only
    /// this read takes the lock.
    pub fn read_for_export(&self, sha256: &str) -> Result<Vec<u8>, RpcError> {
        let src = self.blob_path(sha256);
        if !src.exists() {
            return Err(RpcError::NotFound(format!("blob {sha256}")));
        }
        self.read(sha256)
    }

    /// Materialize a blob's bytes into `dest` as a regular file, creating
    /// parent dirs, then set its permission bits to `mode`. Tries a reflink
    /// (CoW clone — O(1), near-zero space) first on same-fs CoW filesystems
    /// (btrfs/xfs/bcachefs); falls back to a full byte copy on EXDEV / ext4 /
    /// any filesystem that doesn't support FICLONE. `dest` is a path the
    /// supervisor controls (a materialized live dir), not user-supplied, so no
    /// symlink-jail concerns here. We DELIBERATELY do not hardlink: the sandbox
    /// runs under a different uid and CAS blobs are 0600 owned by the supervisor,
    /// so a shared inode would be unreadable and any chmod would corrupt the CAS
    /// blob's mode. A reflink is a distinct inode (independent mode + CoW data),
    /// so it has neither problem.
    pub fn copy_to(
        &self,
        sha256: &str,
        dest: &Path,
        mode: u32,
    ) -> Result<(), RpcError> {
        let src = self.blob_path(sha256);
        if !src.exists() {
            return Err(RpcError::NotFound(format!("blob {sha256}")));
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        // Remove any pre-existing dest so copy is deterministic.
        if dest.symlink_metadata().is_ok() {
            let _ = fs::remove_file(dest);
        }
        if !try_reflink(&src, dest) {
            fs::copy(&src, dest)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dest, fs::Permissions::from_mode(mode))?;
        }
        let _ = mode;
        Ok(())
    }

    /// Every sha256 currently present in the store (walk blobs/<aa>/<sha>).
    /// Used by GC mark-sweep. Ignores the transient `incoming.*` temp files
    /// (they live directly under blobs/, not under a 2-char fan-out dir) and
    /// any non-64-hex entries.
    pub fn list_all(&self) -> Result<Vec<String>, RpcError> {
        let mut out = Vec::new();
        if !self.root.exists() {
            return Ok(out);
        }
        for aa in fs::read_dir(&self.root)? {
            let aa = aa?;
            if !aa.file_type()?.is_dir() {
                continue;
            }
            for f in fs::read_dir(aa.path())? {
                let f = f?;
                if let Some(name) = f.file_name().to_str() {
                    if name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit())
                    {
                        out.push(name.to_string());
                    }
                }
            }
        }
        Ok(out)
    }

    /// Stage a blob's contents into a tmp file with the given token. Used by
    /// restore tmp_token mode.
    pub fn stage_to(&self, sha256: &str, dest: &Path) -> Result<u64, RpcError> {
        let src = self.blob_path(sha256);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        // O_CREAT|O_EXCL 0600
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .truncate(true)
            .open(dest)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dest, fs::Permissions::from_mode(0o600));
        }
        let mut input = fs::File::open(&src)?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut total: u64 = 0;
        loop {
            let n = input.read(&mut buf)?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])?;
            total += n as u64;
        }
        out.sync_all()?;
        Ok(total)
    }

    pub fn delete(&self, sha256: &str) -> Result<(), RpcError> {
        let p = self.blob_path(sha256);
        if p.exists() {
            fs::remove_file(&p)?;
        }
        Ok(())
    }

    /// Age (seconds) since a blob's last modification, or None if it can't be
    /// stat'd. Used by GC to protect just-written blobs from a concurrent sweep.
    fn blob_age_secs(&self, sha256: &str) -> Option<u64> {
        let meta = fs::metadata(self.blob_path(sha256)).ok()?;
        let mtime = meta.modified().ok()?;
        mtime.elapsed().ok().map(|d| d.as_secs())
    }

    /// GC mark-sweep with a grace window: delete every blob whose sha is NOT in
    /// `reachable`, EXCEPT blobs modified within the last `grace_secs` seconds.
    ///
    /// The grace guard closes the commit/GC data-loss race: commit ingests new
    /// blobs into the CAS BEFORE the snapshot row is committed, so for a brief
    /// window a freshly-written blob is on disk but not yet DB-reachable. Without
    /// the guard a concurrent GC would delete it and corrupt the in-flight
    /// snapshot. `grace_secs` must exceed the longest plausible
    /// scan→ingest→commit duration. Returns (deleted, skipped_young).
    pub fn gc_sweep(
        &self,
        reachable: &std::collections::HashSet<String>,
        grace_secs: u64,
    ) -> Result<(u64, u64), RpcError> {
        let mut deleted = 0u64;
        let mut skipped_young = 0u64;
        for sha in self.list_all()? {
            if reachable.contains(&sha) {
                continue;
            }
            // Protect blobs younger than the grace window (in-flight commits).
            if let Some(age) = self.blob_age_secs(&sha) {
                if age < grace_secs {
                    skipped_young += 1;
                    continue;
                }
            }
            self.delete(&sha)?;
            deleted += 1;
        }
        Ok((deleted, skipped_young))
    }
}

/// Absolute ceiling on a buffered axis-B import body. The host presign size
/// class is ≤5 GiB; cap the in-memory buffer here so a hostile/mis-minted
/// presigned GET can't OOM the helper by streaming an unbounded body. When the
/// supervisor supplies `expected_size`, that (smaller) value is the effective
/// cap; this is the fallback ceiling when it doesn't.
const MAX_IMPORT_BODY_BYTES: u64 = 5 * 1024 * 1024 * 1024;

/// Axis-B import network step: GET a supervisor-minted presigned `url` with
/// `client` and return its body bytes. Runs WITHOUT the `cas_lock` held (the
/// caller takes the lock only for `ingest_imported_bytes`). The helper holds NO
/// credentials — only the short-lived `url`.
///
/// Bounded read: the body is buffered fully (reqwest's `bytes()` is NOT behind
/// the "stream" feature, so we deliberately avoid that feature), but it is
/// size-guarded so a hostile presigned GET can't OOM the helper. When
/// `expected_size` is Some, the advertised Content-Length (when present) must
/// not exceed it, and the body is capped at it; otherwise the body is capped at
/// `MAX_IMPORT_BODY_BYTES`. Streaming the body chunk-by-chunk lets us abort as
/// soon as the cap is crossed, even when the server sends no/forged
/// Content-Length. Maps reqwest / non-2xx errors to `Internal`.
pub async fn fetch_url_body(
    client: &reqwest::Client,
    url: &str,
    expected_size: Option<u64>,
) -> Result<Vec<u8>, RpcError> {
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| RpcError::Internal(format!("import_url GET failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(RpcError::Internal(format!(
            "import_url non-2xx status: {status}"
        )));
    }
    // Effective cap: the supervisor-asserted size when present, else the ceiling.
    let cap = expected_size
        .map(|e| e.min(MAX_IMPORT_BODY_BYTES))
        .unwrap_or(MAX_IMPORT_BODY_BYTES);
    if let Some(exp) = expected_size {
        if let Some(len) = resp.content_length() {
            if len != exp {
                return Err(RpcError::Internal(format!(
                    "import_url content-length {len} != expected {exp}"
                )));
            }
        }
    } else if let Some(len) = resp.content_length() {
        // No supervisor assertion, but a declared length over the ceiling is a
        // hard reject up front (don't even start the transfer).
        if len > MAX_IMPORT_BODY_BYTES {
            return Err(RpcError::Internal(format!(
                "import_url content-length {len} exceeds cap {MAX_IMPORT_BODY_BYTES}"
            )));
        }
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| {
        RpcError::Internal(format!("import_url read body failed: {e}"))
    })? {
        if body.len() as u64 + chunk.len() as u64 > cap {
            return Err(RpcError::Internal(format!(
                "import_url body exceeds cap {cap}"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Axis-B export network step: PUT `bytes` to a supervisor-minted presigned
/// `put_url` with `client`, attaching the supplied `headers` verbatim (e.g.
/// `x-amz-checksum-sha256`, which the supervisor — not the helper — constructs
/// and signs into the URL's signed set). Runs WITHOUT the `cas_lock` held (the
/// caller takes the lock only for `read_for_export`). The body is buffered
/// (`.body(Vec<u8>)`; fine for the ≤5 GB host presign size class). Non-2xx →
/// `Internal`. Returns (size, etag-if-the-response-carries-one).
pub async fn put_url_body(
    client: &reqwest::Client,
    put_url: &str,
    bytes: Vec<u8>,
    headers: &[(String, String)],
) -> Result<(u64, Option<String>), RpcError> {
    let size = bytes.len() as u64;
    let mut req = client.put(put_url).body(bytes);
    for (name, value) in headers {
        req = req.header(name.as_str(), value.as_str());
    }
    let resp = req
        .send()
        .await
        .map_err(|e| RpcError::Internal(format!("export_to_url PUT failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(RpcError::Internal(format!(
            "export_to_url non-2xx status: {status}"
        )));
    }
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    Ok((size, etag))
}

/// Open `src` with O_NOFOLLOW so a final-component symlink swap can't
/// redirect us to a different file after path validation. On platforms
/// without O_NOFOLLOW the symlink risk is documented as residual (plan §1
/// Known limitations). Exposed `pub(crate)` so index.rs can use the same
/// helper.
pub(crate) fn open_nofollow(src: &Path) -> Result<fs::File, RpcError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        Ok(fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc_o_nofollow())
            .open(src)?)
    }
    #[cfg(not(unix))]
    {
        Ok(fs::File::open(src)?)
    }
}

#[cfg(unix)]
fn libc_o_nofollow() -> i32 {
    // Avoid taking a libc dependency just for this constant.
    #[cfg(target_os = "linux")]
    {
        0x20000 // O_NOFOLLOW on Linux
    }
    #[cfg(target_os = "macos")]
    {
        0x100 // O_NOFOLLOW on macOS / BSD
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        0
    }
}

/// Best-effort unique tag — only used for the in-progress incoming file name.
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:016x}{:08x}", nanos, std::process::id())
}

/// Attempt a reflink (CoW clone) of `src` → `dest` via the Linux FICLONE ioctl.
/// Returns true on success. Returns false (caller falls back to a byte copy) on
/// any failure: cross-filesystem (EXDEV), unsupported fs (ext4 → ENOTTY/EOPNOTSUPP),
/// or non-Linux. `dest` must not already exist (caller removes it first).
#[cfg(target_os = "linux")]
fn try_reflink(src: &Path, dest: &Path) -> bool {
    use std::os::unix::io::AsRawFd;

    // FICLONE: clone the whole file. _IOW(0x94, 9, int) on Linux.
    const FICLONE: std::os::raw::c_ulong = 0x4004_9409;

    extern "C" {
        fn ioctl(
            fd: std::os::raw::c_int,
            request: std::os::raw::c_ulong,
            ...
        ) -> std::os::raw::c_int;
    }

    let src_file = match fs::File::open(src) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let dest_file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
    {
        Ok(f) => f,
        Err(_) => return false,
    };
    // SAFETY: both fds are valid for the duration of the call; FICLONE takes the
    // source fd as its int argument and clones into the dest fd.
    let rc = unsafe {
        ioctl(
            dest_file.as_raw_fd(),
            FICLONE,
            src_file.as_raw_fd() as std::os::raw::c_int,
        )
    };
    if rc == 0 {
        true
    } else {
        // Clone failed (EXDEV/ENOTTY/EOPNOTSUPP/...). Remove the empty dest we
        // just created so the byte-copy fallback can recreate it cleanly.
        let _ = fs::remove_file(dest);
        false
    }
}

#[cfg(not(target_os = "linux"))]
fn try_reflink(_src: &Path, _dest: &Path) -> bool {
    false
}
