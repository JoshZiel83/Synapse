#!/usr/bin/env node
// guard-workspace-versions — the release-cohort version-cohesion gate.
//
// The publishable @synapse packages form a COORDINATED-REDEPLOY cohort:
// device-protocol, shared, device-runtime, device-sdk, api, and
// remote-agent-daemon — plus the repo root. Their wire / DTO / export
// contracts are versioned together, so a release MUST bump them in lockstep
// and pin every intra-cohort dependency to that one exact version. A `*` or a
// stale pin lets a mismatched pair resolve at install/deploy time and silently
// reintroduces the very cross-version skew a SemVer minor is meant to force a
// coordinated redeploy for (F-r3-1: the `turn_epoch` wire field lands in
// `z.strictObject` schemas — an un-upgraded peer strict-rejects the frame).
//
// Enforced over the cohort manifests AND the root lockfile:
//   1. COHESION      — all cohort manifests declare the same version.
//   2. INTRA-COHORT  — every cohort→cohort dependency pins that exact version
//                      (no `*`, no range).
//   3. BUNDLES       — the six platform bundle optionalDependencies stay
//                      DECOUPLED, pinned to each bundle package's own
//                      (independent) version. They ship via a separate script,
//                      exist on the registry at their own version, and are NOT
//                      part of the cohort — bumping their pin to the cohort
//                      version would 404 and strip every sidecar.
//   4. LOCK SYNC     — the root package-lock records each cohort manifest's
//                      version and intra-cohort pins verbatim. This is the
//                      `npm ci`-in-sync precheck, and it also catches a stale
//                      lock workspace node that would re-resolve a cohort pin
//                      from the registry instead of the local workspace.
//
// Excluded by design: web-next / web-next-design (`file:` refs) and mobile-app
// (no @synapse deps) — they consume the cohort as workspace links, never
// publish, and are free to reference it however they like.

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// The cohort workspaces: lockKey is the key under package-lock `packages{}`
// ("" is the repo root); dir is the manifest location relative to ROOT.
const COHORT = [
  { lockKey: "", dir: "." },
  { lockKey: "packages/device-protocol", dir: "packages/device-protocol" },
  { lockKey: "packages/shared", dir: "packages/shared" },
  { lockKey: "packages/device-runtime", dir: "packages/device-runtime" },
  { lockKey: "packages/device-sdk", dir: "packages/device-sdk" },
  { lockKey: "packages/api", dir: "packages/api" },
  {
    lockKey: "packages/remote-agent-daemon",
    dir: "packages/remote-agent-daemon",
  },
]

// The six platform bundles — decoupled, pinned to their own version.
const BUNDLE_DIRS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
].map((arch) => `packages/device-runtime-bundles-${arch}`)

const DEP_BAGS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]

const errors = []
const err = (m) => errors.push(m)

function readJSON(relPath) {
  return JSON.parse(readFileSync(join(ROOT, relPath), "utf8"))
}

// ── load cohort + bundle manifests ──────────────────────────────────────────
const manifests = COHORT.map((c) => ({
  ...c,
  pkg: readJSON(join(c.dir, "package.json")),
}))

// Names whose intra-cohort pins we enforce (the @synapse cohort packages; the
// root's bare "synapse" name is nothing depends on, so it drops out naturally).
const COHORT_NAMES = new Set(
  manifests.map((m) => m.pkg.name).filter((n) => n && n.startsWith("@synapse/"))
)

// Bundle name → its own declared version.
const bundleVersion = new Map()
for (const d of BUNDLE_DIRS) {
  const p = readJSON(join(d, "package.json"))
  bundleVersion.set(p.name, p.version)
}

// ── 1. cohesion ─────────────────────────────────────────────────────────────
const versions = new Set(manifests.map((m) => m.pkg.version))
if (versions.size !== 1) {
  err(
    `cohort versions diverge — a release bumps them in lockstep: ${manifests
      .map((m) => `${m.pkg.name || "(root)"}@${m.pkg.version}`)
      .join(", ")}`
  )
}
// The authoritative cohort version (root's); used for the pin checks even when
// cohesion already failed, so a divergence reports its downstream pin mismatches
// too rather than hiding them behind the first error.
const COHORT_VERSION = manifests.find((m) => m.lockKey === "").pkg.version

// ── 2 + 3. intra-cohort pins + decoupled bundle pins ────────────────────────
for (const m of manifests) {
  const label = m.pkg.name || "(root)"
  for (const bag of DEP_BAGS) {
    const deps = m.pkg[bag]
    if (!deps) continue
    for (const [name, spec] of Object.entries(deps)) {
      if (COHORT_NAMES.has(name)) {
        if (spec !== COHORT_VERSION) {
          err(
            `${label} ${bag}["${name}"] = "${spec}" — must pin the exact cohort ` +
              `version "${COHORT_VERSION}" (no "*", no range)`
          )
        }
      } else if (bundleVersion.has(name)) {
        if (bag !== "optionalDependencies") {
          err(
            `${label} ${bag}["${name}"] — platform bundles may only appear in ` +
              `optionalDependencies (they must never be a hard dependency)`
          )
        }
        const want = bundleVersion.get(name)
        if (spec !== want) {
          err(
            `${label} ${bag}["${name}"] = "${spec}" — must pin the bundle's own ` +
              `version "${want}"; bundles are DECOUPLED from the cohort and ` +
              `publish separately`
          )
        }
      }
    }
  }
}

// ── 4. lock sync (npm-ci in-sync precheck + stale-node ETARGET guard) ────────
if (existsSync(join(ROOT, "package-lock.json"))) {
  const lock = readJSON("package-lock.json")
  const rootVersion = COHORT_VERSION
  if (lock.version !== rootVersion) {
    err(
      `package-lock.json top-level version "${lock.version}" != root manifest ` +
        `"${rootVersion}"`
    )
  }
  for (const m of manifests) {
    const entry = lock.packages?.[m.lockKey]
    if (!entry) {
      err(`package-lock.json missing packages["${m.lockKey}"]`)
      continue
    }
    if (entry.version !== m.pkg.version) {
      err(
        `package-lock packages["${m.lockKey}"].version "${entry.version}" != ` +
          `manifest "${m.pkg.version}" (stale lock node — re-run the surgical ` +
          `version transform, do NOT regen from scratch)`
      )
    }
    for (const bag of DEP_BAGS) {
      const mdeps = m.pkg[bag] || {}
      const ldeps = entry[bag] || {}
      for (const [name, spec] of Object.entries(mdeps)) {
        if (name.startsWith("@synapse/") && ldeps[name] !== spec) {
          err(
            `package-lock packages["${m.lockKey}"].${bag}["${name}"] = ` +
              `"${ldeps[name]}" != manifest "${spec}"`
          )
        }
      }
    }
  }
} else {
  err("package-lock.json not found at repo root")
}

// ── report ───────────────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.error(`\n[guard-workspace-versions] ${errors.length} problem(s):`)
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.error("")
  process.exit(1)
}

console.error(
  `[guard-workspace-versions] OK: cohort @ ${COHORT_VERSION} ` +
    `(${COHORT_NAMES.size} pkgs + root), ${bundleVersion.size} bundles ` +
    `decoupled, lock in sync`
)
