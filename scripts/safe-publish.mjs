#!/usr/bin/env node
// safe-publish.mjs — the authoritative, npmjs-proof publisher for the
// @synapse main packages.
//
// WHY THIS EXISTS
// For a SCOPED package, npm routes `npm publish` to the scope-specific
// registry (@synapse:registry), which OVERRIDES a generic `--registry`
// flag. So `npm publish --registry=$PRIVATE` can still ship to public
// npmjs if a stray `@synapse:registry=...npmjs...` sits in the operator's
// ~/.npmrc or global npmrc. The prepublishOnly guard cannot fully see the
// effective scope registry from inside the lifecycle, so the robust place
// to enforce the destination is HERE, in the parent process, before npm
// runs.
//
// WHAT IT DOES
//   1. Requires NPM_REGISTRY (the private registry URL) and rejects npmjs.
//   2. Computes the EFFECTIVE @synapse:registry as npm would see it
//      (honoring all npmrc layers) and refuses if it resolves to npmjs
//      unless we are about to override it (we always do).
//   3. Runs `npm publish` for the given workspace pinning BOTH
//      `--registry` and `--@synapse:registry` to NPM_REGISTRY. The
//      scope flag is what actually wins for scoped packages (verified),
//      so the destination is forced regardless of ambient npmrc.
//
// Usage:
//   NPM_REGISTRY=https://npm.host/ node scripts/safe-publish.mjs <workspace-dir> [extra npm publish args...]
// e.g.
//   node scripts/safe-publish.mjs packages/device-protocol
//   node scripts/safe-publish.mjs packages/shared --dry-run

import { execFileSync } from "node:child_process"

const NPMJS_HOSTS = new Set([
  "registry.npmjs.org",
  "registry.npmjs.com",
  "registry.yarnpkg.com",
])
const SCOPE = "@synapse"

function die(msg) {
  console.error(`[safe-publish] ${msg}`)
  process.exit(1)
}

function normalize(raw) {
  if (!raw) return null
  const t = String(raw).trim()
  if (!t || t === "undefined" || t === "null" || t.includes("${")) return null
  try {
    const u = new URL(t)
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`
  } catch {
    return null
  }
}

const ws = process.argv[2]
if (!ws) die("usage: safe-publish.mjs <workspace-dir> [npm publish args...]")
const extra = process.argv.slice(3)

// Reject extra args that would defeat the guards:
//   - --ignore-scripts / ignore-scripts=true skips prepublishOnly, which
//     is exactly the dist/test/map/registry guard. Refuse it (and we also
//     force NPM_CONFIG_IGNORE_SCRIPTS=false in the child env below).
//   - any registry override in extra would fight the pins we add and could
//     redirect the publish; refuse it (the destination is fixed here).
for (const arg of extra) {
  const a = String(arg).toLowerCase()
  if (
    a === "--ignore-scripts" ||
    a.replace(/\s/g, "") === "ignore-scripts=true"
  ) {
    die(
      `refusing --ignore-scripts: it would skip the prepublishOnly guard ` +
        `(dist/test/map/registry checks).`
    )
  }
  if (
    a === "--registry" ||
    a.startsWith("--registry=") ||
    a.includes("registry=")
  ) {
    die(
      `refusing a registry override in extra args (${arg}): the destination ` +
        `is pinned to $NPM_REGISTRY by this wrapper.`
    )
  }
}

const registry = normalize(process.env.NPM_REGISTRY)
if (!registry) {
  die(
    `NPM_REGISTRY must be set to the private registry URL (got ` +
      `${JSON.stringify(process.env.NPM_REGISTRY)}).`
  )
}
if (NPMJS_HOSTS.has(new URL(registry).host)) {
  die(
    `NPM_REGISTRY points at public npm (${registry}); these packages are private.`
  )
}

// Show what the ambient config WOULD route to (diagnostic only — we
// override it below). If it's npmjs, warn loudly so the operator knows
// their npmrc is dangerous even though this run is safe.
try {
  const ambientScope = normalize(
    execFileSync("npm", ["config", "get", `${SCOPE}:registry`], {
      encoding: "utf8",
    })
  )
  if (ambientScope && NPMJS_HOSTS.has(new URL(ambientScope).host)) {
    console.error(
      `[safe-publish] WARNING: ambient ${SCOPE}:registry resolves to public ` +
        `npm (${ambientScope}). Overriding with --${SCOPE}:registry=${registry} ` +
        `for this publish — but fix your ~/.npmrc.`
    )
  }
} catch {
  /* npm config get is best-effort diagnostics */
}

// Pin BOTH the generic and the scope-specific registry. The scope flag is
// the one that actually governs a scoped publish and beats any npmrc
// scope mapping (verified), so the destination is forced.
const args = [
  "publish",
  "-w",
  ws,
  `--registry=${registry}`,
  `--${SCOPE}:registry=${registry}`,
  ...extra,
]

console.error(`[safe-publish] npm ${args.join(" ")}`)
try {
  execFileSync("npm", args, {
    stdio: "inherit",
    // Force scripts ON so the prepublishOnly guard always runs, even if the
    // operator's npm config has ignore-scripts=true.
    env: { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: "false" },
  })
} catch (e) {
  process.exit(e.status ?? 1)
}
