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
//      never npmjs/yarnpkg. We can't rely solely on npm_config_registry
//      — it's undefined in the lifecycle when the publish relies only on
//      the @synapse:registry scope mapping (verified empirically). So we
//      resolve an "effective registry" (env-injected npm_config_registry
//      first, then the scope mapping via `npm config get`), normalize
//      with new URL(), and compare against an allowlist.
//   2. DIST: build output exists. All four need dist/index.js; only
//      @synapse/device-runtime additionally needs dist/bin.js (its bin).
//   3. CLEANLINESS: no *.test.* or *.map files leaked into dist/ (guards
//      against publishing with the wrong tsconfig).

import { execSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const name = pkg.name

function fail(msg) {
  console.error(`\n[prepublish-guard] REFUSING to publish ${name}:\n  ${msg}\n`)
  process.exit(1)
}

// --- 1. registry ---------------------------------------------------------

const NPMJS_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com"])

function normalize(raw) {
  if (!raw) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null
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

function effectiveRegistry() {
  // Env-injected (present only when publish was run with --registry=...
  // or a default registry= config).
  const fromEnv = normalize(process.env.npm_config_registry)
  if (fromEnv) return fromEnv
  // Fall back to the @synapse:registry scope mapping (the .npmrc route).
  try {
    const out = execSync("npm config get @synapse:registry", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return normalize(out)
  } catch {
    return null
  }
}

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

const effective = effectiveRegistry()
if (!effective) {
  fail(
    "could not resolve an effective registry (npm_config_registry unset and " +
      '@synapse:registry unresolved). Publish with --registry="$NPM_REGISTRY".'
  )
}
if (NPMJS_HOSTS.has(new URL(effective).host)) {
  fail(
    `effective registry is public npm (${effective}). This package is private.`
  )
}
if (allowlist.size > 0 && !allowlist.has(effective)) {
  fail(
    `effective registry ${effective} is not in the allowlist ` +
      `[${[...allowlist].join(", ")}]. Set NPM_REGISTRY / ` +
      `SYNAPSE_NPM_REGISTRY_ALLOWLIST or pass --registry.`
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
