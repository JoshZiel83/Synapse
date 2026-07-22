#!/usr/bin/env node
// apply-patches — the SINGLE implementation that applies dependency patches AND
// proves they stuck. It is used in four places with identical logic, because the
// defect this closes is per-image divergence (one call site drifting from
// another): the root `postinstall`, every Docker image that installs the root
// package-lock.json (an explicit build-time RUN), and scripts/verify-boundary.sh
// (the host gate). One file, one behaviour, everywhere.
//
// CLI: node scripts/apply-patches.mjs [--verify-only] [--require-all] [--root <dir>]
//   --verify-only  assert the patches are live on disk WITHOUT applying them. The
//                  host gate runs with this flag on purpose — a gate that repairs
//                  its own subject reports nothing (CI's `npm ci` already fires
//                  the postinstall, so an apply-then-assert host check is always
//                  green regardless of the tree's real state).
//   --require-all  a patch whose TARGET package is not installed in this tree is a
//                  FAILURE, not a skip. Use ONLY where the tree is a full install:
//                  the host gate (verify-boundary.sh). Every image installs a
//                  workspace SUBSET, so a patch for a package outside that subset
//                  is a legitimate skip there — images never pass --require-all.
//   --root <dir>   root the patches/ + node_modules/ live under (default: cwd). A
//                  bare positional argument is also accepted as the root.
//
// FORGOTTEN-COPY DETECTION: the only signal that an image forgot to `COPY patches/`
// is the patches/ DIRECTORY being absent — `patch-package --error-on-fail` exits 0
// when patches/ is missing (it early-returns on zero patch files before any error
// accounting), so --error-on-fail alone can never catch it. A tracked
// patches/README.md keeps git carrying the directory, so a landed `COPY patches/`
// always brings at least that file: dir-present ⇒ the COPY happened, dir-absent ⇒
// it did not. A present-but-patchless directory is therefore NOT a failure (it is
// what remains if every patch is ever legitimately dropped upstream) — only an
// ABSENT directory is.
//
// VERSION-AGNOSTIC BY CONSTRUCTION: nothing here names a patch filename, package
// name, version, or marker symbol. It globs patches/*.patch, derives the target
// package and the assertion markers from each patch body, so bumping or
// regenerating a patch needs zero changes to this script, the Dockerfiles, or the
// host gate.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { basename, resolve } from "node:path"

// Minimum length of an added line for it to serve as a content MARKER. Short
// added lines (`}`, `})`, `if (span != null) {`) recur all over a source file
// and cannot discriminate patched from unpatched — measured against the real
// target, so the threshold is empirical, not arbitrary.
const MIN_MARKER_LEN = 12

function parseArgs(argv) {
  const opts = { verifyOnly: false, requireAll: false, root: process.cwd() }
  let rootFromPositional = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--verify-only") opts.verifyOnly = true
    else if (a === "--require-all") opts.requireAll = true
    else if (a === "--root") {
      const v = argv[++i]
      if (v == null) fail("--root requires a directory argument")
      opts.root = v
    } else if (a.startsWith("--")) {
      fail(`unknown flag ${a}`)
    } else {
      rootFromPositional = a
    }
  }
  if (rootFromPositional != null) opts.root = rootFromPositional
  opts.root = resolve(opts.root)
  return opts
}

function fail(msg) {
  console.error(`apply-patches: FAIL — ${msg}`)
  process.exit(1)
}

/**
 * Parse one *.patch into { patchName, targets: [{ path, markers, deletion }] }.
 * A `+++ b/<path>` line opens a target; `+++ /dev/null` marks a deletion (no
 * on-disk assertion). Every added (`+`) line whose trimmed text is >= MIN_MARKER_LEN
 * becomes a marker for the currently open target. `+++`/`---`/`diff `/`index `/`@@`
 * header lines are never markers.
 */
