#!/usr/bin/env node
// Build-time generator for the Synapse-owned CLI-Anything catalog (plan v5 §5.A).
//
// Entity source = registry.json (harness-cli) + public_registry.json (public-cli) FLAT lists
//   (they carry name + entry_point + install_cmd). cliName = name; entryPoint = entry_point.
// Matrix structured-requires enrichment is joined by requires.binary[0] === entry_point
//   (harness) / requires.binary[0] ∈ {entry_point, name} (public) — NEVER by provider.name
//   (a display string). matrix.requires.binary is SELF-REFERENTIAL for harness-cli, so the
//   underlying-app prereq for harnesses comes from FREE-TEXT; for public-cli the matrix binary
//   IS the real tool.
// gitlink-SHA pinning is injected ONLY for github.com/HKUDS/CLI-Anything git+ URLs.
// Credentialed CLIs are dropped (decision 7). v1 managers = pip + npm only.
//
// Emits into packages/device-runtime/src/builtins/cli-catalog/:
//   cli-catalog.generated.json        — normalized catalog (the bundled, agent-facing source of truth)
//   cli-prereq-overlay.draft.json     — DRAFT curated overlay (the committed cli-prereq-overlay.json is human-reviewed)
// Run: node packages/device-runtime/scripts/generate-cli-catalog.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SHA = "bf3cc39e2edb0be313e395077e4cd3f1f4573c53" // == the submodule gitlink; single source of truth for pinning
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "..", "..", "..")
const submodule = join(repoRoot, "subprojects", "cli-anything")
const outDir = join(
  repoRoot,
  "packages",
  "device-runtime",
  "src",
  "builtins",
  "cli-catalog"
)
const read = (f) => JSON.parse(readFileSync(join(submodule, f), "utf8"))
const registry = read("registry.json")
const publicReg = read("public_registry.json")
const matrix = read("matrix_registry.json")

// ── matrix index keyed by requires.binary[0] (the join key) ───────────────────────────
const matrixByBinary = new Map() // binary[0] -> {requires, costTier, qualityTier, offline, installHint}
const matrixClisUnion = new Set()
for (const m of matrix.matrices ?? []) {
  for (const c of m.clis ?? []) matrixClisUnion.add(c)
  for (const cap of m.capabilities ?? []) {
    for (const p of cap.providers ?? []) {
      if (p.kind !== "harness-cli" && p.kind !== "public-cli") continue
      const bin0 = p.requires?.binary?.[0]
      if (!bin0 || matrixByBinary.has(bin0)) continue
      matrixByBinary.set(bin0, {
        requires: p.requires ?? {},
        costTier: p.cost_tier ?? null,
        qualityTier: p.quality_tier ?? null,
        offline: p.offline ?? null,
        installHint: p.install_hint ?? null,
      })
    }
  }
}
const matrixFor = (entity) =>
  matrixByBinary.get(entity.entry_point) ||
  matrixByBinary.get(entity.name) ||
  null

// ── credential detection (drop on credential; decision 7) ─────────────────────────────
// Comprehensive credential-signal denylist + an explicit known set; SERVICE signals
// ("running at", "instance running", localhost) are NOT credentials (those are service-gated).
const CRED_RE =
  /(api[\s_-]?key|api[\s_-]?token|access[\s_-]?token|personal access token|auth[\s_-]?token|_API_KEY|_API_TOKEN|_TOKEN|oauth|\bDSN\b|password|secret|credential|\blog ?in\b|\bsign ?in\b|\blogin\b|store access|partner access|account\b)/i
const KNOWN_CREDENTIAL = new Set([
  "anygen",
  "novita",
  "rms",
  "zoom",
  "exa",
  "minimax",
  "minimax-cli",
  "elevenlabs",
  "sentry",
  "firefly-iii",
  "tigris",
  "shopify",
  "ve-twini",
  "jimeng",
  "suno",
  "contentful",
  "sanity",
  "mailchimp",
  "tinyfish",
  "notebooklm",
])
const isCredential = (name, freeText, mxEnv) =>
  KNOWN_CREDENTIAL.has(name) ||
  (Array.isArray(mxEnv) && mxEnv.length > 0) ||
  CRED_RE.test(String(freeText ?? ""))

