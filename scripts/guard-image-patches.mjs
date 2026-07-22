#!/usr/bin/env node
// guard-image-patches — source-level ratchet that keeps the in-image patch
// assertion undeletable.
//
// scripts/verify-boundary.sh can only ever inspect the HOST tree, which CI
// `npm ci`s before running it — so the host gate is structurally green even when
// a shipped image is unpatched (exactly how an unpatched api image shipped while
// the gate reported clean). The real assertion therefore lives INSIDE each image
// as `RUN node scripts/apply-patches.mjs`, which fails the build. This guard is
// what keeps that RUN in every image that needs it: it is the check that would
// have caught the original defect in review.
//
// RULE: every Dockerfile that installs the ROOT package-lock.json must
//   (1) COPY patches/ into the build context above its install layer,
//   (2) COPY scripts/apply-patches.mjs likewise,
//   (3) RUN node scripts/apply-patches.mjs AFTER the install, and
//   (4) never delete scripts.postinstall in-image (the retired hack).
// A Dockerfile that installs a NON-root lockfile (e.g. a vendored sidecar tree)
// is exempt — the root patches do not apply to it.
//
// Usage: node scripts/guard-image-patches.mjs

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

// Walker skips. `.claude` / `.worktrees` / `.recovery` are REQUIRED: stale
// worktrees there carry copies of every Dockerfile (including ones that no longer
// exist at HEAD) and would flood the report with phantom findings.
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".claude",
  ".worktrees",
  ".recovery",
  "target",
  "dist",
  ".next",
  "coverage",
])

const isDockerfile = (name) =>
  /^Dockerfile(\..+)?$/.test(name) || name.endsWith(".Dockerfile")

/** Recursively list Dockerfile paths (absolute), skipping IGNORED_DIRS. */
function listDockerfiles(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (IGNORED_DIRS.has(name)) continue
    const full = resolve(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) out.push(...listDockerfiles(full))
    else if (isDockerfile(name)) out.push(full)
  }
  return out
}

// A COPY whose SOURCE token is a BARE `package-lock.json` (not
// `sidecars/.../package-lock.json`, not a `--from` build-stage path like
// `/build/package-lock.json`). The lookbehind rejects any package-lock.json
// preceded by a path separator or word char, so only the root lockfile matches.
const ROOT_LOCKFILE_COPY =
  /^\s*COPY\s+(?:--\S+\s+)*(?:\S+\s+)*(?<![\w./-])package-lock\.json(\s|$)/
const FIRST_NPM_INSTALL = /^\s*RUN\b.*\bnpm\s+(?:ci|install)\b/
const COPY_PATCHES = /^\s*COPY\s+(?:--\S+\s+)*patches\//
const COPY_APPLIER = /^\s*COPY\s+.*scripts\/apply-patches\.mjs/
const RUN_APPLIER = /^\s*RUN\b.*\bnode\s+scripts\/apply-patches\.mjs/
const POSTINSTALL_SURGERY = /delete\s+\w+\.scripts\.postinstall/

/** First 0-based line index matching `re`, or -1. */
function firstLine(lines, re) {
  return lines.findIndex((l) => re.test(l))
}

function checkDockerfile(absPath) {
  const rel = relative(repoRoot, absPath)
  const content = readFileSync(absPath, "utf8")
  const lines = content.split("\n")
  const problems = []

  if (POSTINSTALL_SURGERY.test(content)) {
    problems.push(
      "deletes scripts.postinstall in-image — retired; run scripts/apply-patches.mjs instead"
    )
  }

  const installsRootLockfile = lines.some((l) => ROOT_LOCKFILE_COPY.test(l))
  if (installsRootLockfile) {
    const patchesCopy = firstLine(lines, COPY_PATCHES)
    const applierCopy = firstLine(lines, COPY_APPLIER)
    const applierRun = firstLine(lines, RUN_APPLIER)
    const firstInstall = firstLine(lines, FIRST_NPM_INSTALL)

    if (patchesCopy === -1)
      problems.push("installs the root lockfile but never `COPY patches/`")
    if (applierCopy === -1)
      problems.push(
        "installs the root lockfile but never `COPY scripts/apply-patches.mjs`"
      )
    if (applierRun === -1)
      problems.push(
        "installs the root lockfile but never `RUN node scripts/apply-patches.mjs`"
      )
    if (firstInstall === -1) {
      problems.push(
        "COPYs the root lockfile but has no `RUN … npm ci|install` — cannot order the patch layers against it"
      )
    } else {
      if (patchesCopy !== -1 && patchesCopy > firstInstall)
        problems.push(
          `\`COPY patches/\` (line ${patchesCopy + 1}) must come BEFORE the first \`npm ci\` (line ${firstInstall + 1}) so the install layer's cache key tracks it`
        )
      if (applierRun !== -1 && applierRun < firstInstall)
        problems.push(
          `\`RUN node scripts/apply-patches.mjs\` (line ${applierRun + 1}) must come AFTER the first \`npm ci\` (line ${firstInstall + 1}) — nothing to patch before node_modules exists`
        )
    }
  }

  return { rel, installsRootLockfile, problems }
}

function main() {
  const dockerfiles = listDockerfiles(repoRoot)
  const results = dockerfiles.map(checkDockerfile)
  const failures = results.filter((r) => r.problems.length > 0)

  if (failures.length > 0) {
    const total = failures.reduce((n, r) => n + r.problems.length, 0)
    console.error(`✗ guard-image-patches: ${total} problem(s)\n`)
    let i = 0
    for (const r of failures) {
      for (const p of r.problems) {
        i++
        console.error(`  ${i}. [${r.rel}] ${p}`)
      }
    }
    console.error(
      "\nEvery image that installs the root package-lock.json must prove the patches\n" +
        "are live INSIDE the image; the host tree that CI npm-ci's can never speak for\n" +
        "an artifact. See scripts/apply-patches.mjs and infrastructure/Dockerfile.api."
    )
    process.exit(1)
  }

  console.log(
    `✓ guard-image-patches: OK (${dockerfiles.length} Dockerfile(s) scanned)`
  )
}

main()
