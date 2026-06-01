//! Working-tree manifest: a byte-stable serialization of a directory tree
//! as a CAS blob, plus the scan / materialize / 3-way-merge / dir-sync
//! operations that turn plain host directories into snapshots and back.
//!
//! A manifest is the authoritative working-tree state (it REPLACES the old
//! per-write history.sqlite for the sandbox file spaces). It records every
//! entry — files (with content sha256 + size), **empty directories**, and
//! **symlinks** (with their target) — so materialize is lossless. The
//! serialization is byte-stable (entries sorted by path, canonical mode,
//! LF line terminator) so an identical tree always produces the identical
//! manifest sha256 → manifests dedup in CAS and the v0→v1 invariant holds.
//!
//! Plain-directory model (no overlayfs): there are no whiteout char-dev
//! nodes or `trusted.overlay.opaque` xattrs to interpret — a directory scan
//! is the entire source of truth, which is exactly why this model dodges
//! the overlay Blocker. The `.synapse-internal` namespace (the VFS's own
//! tmp/restore staging) is excluded from every scan/materialize/sync.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::blobs::BlobStore;
use crate::rpc::RpcError;

/// The VFS-internal namespace; never materialized or scanned. Mirrors
/// path.rs INTERNAL_NAMESPACE (the device-runtime VFS creates this dir
/// inside the root for atomic-write staging; it must not leak into a
/// snapshot).
const INTERNAL_DIRNAME: &str = ".synapse-internal";

/// Conflict-sidecar namespace. On a refresh (dir_sync) conflict, HEAD WINS in
/// the live tree: head's version is applied to the original path, and the
/// agent's PRE-CONFLICT LOCAL version of every dirty file in the affected
/// subtree is preserved here as `.synapse-conflicts/<path>` so its work isn't
/// lost (including the tree/delete case, where applying head would otherwise
/// remove the whole subtree). The agent reconciles by reading the live path
/// (now head) + its sidecar and re-saving the merged result, which then commits
/// cleanly. Unlike `.synapse-internal` (which the VFS blocks the agent from
/// reading), this dir is agent-readable; like it, it is NEVER scanned into a
/// snapshot, so the sidecars don't get committed.

/// Kind of a manifest entry. A pure path→content map cannot represent an
/// empty directory or a symlink, so we tag every entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
}

impl EntryKind {
    fn tag(self) -> &'static str {
        match self {
            EntryKind::File => "f",
            EntryKind::Dir => "d",
            EntryKind::Symlink => "l",
        }
    }
    fn from_tag(t: &str) -> Option<Self> {
        match t {
            "f" => Some(EntryKind::File),
            "d" => Some(EntryKind::Dir),
            "l" => Some(EntryKind::Symlink),
            _ => None,
        }
    }
}

/// One manifest entry. `path` is a canonical VFS path (leading '/', no
/// trailing slash, POSIX). For files, `sha256`+`size` are set. For symlinks,
/// `target` is set (the raw link string). For dirs, only `path`+`mode`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub path: String,
    pub kind: EntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub mode: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

/// A whole manifest = ordered set of entries keyed by path.
#[derive(Debug, Clone, Default)]
pub struct Manifest {
    /// path -> entry. BTreeMap keeps iteration in sorted-path order, which
    /// is what makes serialization byte-stable.
    pub entries: BTreeMap<String, ManifestEntry>,
}