// ── free-text requires → structured underlying (harness; also fallback for public) ────
const APT_RE = /([a-z0-9.+-]+)\s*\(apt install\s+([a-z0-9.+-]+)\)/gi
const URL_RE = /(https?:\/\/[^\s,)]+)/i
const VER_RE = /([A-Za-z][A-Za-z0-9.+-]*)\s*>=?\s*([0-9][0-9.]*)/
function parseUnderlying(text) {
  const t = String(text ?? "").trim()
  const out = { underlying: {}, confident: false }
  if (!t || /^none$/i.test(t)) {
    out.confident = true
    return out
  }
  const bins = new Set()
  let conf = false,
    m
  while ((m = APT_RE.exec(t)) !== null) {
    bins.add(m[2].toLowerCase())
    conf = true
  }
  if (/running at/i.test(t) || /instance running/i.test(t)) {
    const u = t.match(URL_RE)
    out.underlying.service = [{ url: u ? u[1] : null }]
    conf = !!u
  }
  const v = t.match(VER_RE)
  if (v) {
    let n = v[1].toLowerCase()
    if (/^node\.?js$/.test(n)) n = "node" // `node.js` is not an executable; the binary is `node`
    bins.add(n)
    out.underlying.minVersion = { [n]: v[2] }
    conf = true
  }
  if (/macos only/i.test(t)) out.underlying.platform = ["darwin"]
  if (/windows only/i.test(t)) out.underlying.platform = ["win32"]
  if (/node\.?js/i.test(t)) {
    bins.add("node")
    conf = true
  } // canonical `node`, never `node.js`
  // NO first-word free-text fallback: guessing a binary from arbitrary prose
  // yields bogus tokens (cc/upstream/local/slay/...). Leave underlying empty +
  // low-confidence so the entry is reviewed:false and the runtime gate safe-hides
  // it until a human curates a real prereq.
  if (bins.size) out.underlying.binary = [...bins]
  out.confident = conf
  return out
}

