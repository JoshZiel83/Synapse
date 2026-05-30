#!/usr/bin/env node
// prepublishOnly guard for the four publishable @synapse main packages
// (device-protocol, shared, device-runtime, remote-agent-daemon).
//
// npm runs `prepublishOnly` on every `npm publish` (NOT on `npm pack`),
// with cwd = the package directory. This is the last, un-bypassable
// gate before a tarball leaves the machine. It enforces three things;
// any failure exits non-zero and aborts the publish:
//
//   1. REGISTRY: the effective publish registry must be the private one,
//      never npmjs/yarnpkg. For a SCOPED package the destination is
//      governed by the scope-specific @synapse:registry mapping, which
//      OVERRIDES --registry / the generic registry (verified). So we
//      resolve the scope registry first (via `npm config get`), fall back
//      to the generic registry only for an unscoped package, normalize
//      with new URL(), reject npmjs, and check an allowlist. NOTE: this
//      lifecycle guard is best-effort defense-in-depth — the authoritative
//      enforcement is scripts/safe-publish.mjs / the sidecar wrapper,
//      which actively PIN the destination so a stray npmrc cannot redirect.
//   2. DIST: build output exists. All four need dist/index.js; only
//      @synapse/device-runtime additionally needs dist/bin.js (its bin).
//   3. CLEANLINESS: no *.test.* or *.map files leaked into dist/ (guards
//      against publishing with the wrong tsconfig).

import { execSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

// Usually invoked by npm as the package's `prepublishOnly` (cwd = the
// package dir). It can ALSO be invoked directly by safe-publish.mjs with
// the package dir as argv[2] — that path is un-bypassable by
// --ignore-scripts (the lifecycle hook is skippable; a direct parent-process
// run is not). When given a dir, chdir into it so all the cwd-relative
// checks below (package.json, dist/) target that package.
const targetDir = process.argv[2]
if (targetDir) {
  process.chdir(targetDir)
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const name = pkg.name

function fail(msg) {
  console.error(`\n[prepublish-guard] REFUSING to publish ${name}:\n  ${msg}\n`)
  process.exit(1)
}

// --- 1. registry ---------------------------------------------------------

// All npm-owned / public hosts a private package must never reach.
const NPMJS_HOSTS = new Set([
  "registry.npmjs.org",
  "registry.npmjs.com",
  "registry.yarnpkg.com",
])

function normalize(raw) {
  if (!raw) return null
  const trimmed = String(raw).trim()
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return null
  // An unresolved ${NPM_REGISTRY} (env not exported) is NOT a registry.
  if (trimmed.includes("${")) return null
  let u
  try {
    u = new URL(trimmed)
  } catch {
    return null
  }
  // Canonical form: protocol + host(+port), no trailing slash, lowercased
  // host so http://Localhost:4873/ === http://localhost:4873.
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`
}

function npmConfigGet(key) {
  try {
    return normalize(
      execSync(`npm config get ${key}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    )
  } catch {
    return null
  }
}

// The DESTINATION of a scoped publish is governed by the scope-specific
// registry (@synapse:registry), NOT the generic registry / --registry.
// (Verified: `npm publish --registry=PRIVATE` still ships to the scope
// registry if @synapse:registry is set.) So the scope registry is the
// authoritative signal; the generic one is only a secondary check.
const scope = name.startsWith("@") ? name.slice(0, name.indexOf("/")) : null
const scopeReg = scope ? npmConfigGet(`${scope}:registry`) : null
const genericReg =
  normalize(process.env.npm_config_registry) ?? npmConfigGet("registry")

// Authoritative target: for a scoped package the scope registry governs
// the publish destination (and overrides --registry); only when there is
// NO scope registry does the generic registry decide. npm's generic
// `registry` defaults to npmjs.org, so screening it for a scoped package
// would false-reject every normal config — we must NOT do that.
const effective = scopeReg ?? genericReg

// Allowlist: whatever NPM_REGISTRY points at, plus any explicit extras in
// SYNAPSE_NPM_REGISTRY_ALLOWLIST (comma/space separated). If NPM_REGISTRY
// is unset we don't have a positive target, so we only enforce the
// negative rule (never npmjs) — still enough to stop an accidental public
// publish.
const allowlist = new Set(
  [
    process.env.NPM_REGISTRY,
    ...(process.env.SYNAPSE_NPM_REGISTRY_ALLOWLIST || "").split(/[\s,]+/),
  ]
    .map(normalize)
    .filter(Boolean)
)

if (!effective) {
  fail(
    "could not resolve an effective registry (neither the @synapse scope " +
      "registry nor the generic registry is set). Publish via " +
      'scripts/safe-publish.mjs or pass --@synapse:registry="$NPM_REGISTRY".'
  )
}
// Reject if the AUTHORITATIVE target is public npm.
if (NPMJS_HOSTS.has(new URL(effective).host)) {
  fail(
    `the effective publish registry is public npm (${effective}). This ` +
      `package is private. Note: for scoped packages the @synapse:registry ` +
      `mapping governs the destination and overrides --registry — publish ` +
      `via scripts/safe-publish.mjs which pins --@synapse:registry.`
  )
}
if (allowlist.size > 0 && !allowlist.has(effective)) {
  fail(
    `effective registry ${effective} is not in the allowlist ` +
      `[${[...allowlist].join(", ")}]. Set NPM_REGISTRY / ` +
      `SYNAPSE_NPM_REGISTRY_ALLOWLIST or publish via scripts/safe-publish.mjs.`
  )
}

// --- 2. dist exists ------------------------------------------------------

const required = ["dist/index.js"]
if (name === "@synapse/device-runtime") required.push("dist/bin.js")
for (const f of required) {
  if (!existsSync(f)) {
    fail(`missing build output ${f}. Run the package build first.`)
  }
}

// --- 3. no test/map leakage in dist -------------------------------------

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else yield p
  }
}

const leaked = []
if (existsSync("dist")) {
  for (const f of walk("dist")) {
    if (/\.test\./.test(f) || f.endsWith(".map")) leaked.push(f)
  }
}
if (leaked.length > 0) {
  fail(
    `dist contains ${leaked.length} test/sourcemap artifact(s) that must not ` +
      `ship (e.g. ${leaked.slice(0, 3).join(", ")}). Build with ` +
      `tsconfig.build.json.`
  )
}

console.error(`[prepublish-guard] OK: ${name} → ${effective}`)