impl Manifest {
    pub fn new() -> Self {
        Self { entries: BTreeMap::new() }
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    pub fn total_bytes(&self) -> u64 {
        self.entries.values().filter_map(|e| e.size).sum()
    }

    /// Byte-stable line serialization. One entry per line:
    ///   `<tag>\t<mode-octal>\t<size|->\t<sha256|->\t<target-b64|->\t<path>\n`
    /// Sorted by path (BTreeMap), fixed field order, LF terminator. The path
    /// is last so embedded tabs in a path (canonical paths never contain
    /// control chars, but be defensive) can't shift the column layout; the
    /// symlink target is base64'd so newlines/tabs in a target are inert.
    pub fn serialize(&self) -> Vec<u8> {
        use base64::Engine;
        let mut out = String::new();
        // A version line keeps the format forward-evolvable without breaking
        // the byte-stable dedup (same content + same version = same bytes).
        out.push_str("synapse-manifest-v1\n");
        for e in self.entries.values() {
            let size = e.size.map(|s| s.to_string()).unwrap_or_else(|| "-".into());
            let sha = e.sha256.clone().unwrap_or_else(|| "-".into());
            let target = match &e.target {
                Some(t) => base64::engine::general_purpose::STANDARD
                    .encode(t.as_bytes()),
                None => "-".into(),
            };
            out.push_str(&format!(
                "{}\t{:o}\t{}\t{}\t{}\t{}\n",
                e.kind.tag(),
                e.mode,
                size,
                sha,
                target,
                e.path,
            ));
        }
        out.into_bytes()
    }

    pub fn deserialize(bytes: &[u8]) -> Result<Self, RpcError> {
        use base64::Engine;
        let text = std::str::from_utf8(bytes)
            .map_err(|e| RpcError::Internal(format!("manifest utf8: {e}")))?;
        let mut lines = text.lines();
        match lines.next() {
            Some("synapse-manifest-v1") => {}
            other => {
                return Err(RpcError::Internal(format!(
                    "manifest bad header: {other:?}"
                )))
            }
        }
        let mut m = Manifest::new();
        for line in lines {
            if line.is_empty() {
                continue;
            }
            let parts: Vec<&str> = line.splitn(6, '\t').collect();
            if parts.len() != 6 {
                return Err(RpcError::Internal(format!(
                    "manifest bad line: {line:?}"
                )));
            }
            let kind = EntryKind::from_tag(parts[0]).ok_or_else(|| {
                RpcError::Internal(format!("manifest bad kind: {:?}", parts[0]))
            })?;
            let mode = u32::from_str_radix(parts[1], 8)
                .map_err(|e| RpcError::Internal(format!("manifest mode: {e}")))?;
            let size = if parts[2] == "-" {
                None
            } else {
                Some(parts[2].parse::<u64>().map_err(|e| {
                    RpcError::Internal(format!("manifest size: {e}"))
                })?)
            };
            let sha256 = if parts[3] == "-" {
                None
            } else {
                Some(parts[3].to_string())
            };
            let target = if parts[4] == "-" {
                None
            } else {
                let raw = base64::engine::general_purpose::STANDARD
                    .decode(parts[4])
                    .map_err(|e| {
                        RpcError::Internal(format!("manifest target b64: {e}"))
                    })?;
                Some(
                    String::from_utf8(raw).map_err(|e| {
                        RpcError::Internal(format!("manifest target utf8: {e}"))
                    })?,
                )
            };
            let path = parts[5].to_string();
            m.entries.insert(
                path.clone(),
                ManifestEntry { path, kind, sha256, mode, size, target },
            );
        }
        Ok(m)
    }

    /// Load a manifest from CAS by its blob sha256. `None` manifest_sha256
    /// (or empty string) means an empty tree.
    pub fn load(
        cas: &BlobStore,
        manifest_sha256: Option<&str>,
    ) -> Result<Self, RpcError> {
        match manifest_sha256 {
            None => Ok(Manifest::new()),
            Some(s) if s.is_empty() => Ok(Manifest::new()),
            Some(s) => {
                let bytes = cas.read(s)?;
                Manifest::deserialize(&bytes)
            }
        }
    }

    /// Serialize + store this manifest in CAS, returning its sha256.
    pub fn store(&self, cas: &BlobStore) -> Result<String, RpcError> {
        let bytes = self.serialize();
        let (sha, _, _) = cas.put_bytes(&bytes)?;
        Ok(sha)
    }
}

/// Whether a path's first segment is the reserved internal namespace.
fn is_internal(rel: &str) -> bool {
    rel == INTERNAL_DIRNAME || rel.starts_with(&format!("{INTERNAL_DIRNAME}/"))
}

const CONFLICTS_DIRNAME: &str = ".synapse-conflicts";

/// Whether a path is in a reserved namespace that scan never commits: the
/// VFS-internal staging dir OR the conflict-sidecar dir.
fn is_reserved(rel: &str) -> bool {
    is_internal(rel)
        || rel == CONFLICTS_DIRNAME
        || rel.starts_with(&format!("{CONFLICTS_DIRNAME}/"))
}

/// Canonical VFS path for a relative host path. Always leading '/', POSIX
/// separators. Empty rel → "/" is never an entry (root is implicit).
fn to_vfs_path(rel: &str) -> String {
    let rel = rel.trim_start_matches('/');
    format!("/{}", rel)
}

/// Scan a plain host directory into a Manifest, streaming each regular
/// file's bytes into the CAS. Returns (manifest, newly-created-blob-shas).
/// Empty directories and symlinks are captured with their kind. The
/// `.synapse-internal` namespace is skipped entirely.
///
/// NOTE: this does NOT follow symlinks — a symlink is recorded as a
/// symlink entry (kind=Symlink, target=link string), never traversed.
/// Special files (fifo/socket/device/block) are skipped (a sandbox
/// shouldn't be persisting those into a content store).
pub fn scan_dir(
    cas: &BlobStore,
    dir: &Path,
) -> Result<(Manifest, Vec<String>), RpcError> {
    let mut m = Manifest::new();
    let mut new_blobs = Vec::new();
    if !dir.exists() {
        return Ok((m, new_blobs));
    }
    scan_recursive(cas, dir, dir, &mut m, &mut new_blobs)?;
    Ok((m, new_blobs))
}

fn scan_recursive(
    cas: &BlobStore,
    root: &Path,
    cur: &Path,
    m: &mut Manifest,
    new_blobs: &mut Vec<String>,
) -> Result<(), RpcError> {
    let mut children: Vec<_> = fs::read_dir(cur)?.collect::<Result<_, _>>()?;
    // Deterministic traversal order (defensive; BTreeMap re-sorts anyway).
    children.sort_by_key(|e| e.file_name());
    for child in children {
        let host_path = child.path();
        let rel = host_path
            .strip_prefix(root)
            .map_err(|e| RpcError::Internal(format!("strip_prefix: {e}")))?
            .to_string_lossy()
            .replace('\\', "/");
        if is_reserved(&rel) {
            continue;
        }
        let vfs = to_vfs_path(&rel);
        // symlink_metadata: do NOT follow.
        let meta = fs::symlink_metadata(&host_path)?;
        let ft = meta.file_type();
        let mode = mode_of(&meta);
        if ft.is_symlink() {
            let target = fs::read_link(&host_path)?
                .to_string_lossy()
                .to_string();
            m.entries.insert(
                vfs.clone(),
                ManifestEntry {
                    path: vfs,
                    kind: EntryKind::Symlink,
                    sha256: None,
                    mode,
                    size: None,
                    target: Some(target),
                },
            );
        } else if ft.is_dir() {
            // Record the directory entry (captures empty dirs). Then recurse.
            m.entries.insert(
                vfs.clone(),
                ManifestEntry {
                    path: vfs,
                    kind: EntryKind::Dir,
                    sha256: None,
                    mode,
                    size: None,
                    target: None,
                },
            );
            scan_recursive(cas, root, &host_path, m, new_blobs)?;
        } else if ft.is_file() {
            let (sha, size, dedup) = cas.put_streaming(&host_path, None)?;
            if !dedup {
                new_blobs.push(sha.clone());
            }
            m.entries.insert(
                vfs.clone(),
                ManifestEntry {
                    path: vfs,
                    kind: EntryKind::File,
                    sha256: Some(sha),
                    mode,
                    size: Some(size),
                    target: None,
                },
            );
        }
        // else: special file (fifo/socket/device) — skip.
    }
    Ok(())
}

#[cfg(unix)]
fn mode_of(meta: &fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    meta.mode() & 0o7777
}
#[cfg(not(unix))]
fn mode_of(_meta: &fs::Metadata) -> u32 {
    0o644
}

/// Materialize a manifest into `target_dir` as a plain directory tree.
/// Files are copied from CAS (Step 11 will swap in reflink), empty dirs are
/// created, symlinks are recreated. The `target_dir` is created if absent.
/// `file_mode`/`dir_mode` override the stored modes when set (so a sandbox
/// uid can read them); when None, the manifest's stored mode is used (but
/// always OR'd with owner-read so the supervisor/sandbox can read).
pub fn materialize(
    cas: &BlobStore,
    manifest: &Manifest,
    target_dir: &Path,
) -> Result<(), RpcError> {
    fs::create_dir_all(target_dir)?;
    // Start from a clean target so a re-materialize into a non-empty dir can't
    // leave stale files (from a previous snapshot) that would pollute the next
    // scan or shadow a type change.
    clear_dir_contents(target_dir)?;
    // Create dirs first (sorted order means parents precede children), then
    // files/symlinks. BTreeMap iteration is already sorted by path, so a
    // parent dir entry always comes before its children.
    for e in manifest.entries.values() {
        let host = vfs_to_host(target_dir, &e.path);
        match e.kind {
            EntryKind::Dir => {
                prepare_dest_for_kind(&host, EntryKind::Dir)?;
                fs::create_dir_all(&host)?;
                set_mode(&host, e.mode | 0o700)?;
            }
            EntryKind::File => {
                if let Some(parent) = host.parent() {
                    fs::create_dir_all(parent)?;
                }
                prepare_dest_for_kind(&host, EntryKind::File)?;
                let sha = e.sha256.as_deref().ok_or_else(|| {
                    RpcError::Internal(format!("file entry without sha: {}", e.path))
                })?;
                // OR owner rw so the materializing process can always read
                // it back for the next scan; sandbox-readable.
                cas.copy_to(sha, &host, e.mode | 0o600)?;
            }
            EntryKind::Symlink => {
                if let Some(parent) = host.parent() {
                    fs::create_dir_all(parent)?;
                }
                prepare_dest_for_kind(&host, EntryKind::Symlink)?;
                let target = e.target.as_deref().ok_or_else(|| {
                    RpcError::Internal(format!(
                        "symlink entry without target: {}",
                        e.path
                    ))
                })?;
                symlink_raw(target, &host)?;
            }
        }
    }
    Ok(())
}

/// Map a canonical VFS path under a host root. Mirrors path::host_path but
/// operates on an arbitrary target dir (the materialized live dir, not the
/// device --root).
fn vfs_to_host(root: &Path, vfs: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for seg in vfs.trim_start_matches('/').split('/') {
        if !seg.is_empty() {
            p.push(seg);
        }
    }
    p
}

/// Ensure `host` is ready to receive a `desired` entry kind by removing anything
/// already there whose type doesn't match. Without this a type change
/// (dir→file, file→dir, file→symlink, …) fails: create_dir_all() errors on an
/// existing file, and copy_to()/symlink only remove via remove_file() (which
/// fails on a directory). For Dir we keep an existing directory (merge into it);
/// for File/Symlink we remove any existing dir/file/symlink so the writer can
/// recreate it cleanly.
fn prepare_dest_for_kind(host: &Path, desired: EntryKind) -> Result<(), RpcError> {
    let meta = match host.symlink_metadata() {
        Ok(m) => m,
        Err(_) => return Ok(()), // nothing there
    };
    let ft = meta.file_type();
    match desired {
        EntryKind::Dir => {
            // Keep an existing real directory (we'll merge into it); remove a
            // file/symlink occupying the path so create_dir_all can succeed.
            if !ft.is_dir() {
                fs::remove_file(host)?;
            }
        }
        EntryKind::File | EntryKind::Symlink => {
            if ft.is_dir() {
                fs::remove_dir_all(host)?;
            } else {
                fs::remove_file(host)?;
            }
        }
    }
    Ok(())
}

/// Remove all entries inside `dir` (but not `dir` itself), so a materialize into
/// a possibly-non-empty target starts clean and can't leave stale files behind
/// that would pollute the next scan. Best-effort per entry.
fn clear_dir_contents(dir: &Path) -> Result<(), RpcError> {
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(()),
    };
    for entry in rd.flatten() {
        let p = entry.path();
        let meta = match p.symlink_metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_dir() {
            let _ = fs::remove_dir_all(&p);
        } else {
            let _ = fs::remove_file(&p);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn set_mode(p: &Path, mode: u32) -> Result<(), RpcError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(p, fs::Permissions::from_mode(mode))?;
    Ok(())
}
#[cfg(not(unix))]
fn set_mode(_p: &Path, _mode: u32) -> Result<(), RpcError> {
    Ok(())
}

#[cfg(unix)]
fn symlink_raw(target: &str, link: &Path) -> Result<(), RpcError> {
    std::os::unix::fs::symlink(target, link)?;
    Ok(())
}
#[cfg(not(unix))]
fn symlink_raw(_target: &str, _link: &Path) -> Result<(), RpcError> {
    Err(RpcError::Internal("symlinks unsupported on this platform".into()))
}

/// The kind+value identity of an entry, for change/conflict detection. Two
/// entries are "the same" iff this matches.
fn entry_identity(e: &ManifestEntry) -> (EntryKind, Option<&str>, Option<&str>, u32) {
    (e.kind, e.sha256.as_deref(), e.target.as_deref(), e.mode)
}

fn entries_equal(a: &ManifestEntry, b: &ManifestEntry) -> bool {
    entry_identity(a) == entry_identity(b)
}

/// Set of paths that differ between `base` and `other` (added/modified/
/// removed). A path is "changed" if it's present in exactly one, or present
/// in both with a different identity.
fn changed_paths(base: &Manifest, other: &Manifest) -> std::collections::BTreeSet<String> {
    let mut set = std::collections::BTreeSet::new();
    for (p, e) in &other.entries {
        match base.entries.get(p) {
            Some(be) if entries_equal(be, e) => {}
            _ => {
                set.insert(p.clone());
            }
        }
    }
    for p in base.entries.keys() {
        if !other.entries.contains_key(p) {
            set.insert(p.clone());
        }
    }
    set
}

/// True if path `a` is an ancestor of, equal to, or descendant of path `b`
/// (i.e. they're on the same root-to-leaf line). Used for tree/kind
/// conflict detection: a delete of `/dir` conflicts with an incoming
/// modify of `/dir/a` even though the exact paths differ.
fn paths_overlap(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let a_pre = format!("{a}/");
    let b_pre = format!("{b}/");
    b.starts_with(&a_pre) || a.starts_with(&b_pre)
}

/// Result of a 3-way merge for commit: the merged manifest plus the set of
/// conflicting paths (where the local working change collided with an
/// incoming change to the same — or an overlapping tree — path).
#[derive(Debug)]
pub struct MergeResult {
    pub merged: Manifest,
    pub conflict_paths: Vec<String>,
}

/// Three-way merge for `scan_commit`: base = what the live dir was
/// materialized from, working = the freshly-scanned live dir, latest = the
/// current space head (may have advanced via other writers).
///
/// Semantics (per the plan, "per-file isolation"):
///   - Start from `latest` (so we never lose another writer's committed
///     work).
///   - Apply every local change (working vs base) onto it.
///   - A path is a CONFLICT iff it was changed locally AND changed in
///     (latest vs base) AND the two resulting values differ. For conflicts
///     we keep the `latest` value (don't clobber the other writer) and
///     report the path so the caller can feed the head version back to the
///     agent. Non-conflicting local changes are applied normally.
///   - Tree/kind conflicts: if a local change to path P overlaps (ancestor/
///     descendant) an incoming change to a different path Q, both are
///     conflicts; the latest side's subtree wins.
///
/// Always returns a committable manifest (never "refuse to commit") so a
/// single contested file never freezes the whole space.
pub fn three_way_merge(
    base: &Manifest,
    working: &Manifest,
    latest: &Manifest,
) -> MergeResult {
    let local_changes = changed_paths(base, working);
    let incoming_changes = changed_paths(base, latest);

    let mut merged = latest.clone();
    let mut conflicts = std::collections::BTreeSet::new();

    for p in &local_changes {
        // Does this local change overlap any incoming change?
        let direct_incoming = incoming_changes.contains(p);
        let tree_incoming = incoming_changes.iter().any(|q| q != p && paths_overlap(p, q));

        let local_entry = working.entries.get(p);
        let latest_entry = latest.entries.get(p);

        let collides = if direct_incoming {
            // Both touched the exact path; conflict unless they happen to
            // have produced the identical result.
            match (local_entry, latest_entry) {
                (Some(le), Some(re)) => !entries_equal(le, re),
                (None, None) => false, // both deleted → agree
                _ => true,             // one deleted, one modified
            }
        } else {
            tree_incoming
        };

        if collides {
            // Keep latest's value (already in `merged`); report conflict.
            conflicts.insert(p.clone());
        } else {
            // Apply the local change onto merged.
            match local_entry {
                Some(e) => {
                    merged.entries.insert(p.clone(), e.clone());
                }
                None => {
                    merged.entries.remove(p);
                }
            }
        }
    }

    MergeResult {
        merged,
        conflict_paths: conflicts.into_iter().collect(),
    }
}

/// A preserved local file from a conflict: its original VFS path and the
/// sidecar path its pre-conflict bytes were written to.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictSidecar {
    pub original: String,
    pub sidecar: String,
    /// What the sidecar leaf holds: "file" = the preserved bytes verbatim
    /// (agent reads them directly); "symlink" = a small JSON metadata regular
    /// file `{"kind":"symlink","target":"…"}` (the agent reads the JSON to
    /// recover the link target — a raw symlink sidecar would be unreadable via
    /// the O_NOFOLLOW fs tools, round-10 #3).
    pub kind: String,
}

/// Result of `dir_sync`: how the live dir was reconciled toward a new head.
#[derive(Debug)]
pub struct DirSyncResult {
    /// Paths whose incoming (head) version was applied into the live dir
    /// without conflict (no local edit).
    pub applied: Vec<String>,
    /// Incoming paths where a local uncommitted change collided. HEAD WINS:
    /// head's version is applied to the live path; every locally-dirty FILE in
    /// the affected subtree is first preserved at a sidecar (see
    /// `conflict_sidecars`). Reported so the caller can tell the agent.
    pub deferred_conflicts: Vec<String>,
    /// The actual sidecars written (original path → sidecar path). Empty for a
    /// conflict whose dirty subtree had no files (e.g. a purely-empty-dir edit).
    /// Lets the caller list ONLY real sidecars to the agent. Populated even when
    /// the sync stops early (see `incomplete`) so already-preserved copies are
    /// never orphaned (round-9 #2).
    pub conflict_sidecars: Vec<ConflictSidecar>,
    /// `None` = the sync fully applied every incoming path. `Some(msg)` = it
    /// STOPPED EARLY on a per-path failure (a sidecar write or a head apply/
    /// delete error). On early stop the partial `conflict_sidecars` ARE valid
    /// (their bytes are on disk) and MUST be surfaced, but the live dir is only
    /// partially synced, so the caller MUST NOT advance base — leaving head!=base
    /// lets the next turn re-run the sync and self-heal (round-8 fail-closed +
    /// round-9 #2: don't lose the sidecars written before the failure).
    pub incomplete: Option<String>,
    /// The manifest the live dir's base should advance to (= `to`), stored in
    /// CAS. The caller advances file_mounts.base_snapshot_id to this ONLY when
    /// `incomplete` is None — since head won every conflict, working == head for
    /// all incoming paths, so a later commit sees no spurious conflict and the
    /// agent's reconciled re-edit commits cleanly. Empty string when incomplete.
    pub new_base_manifest_sha256: String,
}

/// Every locally-dirty preservable entry whose path is within the conflict
/// path's subtree (the path itself, a descendant, or — for the tree case — a
/// path the conflict path descends into). Used to sidecar-preserve local work
/// before head-wins overwrites/removes the live path.
///
/// FILES (bytes from CAS) and SYMLINKS (a target string) are preservable and
/// returned. Empty DIRECTORIES are NOT returned: a dir carries no recoverable
/// content of its own (any dirty file/symlink under it is returned in its own
/// right), so an agent-created empty dir that head replaces is the one case
/// where nothing is sidecar'd — the conflict path is still reported as deferred
/// so the agent re-reads the live path. (round-8 #3)
fn dirty_preservable_in_subtree<'a>(
    working: &'a Manifest,
    local_dirty: &std::collections::BTreeSet<String>,
    conflict_path: &str,
) -> Vec<(&'a String, &'a ManifestEntry)> {
    let mut out = Vec::new();
    for q in local_dirty {
        if !paths_overlap(conflict_path, q) {
            continue;
        }
        if let Some((k, v)) = working.entries.get_key_value(q) {
            if matches!(v.kind, EntryKind::File | EntryKind::Symlink) {
                out.push((k, v));
            }
        }
    }
    out
}