// ── install + manager classification (+ scoped SHA injection) ─────────────────────────
const HKUDS_GIT = "git+https://github.com/HKUDS/CLI-Anything.git"
function classifyHarnessInstall(cmd) {
  // returns {manager, cmd, residual?} or {drop:reason}
  if (cmd.includes(HKUDS_GIT)) {
    // inject the gitlink SHA before #subdirectory (pip VCS parser requires that order)
    const pinned = cmd.replace(HKUDS_GIT, `${HKUDS_GIT}@${SHA}`)
    return { manager: "pip", cmd: pinned, pin: SHA }
  }
  if (/git\+https:\/\/github\.com\//.test(cmd))
    return { manager: "pip", cmd, residual: "third-party-git-unpinned" } // 5 third-party
  if (/cargo\s+install/.test(cmd)) return { drop: "unsupported-manager:cargo" }
  if (/&&\s*npm/.test(cmd) || /npm\s+link/.test(cmd))
    return { drop: "unsupported-manager:npm-link" }
  if (/^pip install /.test(cmd.trim()))
    return { manager: "pip", cmd, pin: null } // PyPI by name (zotero/inkstitch)
  return { drop: `unsupported-manager:harness:${cmd.slice(0, 24)}` }
}
function gitProvenance(cmd) {
  if (!/git\+https?:\/\//.test(cmd)) return undefined
  // pinned when a @<ref> sits before #subdirectory or end of url
  return /@[\w.+-]+(#|$|\s)/.test(cmd)
    ? "third-party-git-pinned"
    : "third-party-git-unpinned"
}
function classifyPublicInstall(c) {
  const mgr = c.package_manager
  if (mgr === "npm") {
    // npm packages install floating 'latest' (we can't resolve a version at
    // build without network); record the residual per decision 6 / §5.D.
    return {
      manager: "npm",
      cmd: c.install_cmd,
      pin: null,
      npxCmd: c.npx_cmd ?? null,
      residual: "npm-latest-unpinned",
    }
  }
  if (mgr === "pip") {
    // public pip CLIs install verbatim (some are third-party git+ — keep their
    // own pin; NEVER inject the HKUDS SHA). Tag provenance for audit.
    const residual = gitProvenance(String(c.install_cmd ?? ""))
    return {
      manager: "pip",
      cmd: c.install_cmd,
      pin: null,
      ...(residual ? { residual } : {}),
    }
  }
  return { drop: `unsupported-manager:${mgr ?? "none"}` }
}

const bareOk = (ep) => ep && !/[\\/~:]/.test(ep) && !ep.includes("..")
const catalog = []
const overlay = []
const drop = {
  credential: [],
  unsupportedManager: [],
  nonBareEntryPoint: [],
  pureMatrixNoInstall: [],
}

function emit(c, kind, inst, mx, parsed) {
  catalog.push({
    cliName: c.name,
    entryPoint: c.entry_point,
    kind,
    install: {
      manager: inst.manager,
      cmd: inst.cmd,
      pin: inst.pin ?? null,
      ...(inst.npxCmd ? { npxCmd: inst.npxCmd } : {}),
      ...(c.detect_cmd ? { detectCmd: c.detect_cmd } : {}),
      ...(inst.residual ? { residual: inst.residual } : {}),
    },
    skillMd: c.skill_md ?? null,
    displayName: c.display_name ?? c.name,
    description: c.description ?? "",
    category: c.category ?? "",
    homepage: c.homepage ?? null,
    version: c.version ?? null,
    costTier: mx?.costTier ?? null,
    qualityTier: mx?.qualityTier ?? null,
    offline: mx?.offline ?? null,
  })
  overlay.push({
    cliName: c.name,
    entryPoint: c.entry_point,
    underlying: parsed.underlying,
    credential: false,
    reviewed: parsed.confident,
    _src: parsed._src,
    _freeText: c.requires ?? null,
  })
}

// (a) harness-cli entities
for (const c of registry.clis ?? []) {
  if (!bareOk(c.entry_point)) {
    drop.nonBareEntryPoint.push(c.name)
    continue
  }
  const mx = matrixFor(c)
  if (isCredential(c.name, c.requires, mx?.requires?.env)) {
    drop.credential.push(c.name)
    continue
  }
  const inst = classifyHarnessInstall(String(c.install_cmd ?? ""))
  if (inst.drop) {
    drop.unsupportedManager.push(`${c.name}:${inst.drop}`)
    continue
  }
  const parsed = parseUnderlying(c.requires)
  parsed._src = "harness/free-text" // matrix.binary is self-name → ignore for underlying
  emit(c, "harness-cli", inst, mx, parsed)
}
// (b) public-cli entities
for (const c of publicReg.clis ?? []) {
  if (!bareOk(c.entry_point)) {
    drop.nonBareEntryPoint.push(c.name)
    continue
  }
  const mx = matrixFor(c)
  if (isCredential(c.name, c.requires, mx?.requires?.env)) {
    drop.credential.push(c.name)
    continue
  }
  const inst = classifyPublicInstall(c)
  if (inst.drop) {
    drop.unsupportedManager.push(`${c.name}:${inst.drop}`)
    continue
  }
  const parsed = parseUnderlying(c.requires)
  if (mx?.requires?.binary?.length) {
    parsed.underlying.binary = mx.requires.binary
    parsed.confident = true
    parsed._src = "public/matrix.binary"
  } else parsed._src = "public/free-text"
  emit(c, "public-cli", inst, mx, parsed)
}

// pure-matrix-only tools (matrix providers with no registry/public entity + no
// install_cmd) → deferred. Computed from matrixByBinary KEYS (the requires.binary[0]
// tool names), NOT matrices[].clis[] short-ids (which never equal a tool name) —
// e.g. yt-dlp/you-get/lux/BBDown/spotdl/scdl/bandcamp-dl/scenedetect/ffmpeg-quality-metrics.
const entityKeys = new Set(catalog.flatMap((c) => [c.cliName, c.entryPoint]))
const credentialSet = new Set(drop.credential)
void matrixClisUnion // retained for reference; not a join key
// a matrix tool resolves if its name (or 'cli-anything-' stripped form) is an
// entity or a credential-drop; otherwise it's a genuinely-deferred public tool.
const STRIP_PREFIX = (n) => n.replace(/^cli-anything-/, "")
const resolvesMatrixTool = (bin0) =>
  entityKeys.has(bin0) ||
  credentialSet.has(bin0) ||
  entityKeys.has(STRIP_PREFIX(bin0)) ||
  credentialSet.has(STRIP_PREFIX(bin0))
for (const bin0 of matrixByBinary.keys()) {
  if (!resolvesMatrixTool(bin0)) drop.pureMatrixNoInstall.push(bin0)
}
drop.pureMatrixNoInstall = [...new Set(drop.pureMatrixNoInstall)]

// ── build assertions: no silent drop ──
// (1) every flat entity is either in the catalog or has an explicit drop reason.
const accounted =
  catalog.length +
  drop.credential.length +
  drop.unsupportedManager.length +
  drop.nonBareEntryPoint.length
const totalEntities =
  (registry.clis?.length ?? 0) + (publicReg.clis?.length ?? 0)
if (accounted !== totalEntities) {
  throw new Error(
    `BUILD ASSERTION FAILED: accounted ${accounted} != ${totalEntities} entities (silent drop). drop=${JSON.stringify(drop)}`
  )
}
// (2) every matrix installable tool resolves to entity | credential | pure-matrix-defer.
for (const bin0 of matrixByBinary.keys()) {
  if (!resolvesMatrixTool(bin0) && !drop.pureMatrixNoInstall.includes(bin0)) {
    throw new Error(
      `BUILD ASSERTION FAILED: matrix tool '${bin0}' unresolved (silent drop)`
    )
  }
}
// (3) no overlay binary token is non-bare (e.g. 'node.js') — it would never resolve on PATH.
for (const o of overlay) {
  for (const b of o.underlying.binary ?? []) {
    if (/[.\\/~:]/.test(b)) {
      throw new Error(
        `BUILD ASSERTION FAILED: overlay '${o.cliName}' has non-bare binary token '${b}'`
      )
    }
  }
}

mkdirSync(outDir, { recursive: true })
catalog.sort((a, b) => a.cliName.localeCompare(b.cliName))
overlay.sort((a, b) => a.cliName.localeCompare(b.cliName))
const meta = {
  source: "HKUDS/CLI-Anything",
  pin: SHA,
  generator: "generate-cli-catalog.mjs",
}
writeFileSync(
  join(outDir, "cli-catalog.generated.json"),
  JSON.stringify({ meta, clis: catalog }, null, 2) + "\n"
)
writeFileSync(
  join(outDir, "cli-prereq-overlay.draft.json"),
  JSON.stringify({ meta, entries: overlay }, null, 2) + "\n"
)

const reviewedFalse = overlay.filter((o) => !o.reviewed).map((o) => o.cliName)
console.log("=== CLI catalog generation (v5) ===")
console.log(
  `catalog: ${catalog.length} (harness=${catalog.filter((c) => c.kind === "harness-cli").length}, public=${catalog.filter((c) => c.kind === "public-cli").length})`
)
console.log(
  `overlay reviewed=false (human pass): ${reviewedFalse.length} -> ${reviewedFalse.join(", ")}`
)
console.log(
  `dropped credential (decision 7): ${drop.credential.length} -> ${drop.credential.join(", ")}`
)
console.log(
  `dropped unsupported-manager (v1 pip+npm): ${drop.unsupportedManager.length} -> ${drop.unsupportedManager.join(", ")}`
)
console.log(
  `dropped non-bare entry_point: ${drop.nonBareEntryPoint.length} -> ${drop.nonBareEntryPoint.join(", ")}`
)
console.log(
  `deferred pure-matrix-only (no install_cmd): ${drop.pureMatrixNoInstall.length} -> ${drop.pureMatrixNoInstall.join(", ")}`
)
console.log(
  `build assertion OK: ${accounted}/${totalEntities} entities accounted (no silent drop)`
)