function parsePatch(absPatch) {
  const patchName = basename(absPatch)
  const lines = readFileSync(absPatch, "utf8").split("\n")
  const targets = []
  let current = null
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      let p = line.slice(4).split("\t")[0].trim()
      const deletion = p === "/dev/null"
      if (p.startsWith("b/")) p = p.slice(2)
      current = { path: p, markers: [], deletion }
      targets.push(current)
      continue
    }
    if (
      line.startsWith("--- ") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("@@")
    ) {
      continue
    }
    if (line.startsWith("+") && current != null && !current.deletion) {
      const text = line.slice(1).trim()
      if (text.length >= MIN_MARKER_LEN) current.markers.push(text)
    }
  }
  if (targets.length === 0) {
    fail(`${patchName} parses zero target files (no \`+++ b/<path>\` headers)`)
  }
  const first = targets[0]
  if (!first.path.startsWith("node_modules/")) {
    fail(
      `${patchName} first target is ${first.path}, not under node_modules/ — patch-package patches only apply to node_modules`
    )
  }
  return { patchName, targets, pkg: packageOf(first.path) }
}

/** node_modules/@scope/name/... → @scope/name; node_modules/name/... → name. */
function packageOf(targetPath) {
  const rest = targetPath.slice("node_modules/".length)
  const parts = rest.split("/")
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]
}

function listPatchFiles(patchesDir) {
  return readdirSync(patchesDir)
    .filter((n) => n.endsWith(".patch"))
    .sort()
    .map((n) => resolve(patchesDir, n))
}

/**
 * Apply the applicable patches through patch-package. `applicable` are patches
 * whose target package is present in <root>/node_modules. Uses --patch-dir so a
 * SUBSET can be applied when the tree holds only some patched packages: patches
 * is passed bare when every patch is applicable, otherwise a freshly-created
 * relative subset dir holding just the applicable copies (patch-package rejects
 * an absolute --patch-dir; spiked). `patches` positional package NAMES are NOT
 * usable — they mean CREATE a patch and die on `spawnSync git ENOENT`.
 *
 * Both flags are load-bearing and both verified present in the installed
 * patch-package: --error-on-fail catches a patch that no longer applies,
 * --error-on-warn catches a dependency bump whose stale patch still applies
 * (warning-only by default).
 */
function applyPatches(root, allPatchAbs, applicable) {
  const bin = resolve(root, "node_modules", ".bin", "patch-package")
  if (!existsSync(bin)) {
    // Filtered-workspace images (web / mobile-web) do not install root
    // devDependencies, so patch-package is absent. Applying is impossible here;
    // the VERIFY pass below is the real gate — it FAILS if any applicable target
    // is present but unpatched, so a patched dep entering this tree breaks loudly
    // instead of silently shipping unpatched.
    console.log(
      `WARN patch-package is not installed under ${root} — cannot apply ${applicable
        .map((p) => p.pkg)
        .join(", ")}. Verification below decides.`
    )
    return
  }

  const everyApplicable = applicable.length === allPatchAbs.length
  let patchDir = "patches"
  let subsetAbs = null
  if (!everyApplicable) {
    subsetAbs = resolve(root, `.patch-subset-${process.pid}`)
    rmSync(subsetAbs, { recursive: true, force: true })
    mkdirSync(subsetAbs, { recursive: true })
    for (const p of applicable) {
      const src = allPatchAbs.find((a) => basename(a) === p.patchName)
      copyFileSync(src, resolve(subsetAbs, p.patchName))
    }
    patchDir = basename(subsetAbs) // RELATIVE to root
  }

  try {
    const res = spawnSync(
      process.execPath,
      [bin, "--patch-dir", patchDir, "--error-on-fail", "--error-on-warn"],
      { cwd: root, stdio: "inherit" }
    )
    if (res.status !== 0) {
      fail(
        `patch-package exited ${res.status ?? `(signal ${res.signal})`} applying ${applicable
          .map((p) => p.patchName)
          .join(", ")}`
      )
    }
  } finally {
    if (subsetAbs != null) rmSync(subsetAbs, { recursive: true, force: true })
  }
}

