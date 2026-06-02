// Minimal TS reader for the byte-stable manifest format produced by the Rust
// fs-helper (sidecars/fs-helper/src/manifest.rs::serialize). The platform only
// needs to extract the set of content sha256s referenced by a manifest (for GC
// roots and content-access reachability); it never writes manifests, so this is
// a parser, not a full model.
//
// Format (one entry per line, tab-separated, LF-terminated):
//   line 0:           "synapse-manifest-v1"
//   entry line:       <tag>\t<mode-octal>\t<size|->\t<sha256|->\t<target-b64|->\t<path>
// where tag ∈ {f,d,l} (file/dir/symlink). Only file entries carry a sha256.

const MANIFEST_HEADER = "synapse-manifest-v1"

/**
 * Parse a manifest blob's bytes and return the set of file-content sha256s it
 * references. Throws on a malformed header so callers can distinguish "not a
 * manifest" from "manifest with no files".
 */
export function parseManifestShas(bytes: Buffer | Uint8Array): Set<string> {
  const text = Buffer.from(bytes).toString("utf8")
  const lines = text.split("\n")
  if (lines.length === 0 || lines[0] !== MANIFEST_HEADER) {
    throw new Error(`manifest bad header: ${lines[0]?.slice(0, 32)}`)
  }
  const shas = new Set<string>()
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    // splitN(6) in Rust → at most 6 fields, path (with possible tabs) last.
    const parts = line.split("\t")
    if (parts.length < 6) continue
    const sha = parts[3]
    if (sha && sha !== "-") shas.add(sha)
  }
  return shas
}