/// Three-way directory sync (refresh): merge the changes between `from`
/// (the dir's current base) and `to` (the new head) INTO the live `dir`.
///   - For each incoming change P (to vs from):
///       * if P is NOT locally dirty → apply head's version (applied).
///       * if P IS locally dirty AND the local value differs from head →
///         CONFLICT: preserve the agent's local file at the conflict sidecar,
///         then apply head's version to the live path (head wins), record
///         deferred_conflict.
///       * tree/kind overlap with a local dirty path → conflict; head wins on
///         the incoming path, the non-overlapping local edit survives.
/// Returns which paths were applied + deferred, and the new base manifest
/// sha (always `to`'s manifest sha, stored in CAS).
pub fn dir_sync(
    cas: &BlobStore,
    dir: &Path,
    from: &Manifest,
    to: &Manifest,
) -> Result<DirSyncResult, RpcError> {
    // Scan the live working tree so we know which paths are locally dirty.
    let (working, _new) = scan_dir(cas, dir)?;
    let local_dirty = changed_paths(from, &working);
    let incoming = changed_paths(from, to);

    let mut applied = Vec::new();
    let mut deferred = Vec::new();
    let mut conflict_sidecars: Vec<ConflictSidecar> = Vec::new();
    // A dirty file can sit under MULTIPLE overlapping incoming conflict paths
    // (e.g. head replaces /dir with a file: incoming = {/dir, /dir/sub,
    // /dir/sub/x.txt} all overlap the agent's edit of /dir/sub/x.txt). Sidecar
    // each such file ONCE — both to avoid redundant copies and to keep
    // conflict_sidecars free of duplicate entries (the caller's notice + its
    // sidecar-coverage check depend on this being a true per-file set).
    let mut sidecar_done: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();

    // Per-path application, factored so a failure can STOP the loop while keeping
    // the sidecars already written (round-9 #2). Returns Err(msg) on the first
    // per-path failure; the caller sets `incomplete` and surfaces partial work.
    let mut incomplete: Option<String> = None;
    'outer: for p in &incoming {
        let locally_dirty_direct = local_dirty.contains(p);
        let locally_dirty_tree =
            local_dirty.iter().any(|q| q != p && paths_overlap(p, q));

        let to_entry = to.entries.get(p);
        let working_entry = working.entries.get(p);

        let collides = if locally_dirty_direct {
            match (working_entry, to_entry) {
                (Some(we), Some(te)) => !entries_equal(we, te),
                (None, None) => false,
                _ => true,
            }
        } else {
            locally_dirty_tree
        };

        if collides {
            deferred.push(p.clone());
            // HEAD WINS in the live tree (resolves the round-4 dead-end): apply
            // HEAD to the live path now (so working == head there, base can
            // advance, and the agent's reconciled re-edit commits cleanly), and
            // FIRST preserve every locally-dirty FILE/SYMLINK in the affected
            // subtree at a readable sidecar so nothing is lost — including the
            // tree/delete case (incoming deletes /dir while the agent edited
            // /dir/x.txt: applying head removes /dir, so /dir/x.txt must be
            // sidecar'd first).
            for (dirty_path, dirty_entry) in
                dirty_preservable_in_subtree(&working, &local_dirty, p)
            {
                if !sidecar_done.insert(dirty_path.clone()) {
                    // Already sidecar'd under an earlier overlapping conflict path.
                    continue;
                }
                // Collision-free sidecar storage: a FLAT leaf under
                // .synapse-conflicts named by hash(original + content) (round-9
                // #1 + round-10 #2). Flat = no file-vs-dir collision; the content
                // discriminator means two SEPARATE unconsumed conflicts on the
                // same original with different content don't overwrite each other.
                // The returned {original, sidecar, kind} carries the real path +
                // how to read the leaf for the agent.
                let disc = content_discriminator(dirty_entry);
                let sidecar_vfs = sidecar_path_for(dirty_path, &disc);
                // Ensure the single .synapse-conflicts dir exists (helper-owned
                // scratch, never scanned/committed); clobber a non-dir an agent
                // may have left at that one slot.
                if let Err(e) = ensure_conflicts_root_dir(dir) {
                    incomplete = Some(format!(
                        "preparing conflict scratch for {dirty_path}: {e}"
                    ));
                    break 'outer;
                }
                // The sidecar write MUST succeed before we let head overwrite or
                // delete the live path below — the head apply ALWAYS destroys the
                // local copy, so a swallowed sidecar failure would be guaranteed
                // data loss. On failure STOP (leave the live path intact): the
                // caller won't advance base and the next turn retries (round-8 #1).
                let kind = match write_sidecar(cas, dir, &sidecar_vfs, dirty_entry)
                {
                    Ok(k) => k,
                    Err(e) => {
                        incomplete = Some(format!(
                            "failed to preserve local copy of {dirty_path} at \
                             conflict sidecar {sidecar_vfs}: {e}"
                        ));
                        break 'outer;
                    }
                };
                // Sidecar bytes are on disk → record it so the caller surfaces it
                // EVEN IF a later path fails (round-9 #2: never orphan a sidecar).
                conflict_sidecars.push(ConflictSidecar {
                    original: dirty_path.clone(),
                    sidecar: sidecar_vfs,
                    kind,
                });
            }
            // Overwrite the live path with head's version (or remove it if head
            // deleted it). Any dirty subtree files were sidecar'd just above.
            if let Err(e) = apply_entry_to_dir(cas, dir, p, to_entry) {
                incomplete = Some(format!("applying head to {p}: {e}"));
                break 'outer;
            }
            continue;
        }

        // Apply head's version into the live dir.
        if let Err(e) = apply_entry_to_dir(cas, dir, p, to_entry) {
            incomplete = Some(format!("applying head to {p}: {e}"));
            break 'outer;
        }
        applied.push(p.clone());
    }

    if incomplete.is_some() {
        // Partial sync: surface the sidecars written so far, but signal the
        // caller NOT to advance base (no valid new_base). Self-heals next turn.
        return Ok(DirSyncResult {
            applied,
            deferred_conflicts: deferred,
            conflict_sidecars,
            incomplete,
            new_base_manifest_sha256: String::new(),
        });
    }

    let new_base = to.store(cas)?;
    Ok(DirSyncResult {
        applied,
        deferred_conflicts: deferred,
        conflict_sidecars,
        incomplete: None,
        new_base_manifest_sha256: new_base,
    })
}

