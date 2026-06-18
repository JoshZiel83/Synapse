#!/usr/bin/env node
// guard-content-store — enforces the SINGLE content-byte implementation
// (content storage plan §6.5#1/§6.5#5). After the cut-over, ALL blob byte IO
// goes through `infrastructure/storage/content-store.ts` (LocalCasStore +
// registry) and the remote stores under `infrastructure/storage/remote/`. This
// guard fails CI if a parallel/legacy byte path is reintroduced:
//
//   R1. The deleted byte free-functions (putBufferCas/readCasBlob/casBlobPath/…)
//       and the merged-away row-writers (upsertContentBlob/upsertAvatarContentBlob)
//       and the legacy non-CAS helpers (saveBuffer/downloadAndSave/readAs*) must
//       not be reintroduced as code anywhere (doc-comments are allowed).
//   R2. No file may open a second raw-fs byte path against the CAS dir: importing
//       node:fs AND referencing CONTENT_STORE_DIR is allowed ONLY in the
//       canonical store file (content-store.ts) and the dir definer (index.ts).
//
// Convention-only invariants this does NOT (yet) enforce are noted in the plan.

import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(here, "../src")

// Banned identifiers (deleted byte fns + merged-away row writers + legacy path).
const BANNED = [
  "putBufferCas",
  "readCasBlob",
  "readCasBlobBase64",
  "casBlobExists",
  "casBlobPath",
  "saveBuffer",
  "downloadAndSave",
  "resolveLocalStoragePath",
  "readAsBuffer",
  "readAsBase64",
  "upsertContentBlob",
  "upsertAvatarContentBlob",
]
const BANNED_RE = new RegExp(`\\b(${BANNED.join("|")})\\b`)

// Files allowed to MENTION the banned names (only in doc-comments) and to hold
// the canonical CAS byte path.
const STORE_FILE = "infrastructure/storage/content-store.ts"
const STORE_REPO = "infrastructure/storage/repo.ts"
const DIR_DEFINER = "infrastructure/storage/index.ts"
const FS_CAS_ALLOWLIST = new Set([STORE_FILE, DIR_DEFINER])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith(".ts")) out.push(full)
  }
  return out
}

function isCommentLine(line) {
  const t = line.trimStart()
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
}

const violations = []
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).split("\\").join("/")
  const text = readFileSync(file, "utf8")
  const lines = text.split("\n")

  // R1: banned identifiers in non-comment code (allowlisted files may mention
  // them anywhere — they only carry historical doc-comments).
  if (rel !== STORE_FILE && rel !== STORE_REPO) {
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return
      // strip trailing line-comment before matching
      const code = line.replace(/\/\/.*$/, "")
      const m = code.match(BANNED_RE)
      if (m) {
        violations.push(
          `${rel}:${i + 1}  reintroduces deleted symbol "${m[1]}" — route through content-store.ts (plan §6.5)`
        )
      }
    })
  }

  // R2: a second raw-fs CAS byte path (fs import + CONTENT_STORE_DIR) outside the
  // canonical store/definer. Tests are exempt — they legitimately seed blobs into
  // the CAS dir to simulate the Rust helper / set up fixtures.
  if (!FS_CAS_ALLOWLIST.has(rel) && !rel.endsWith(".test.ts")) {
    const importsFs =
      /from\s+["']node:fs(\/promises)?["']/.test(text) ||
      /from\s+["']fs(\/promises)?["']/.test(text)
    const usesCasDir = /\bCONTENT_STORE_DIR\b/.test(text)
    if (importsFs && usesCasDir) {
      violations.push(
        `${rel}  opens a raw-fs byte path against CONTENT_STORE_DIR — only LocalCasStore (content-store.ts) may (plan §6.5#1)`
      )
    }
  }
}

if (violations.length > 0) {
  console.error(
    `guard-content-store: ${violations.length} violation(s) — a parallel/legacy file-service byte path was reintroduced:`
  )
  for (const v of violations) console.error(`  ✗ ${v}`)
  process.exit(1)
}
console.log(
  "✓ guard-content-store: single content-byte implementation intact (no legacy/parallel byte path)."
)
