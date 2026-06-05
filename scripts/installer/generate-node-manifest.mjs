#!/usr/bin/env node
// Maintainer tool: pin the installer's bootstrap Node version + regenerate the
// embedded sha256 manifest inside install.sh and install.ps1.
//
// WHY a separate Node version from packages/device-runtime/bundles/manifest.json
// (which pins 22.11.0): that manifest is the toolchain handed to device child
// processes; 22.11.0 does NOT satisfy the @synapse engines range
// (^20.19.0 || ^22.12.0 || >=23). The installer must bootstrap a Node that DOES
// — we pin the latest 24.x LTS.
//
// Run manually when bumping the version (not wired into build/CI):
//   node scripts/installer/generate-node-manifest.mjs            # uses INSTALLER_NODE_VERSION
//   node scripts/installer/generate-node-manifest.mjs 24.16.0    # explicit
//
// It fetches ONLY canonical https://nodejs.org/dist/v<ver>/SHASUMS256.txt
// (never a mirror — the sha256 is the integrity anchor) and rewrites the
// `SYNAPSE_NODE_MANIFEST` marker block in both scripts.

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(
  __dirname,
  "..",
  "..",
  "packages",
  "api",
  "src",
  "modules",
  "installer",
  "assets"
)
const SH = join(ASSETS, "install.sh")
const PS1 = join(ASSETS, "install.ps1")

// The 6 platform artifacts the installer can bootstrap. key -> dist filename.
const ARTIFACTS = {
  "linux-x64": (v) => `node-v${v}-linux-x64.tar.gz`,
  "linux-arm64": (v) => `node-v${v}-linux-arm64.tar.gz`,
  "darwin-x64": (v) => `node-v${v}-darwin-x64.tar.gz`,
  "darwin-arm64": (v) => `node-v${v}-darwin-arm64.tar.gz`,
  "win-x64": (v) => `node-v${v}-win-x64.zip`,
  "win-arm64": (v) => `node-v${v}-win-arm64.zip`,
}

function currentPinnedVersion() {
  const sh = readFileSync(SH, "utf8")
  const m = sh.match(/INSTALLER_NODE_VERSION="([^"]+)"/)
  return m ? m[1] : null
}

async function fetchShasums(version) {
  const url = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`)
  }
  const text = await res.text()
  const byFile = new Map()
  for (const line of text.split("\n")) {
    const [hash, file] = line.trim().split(/\s+/)
    if (hash && file) byFile.set(file, hash)
  }
  const result = {}
  for (const [key, nameFn] of Object.entries(ARTIFACTS)) {
    const file = nameFn(version)
    const hash = byFile.get(file)
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`missing/invalid sha256 for ${file} in ${url}`)
    }
    result[key] = hash
  }
  return result
}

function renderShBlock(version, hashes) {
  const lines = [
    "# >>> SYNAPSE_NODE_MANIFEST (generated — do not edit by hand) >>>",
    `INSTALLER_NODE_VERSION="${version}"`,
    "node_artifact_sha256() {",
    '  case "$1" in',
  ]
  for (const [key, hash] of Object.entries(hashes)) {
    lines.push(`    ${key}) printf '%s' "${hash}" ;;`)
  }
  lines.push(
    "    *) return 1 ;;",
    "  esac",
    "}",
    "# <<< SYNAPSE_NODE_MANIFEST <<<"
  )
  return lines.join("\n")
}

function renderPs1Block(version, hashes) {
  const lines = [
    "# >>> SYNAPSE_NODE_MANIFEST (generated — do not edit by hand) >>>",
    `$InstallerNodeVersion = '${version}'`,
    "$NodeArtifactSha256 = @{",
  ]
  for (const [key, hash] of Object.entries(hashes)) {
    lines.push(`  '${key}' = '${hash}'`)
  }
  lines.push("}", "# <<< SYNAPSE_NODE_MANIFEST <<<")
  return lines.join("\n")
}

function replaceBlock(content, rendered, file) {
  const begin = "# >>> SYNAPSE_NODE_MANIFEST"
  const end = "# <<< SYNAPSE_NODE_MANIFEST <<<"
  const startIdx = content.indexOf(begin)
  const endIdx = content.indexOf(end)
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`SYNAPSE_NODE_MANIFEST markers not found in ${file}`)
  }
  return (
    content.slice(0, startIdx) + rendered + content.slice(endIdx + end.length)
  )
}

async function main() {
  const version = process.argv[2] || currentPinnedVersion()
  if (!version) {
    throw new Error("no version given and none pinned in install.sh")
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`invalid version '${version}' (expected MAJOR.MINOR.PATCH)`)
  }
  console.error(
    `[gen-node-manifest] pinning Node ${version}; fetching canonical SHASUMS…`
  )
  const hashes = await fetchShasums(version)

  const sh = readFileSync(SH, "utf8")
  writeFileSync(
    SH,
    replaceBlock(sh, renderShBlock(version, hashes), "install.sh")
  )
  const ps1 = readFileSync(PS1, "utf8")
  writeFileSync(
    PS1,
    replaceBlock(ps1, renderPs1Block(version, hashes), "install.ps1")
  )

  console.error("[gen-node-manifest] updated install.sh + install.ps1:")
  for (const [key, hash] of Object.entries(hashes)) {
    console.error(`  ${key.padEnd(13)} ${hash}`)
  }
}

main().catch((err) => {
  console.error(`[gen-node-manifest] ERROR: ${err.message}`)
  process.exit(1)
})