/// Collision-free sidecar VFS path for a dirty original path (round-9 #1,
/// round-10 #2). A FLAT leaf under `.synapse-conflicts` named by the hex sha256
/// of the original VFS path COMBINED WITH a content discriminator. The original
/// hash keeps the leaf flat (no nesting → no file-vs-dir collision), and the
/// content discriminator means two SEPARATE unconsumed conflicts on the SAME
/// original with DIFFERENT preserved content land on DIFFERENT leaves — so a
/// later conflict can't silently overwrite an earlier, not-yet-consumed recovery
/// copy. Same original + same content = same leaf (idempotent re-preserve). The
/// human-readable original travels separately in `ConflictSidecar.original`.
fn sidecar_path_for(original_vfs: &str, content_disc: &str) -> String {
    let mut h = Sha256::new();
    h.update(original_vfs.as_bytes());
    h.update(b"\0");
    h.update(content_disc.as_bytes());
    let hex = hex::encode(h.finalize());
    format!("/{CONFLICTS_DIRNAME}/{hex}")
}

/// Content discriminator for a preservable entry: its content sha256 for a file,
/// or a hash of its target for a symlink. Distinguishes two unconsumed conflicts
/// on the same original path (round-10 #2).
fn content_discriminator(entry: &ManifestEntry) -> String {
    match entry.kind {
        EntryKind::File => entry.sha256.clone().unwrap_or_default(),
        EntryKind::Symlink => {
            let mut h = Sha256::new();
            h.update(b"symlink\0");
            h.update(entry.target.as_deref().unwrap_or("").as_bytes());
            hex::encode(h.finalize())
        }
        // Dirs are never sidecar'd (no recoverable content); defensive default.
        EntryKind::Dir => "dir".to_string(),
    }
}

