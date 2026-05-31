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

use crate::blobs::BlobStore;
use crate::rpc::RpcError;

/// The VFS-internal namespace; never materialized or scanned. Mirrors
/// path.rs INTERNAL_NAMESPACE (the device-runtime VFS creates this dir
/// inside the root for atomic-write staging; it must not leak into a
/// snapshot).
const INTERNAL_DIRNAME: &str = ".synapse-internal";

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
        if is_internal(&rel) {
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

/// Result of `dir_sync`: how the live dir was reconciled toward a new head.
#[derive(Debug)]
pub struct DirSyncResult {
    /// Paths whose incoming (head) version was applied into the live dir.
    pub applied: Vec<String>,
    /// Paths where a local uncommitted change collided with an incoming
    /// change; left untouched locally, reported for the agent.
    pub deferred_conflicts: Vec<String>,
    /// The manifest the live dir's base should advance to (= `to`), so the
    /// caller can update file_mounts.base_snapshot_id (prevents the next
    /// commit from treating the just-synced incoming as a local change).
    pub new_base_manifest_sha256: String,
}

/// Three-way directory sync (refresh): merge the changes between `from`
/// (the dir's current base) and `to` (the new head) INTO the live `dir`,
/// preserving local uncommitted edits.
///   - For each incoming change P (to vs from):
///       * if P is NOT locally dirty (working == from at P) → apply head's
///         version into the live dir (applied).
///       * if P IS locally dirty AND the local value differs from head →
///         leave local untouched, record deferred_conflict.
///       * tree/kind overlap with a local dirty path → deferred_conflict.
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

    for p in &incoming {
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
            continue;
        }

        // Apply head's version into the live dir.
        apply_entry_to_dir(cas, dir, p, to_entry)?;
        applied.push(p.clone());
    }

    let new_base = to.store(cas)?;
    Ok(DirSyncResult {
        applied,
        deferred_conflicts: deferred,
        new_base_manifest_sha256: new_base,
    })
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
            // Deleted in head. Remove whatever is there.
            if let Ok(meta) = host.symlink_metadata() {
                if meta.file_type().is_dir() {
                    let _ = fs::remove_dir_all(&host);
                } else {
                    let _ = fs::remove_file(&host);
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
}