/**
 * Assert every applicable patch's markers are present on disk. Runs in BOTH
 * modes (after apply, or --verify-only). Returns { verified, skipped } counts and
 * pushes human-readable problems into `problems`.
 */
function verifyPatches(root, patches, requireAll, problems) {
  let verified = 0
  let skipped = 0
  for (const { patchName, pkg, targets } of patches) {
    if (!existsSync(resolve(root, "node_modules", pkg))) {
      if (requireAll) {
        problems.push(
          `${patchName} — target package ${pkg} is absent under --require-all (this tree must be a full install)`
        )
      } else {
        console.log(`skip ${patchName} — ${pkg} is not part of this tree`)
        skipped++
      }
      continue
    }
    for (const t of targets) {
      if (t.deletion) continue // /dev/null target: nothing to assert on disk
      const abs = resolve(root, t.path)
      if (!existsSync(abs)) {
        problems.push(`${patchName} → ${t.path} is missing from the tree`)
        continue
      }
      if (t.markers.length === 0) {
        problems.push(
          `${patchName} → ${t.path} yields no assertable marker (no added line >= ${MIN_MARKER_LEN} chars) — add a distinctive added line to the patch, or teach apply-patches.mjs a stronger check for this patch`
        )
        continue
      }
      const content = readFileSync(abs, "utf8")
      const missing = t.markers.filter((m) => !content.includes(m))
      if (missing.length > 0) {
        problems.push(
          `${patchName} → ${missing.length}/${t.markers.length} added lines ABSENT from ${t.path} — first missing: ${JSON.stringify(missing[0])}`
        )
        continue
      }
      console.log(`ok ${patchName} → ${t.path} (${t.markers.length} markers)`)
      verified++
    }
  }
  return { verified, skipped }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const patchesDir = resolve(opts.root, "patches")

  // FORGOTTEN-COPY gate: an ABSENT directory is the only failure. A present but
  // patchless directory (patches/README.md keeps git tracking it) is a no-op.
  if (!existsSync(patchesDir) || !statSync(patchesDir).isDirectory()) {
    fail(
      `no patches/ directory under ${opts.root} — an image likely forgot \`COPY patches/ patches/\` (patch-package --error-on-fail exits 0 in this state, so this is the only catcher)`
    )
  }

  const patchAbs = listPatchFiles(patchesDir)
  if (patchAbs.length === 0) {
    console.log(
      `apply-patches: OK — patches/ present with no *.patch files under ${opts.root} (nothing to apply)`
    )
    return
  }

  const patches = patchAbs.map(parsePatch)
  const applicable = patches.filter((p) =>
    existsSync(resolve(opts.root, "node_modules", p.pkg))
  )
  const absent = patches.filter((p) => !applicable.includes(p))

  // --require-all short-circuit for APPLY: an absent target is a hard failure
  // regardless of mode (verify catches it too, but fail before touching the tree).
  if (opts.requireAll && absent.length > 0) {
    fail(
      `--require-all but ${absent.map((p) => p.pkg).join(", ")} absent from ${opts.root}/node_modules`
    )
  }

  if (!opts.verifyOnly && applicable.length > 0) {
    applyPatches(opts.root, patchAbs, applicable)
  } else if (!opts.verifyOnly) {
    // Nothing installed that any patch targets — legitimate for a filtered image.
    for (const p of absent) {
      console.log(`skip ${p.patchName} — ${p.pkg} is not part of this tree`)
    }
  }

  const problems = []
  const { verified, skipped } = verifyPatches(
    opts.root,
    patches,
    opts.requireAll,
    problems
  )

  if (problems.length > 0) {
    console.error(`apply-patches: FAIL — ${problems.length} problem(s):`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }

  console.log(
    `apply-patches: OK — ${verified} patched file(s) verified, ${skipped} skipped, under ${opts.root}`
  )
}

main()