/// Write a preserved local entry to its sidecar leaf and return the sidecar
/// "kind" string for the agent notice. A FILE is written verbatim (the agent
/// reads its bytes). A SYMLINK is written as a small JSON metadata REGULAR FILE
/// `{"kind":"symlink","target":"…"}` rather than a raw symlink, because the
/// agent's fs tools open with O_NOFOLLOW and `fs_stat` exposes no target — a raw
/// symlink sidecar would be unreadable, so "read it" would be a lie (round-10
/// #3). The JSON form is plain-readable via `fs_read`.
fn write_sidecar(
    cas: &BlobStore,
    dir: &Path,
    sidecar_vfs: &str,
    entry: &ManifestEntry,
) -> Result<String, RpcError> {
    match entry.kind {
        EntryKind::Symlink => {
            let target = entry.target.as_deref().unwrap_or("");
            // Minimal hand-rolled JSON (target may contain quotes/backslashes).
            let body = format!(
                "{{\"kind\":\"symlink\",\"target\":{}}}\n",
                json_string(target)
            );
            let host = vfs_to_host(dir, sidecar_vfs);
            if let Some(parent) = host.parent() {
                fs::create_dir_all(parent)?;
            }
            prepare_dest_for_kind(&host, EntryKind::File)?;
            fs::write(&host, body)?;
            set_mode(&host, 0o600)?;
            Ok("symlink".to_string())
        }
        EntryKind::File => {
            apply_entry_to_dir(cas, dir, sidecar_vfs, Some(entry))?;
            Ok("file".to_string())
        }
        EntryKind::Dir => {
            // Never reached (dirs aren't preservable), but keep total.
            apply_entry_to_dir(cas, dir, sidecar_vfs, Some(entry))?;
            Ok("dir".to_string())
        }
    }
}

/// Encode a string as a JSON string literal (quotes + the control/escape set).
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Ensure the single `.synapse-conflicts` scratch root exists AS A DIRECTORY,
/// clobbering a non-directory an agent may have left at that one slot. This
/// namespace is helper-owned, never scanned/committed; clobbering the ROOT slot
/// itself is safe (it holds no entry we created — our sidecars are its children,
/// and if the root is a non-dir there are none). Because sidecars are now flat
/// leaves (see `sidecar_path_for`), only this one directory ever needs to exist
/// — no nested parent chain to walk, so an existing sidecar can never be deleted
/// to make room for another (the round-9 #1 data-loss path).
///
/// Race-tolerant: benign races with the running sandbox (AlreadyExists on create,
/// NotFound on remove) must NOT fail the refresh; we only propagate if the slot
/// is still not a usable directory afterward.
fn ensure_conflicts_root_dir(dir: &Path) -> Result<(), RpcError> {
    let root = dir.join(CONFLICTS_DIRNAME);
    if let Ok(m) = root.symlink_metadata() {
        if !m.file_type().is_dir() {
            match fs::remove_file(&root) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(RpcError::Internal(format!(
                        "clearing non-dir at conflict scratch {}: {e}",
                        root.display()
                    )))
                }
            }
        }
    }
    match fs::create_dir_all(&root) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => {
            return Err(RpcError::Internal(format!(
                "creating conflict scratch dir {}: {e}",
                root.display()
            )))
        }
    }
    match root.symlink_metadata() {
        Ok(m) if m.file_type().is_dir() => Ok(()),
        Ok(_) => Err(RpcError::Internal(format!(
            "conflict scratch slot {} is not a directory after prepare",
            root.display()
        ))),
        Err(e) => Err(RpcError::Internal(format!(
            "stat conflict scratch dir {} after prepare: {e}",
            root.display()
        ))),
    }
}

/// Apply a single path's target entry into the live dir: materialize the
/// file/dir/symlink, or remove it (when `entry` is None = deleted in head).
fn apply_entry_to_dir(
    cas: &BlobStore,
    dir: &Path,
    vfs: &str,
    entry: Option<&ManifestEntry>,
) -> Result<(), RpcError> {
    let host = vfs_to_host(dir, vfs);
    match entry {
        None => {
            // Deleted in head. Remove whatever is there. "Already gone" is
            // success, but a REAL removal error (perms/IO) MUST propagate: if it
            // were swallowed, live != head while the caller advances base, and
            // the next commit would treat the residual live path as a fresh local
            // edit and RESURRECT content head had deleted (round-8 #2).
            //
            // NotFound = already gone. NotADirectory (ENOTDIR) = an ancestor is a
            // non-dir, and ELOOP (raw 40, a symlink loop in an ancestor) = the
            // path can't be resolved — in all of these the path definitionally
            // can't exist as a real entry, so it's also "gone". (ENOTDIR arises
            // legitimately when an earlier incoming change in the same sync
            // replaced an ancestor dir with a file, then a deeper descendant
            // delete is processed.) ELOOP's ErrorKind (FilesystemLoop) is still
            // unstable on this toolchain, so match the raw errno.
            const ELOOP: i32 = 40;
            let already_gone = |e: &std::io::Error| {
                matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) || e.raw_os_error() == Some(ELOOP)
            };
            match host.symlink_metadata() {
                Err(e) if already_gone(&e) => {}
                Err(e) => {
                    return Err(RpcError::Internal(format!(
                        "stat for delete {vfs}: {e}"
                    )))
                }
                Ok(meta) => {
                    let res = if meta.file_type().is_dir() {
                        fs::remove_dir_all(&host)
                    } else {
                        fs::remove_file(&host)
                    };
                    match res {
                        Ok(()) => {}
                        Err(e) if already_gone(&e) => {}
                        Err(e) => {
                            return Err(RpcError::Internal(format!(
                                "remove {vfs}: {e}"
                            )))
                        }
                    }
                }
            }
        }
        Some(e) => match e.kind {
            EntryKind::Dir => {
                prepare_dest_for_kind(&host, EntryKind::Dir)?;
                fs::create_dir_all(&host)?;
                set_mode(&host, e.mode | 0o700)?;
            }
            EntryKind::File => {
                if let Some(parent) = host.parent() {
                    fs::create_dir_all(parent)?;
                }
                prepare_dest_for_kind(&host, EntryKind::File)?;
                let sha = e.sha256.as_deref().ok_or_else(|| {
                    RpcError::Internal(format!("file entry without sha: {vfs}"))
                })?;
                cas.copy_to(sha, &host, e.mode | 0o600)?;
            }
            EntryKind::Symlink => {
                if let Some(parent) = host.parent() {
                    fs::create_dir_all(parent)?;
                }
                prepare_dest_for_kind(&host, EntryKind::Symlink)?;
                let target = e.target.as_deref().ok_or_else(|| {
                    RpcError::Internal(format!("symlink without target: {vfs}"))
                })?;
                symlink_raw(target, &host)?;
            }
        },
    }
    Ok(())
}

/// Collect every blob sha256 referenced by a manifest (file contents). The
/// manifest blob itself is NOT included (caller adds it). Used by GC to
/// expand a snapshot root into its reachable content set (Step 11).
#[allow(dead_code)] // wired up by the GC job in Step 11
pub fn referenced_shas(manifest: &Manifest) -> Vec<String> {
    manifest
        .entries
        .values()
        .filter_map(|e| e.sha256.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_is_byte_stable_across_insertion_order() {
        let mut a = Manifest::new();
        a.entries.insert(
            "/b.txt".into(),
            ManifestEntry {
                path: "/b.txt".into(),
                kind: EntryKind::File,
                sha256: Some("bb".into()),
                mode: 0o644,
                size: Some(2),
                target: None,
            },
        );
        a.entries.insert(
            "/a.txt".into(),
            ManifestEntry {
                path: "/a.txt".into(),
                kind: EntryKind::File,
                sha256: Some("aa".into()),
                mode: 0o644,
                size: Some(1),
                target: None,
            },
        );
        let mut b = Manifest::new();
        b.entries.insert(
            "/a.txt".into(),
            ManifestEntry {
                path: "/a.txt".into(),
                kind: EntryKind::File,
                sha256: Some("aa".into()),
                mode: 0o644,
                size: Some(1),
                target: None,
            },
        );
        b.entries.insert(
            "/b.txt".into(),
            ManifestEntry {
                path: "/b.txt".into(),
                kind: EntryKind::File,
                sha256: Some("bb".into()),
                mode: 0o644,
                size: Some(2),
                target: None,
            },
        );
        assert_eq!(a.serialize(), b.serialize());
    }

    #[test]
    fn roundtrip_serialize_deserialize() {
        let mut m = Manifest::new();
        m.entries.insert(
            "/dir".into(),
            ManifestEntry {
                path: "/dir".into(),
                kind: EntryKind::Dir,
                sha256: None,
                mode: 0o755,
                size: None,
                target: None,
            },
        );
        m.entries.insert(
            "/link".into(),
            ManifestEntry {
                path: "/link".into(),
                kind: EntryKind::Symlink,
                sha256: None,
                mode: 0o777,
                size: None,
                target: Some("/dir/x\twith\ttabs".into()),
            },
        );
        m.entries.insert(
            "/f.txt".into(),
            ManifestEntry {
                path: "/f.txt".into(),
                kind: EntryKind::File,
                sha256: Some("deadbeef".into()),
                mode: 0o644,
                size: Some(42),
                target: None,
            },
        );
        let bytes = m.serialize();
        let back = Manifest::deserialize(&bytes).unwrap();
        assert_eq!(back.serialize(), bytes);
        assert_eq!(back.entries.len(), 3);
        assert_eq!(
            back.entries["/link"].target.as_deref(),
            Some("/dir/x\twith\ttabs")
        );
    }

    #[test]
    fn three_way_disjoint_paths_both_apply() {
        let base = Manifest::new();
        let mut working = Manifest::new();
        working.entries.insert(
            "/local.txt".into(),
            ManifestEntry {
                path: "/local.txt".into(),
                kind: EntryKind::File,
                sha256: Some("l".into()),
                mode: 0o644,
                size: Some(1),
                target: None,
            },
        );
        let mut latest = Manifest::new();
        latest.entries.insert(
            "/remote.txt".into(),
            ManifestEntry {
                path: "/remote.txt".into(),
                kind: EntryKind::File,
                sha256: Some("r".into()),
                mode: 0o644,
                size: Some(1),
                target: None,
            },
        );
        let res = three_way_merge(&base, &working, &latest);
        assert!(res.conflict_paths.is_empty());
        assert!(res.merged.entries.contains_key("/local.txt"));
        assert!(res.merged.entries.contains_key("/remote.txt"));
    }

    #[test]
    fn three_way_same_path_conflict_keeps_latest() {
        let base = Manifest::new();
        let mut working = Manifest::new();
        working.entries.insert(
            "/shared.txt".into(),
            ManifestEntry {
                path: "/shared.txt".into(),
                kind: EntryKind::File,
                sha256: Some("local".into()),
                mode: 0o644,
                size: Some(1),
                target: None,
            },
        );
        let mut latest = Manifest::new();
        latest.entries.insert(
            "/shared.txt".into(),
            ManifestEntry {
                path: "/shared.txt".into(),
                kind: EntryKind::File,
                sha256: Some("remote".into()),
                mode: 0o644,
                size: Some(1),
                target: None,
            },
        );
        let res = three_way_merge(&base, &working, &latest);
        assert_eq!(res.conflict_paths, vec!["/shared.txt".to_string()]);
        assert_eq!(
            res.merged.entries["/shared.txt"].sha256.as_deref(),
            Some("remote")
        );
    }

    #[test]
    fn three_way_tree_conflict_local_delete_dir_vs_incoming_add_child() {
        // base: /dir + /dir/a ; working deletes the whole dir ; latest adds
        // /dir/b. Local delete overlaps incoming add → conflict.
        let mut base = Manifest::new();
        for p in ["/dir", "/dir/a"] {
            base.entries.insert(
                p.into(),
                ManifestEntry {
                    path: p.into(),
                    kind: if p == "/dir" { EntryKind::Dir } else { EntryKind::File },
                    sha256: if p == "/dir" { None } else { Some("a".into()) },
                    mode: 0o644,
                    size: if p == "/dir" { None } else { Some(1) },
                    target: None,
                },
            );
        }
        let working = Manifest::new(); // deleted everything
        let mut latest = base.clone();
        latest.entries.insert(
            "/dir/b".into(),
            ManifestEntry {
                path: "/dir/b".into(),
                kind: EntryKind::File,
                sha256: Some("b".into()),
                mode: 0o644,
                size: Some(1),
                target: None,
            },
        );
        let res = three_way_merge(&base, &working, &latest);
        // Local delete of /dir overlaps the incoming /dir/b add → conflict,
        // so latest's tree (incl /dir and /dir/b) is preserved. The local
        // delete of /dir/a has no incoming overlap on that exact path, so
        // it applies (per-file isolation): /dir/a is removed.
        assert!(!res.conflict_paths.is_empty());
        assert!(res.merged.entries.contains_key("/dir/b"));
        assert!(res.merged.entries.contains_key("/dir"));
        assert!(!res.merged.entries.contains_key("/dir/a"));
    }

    #[test]
    fn apply_entry_delete_missing_is_ok_but_real_error_propagates() {
        // round-8 #2: deleting an already-absent path is success (idempotent),
        // but a genuine removal failure must propagate (not be swallowed) —
        // otherwise live != head while the caller advances base, resurrecting
        // head-deleted content on the next commit.
        let tmp = tempfile::tempdir().unwrap();
        let cas = BlobStore::open(&tmp.path().join("cas")).unwrap();
        let dir = tmp.path().join("live");
        std::fs::create_dir_all(&dir).unwrap();

        // (a) deleting a non-existent path → Ok.
        assert!(apply_entry_to_dir(&cas, &dir, "/ghost.txt", None).is_ok());

        // (b) a real removal error propagates. Make a file inside a read-only
        // parent dir so unlink fails with EACCES/EPERM.
        use std::os::unix::fs::PermissionsExt;
        let sub = dir.join("ro");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("victim.txt"), "x").unwrap();
        let mut perm = std::fs::metadata(&sub).unwrap().permissions();
        perm.set_mode(0o555); // r-x: cannot unlink children
        std::fs::set_permissions(&sub, perm).unwrap();

        let res = apply_entry_to_dir(&cas, &dir, "/ro/victim.txt", None);

        // Restore perms so tempdir cleanup works regardless of assertion.
        let mut perm2 = std::fs::metadata(&sub).unwrap().permissions();
        perm2.set_mode(0o755);
        std::fs::set_permissions(&sub, perm2).unwrap();

        // root (uid 0) bypasses DAC perms, so the unlink may actually succeed in
        // a root test sandbox. Only assert the propagation contract when the
        // removal genuinely failed (non-root); never accept a SILENT swallow.
        if res.is_ok() {
            assert!(
                !sub.join("victim.txt").exists(),
                "delete reported Ok but the file is still there (swallowed error)"
            );
        }
        // If it failed, that's the propagation we want — nothing more to assert.
    }
}
