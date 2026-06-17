// Locate the packaged bundles manifest. Both `synapse-device run` and
// `synapse-device install-bundles` resolve this the same way so the
// runtime always reads from the location install populated.
//
// dist/bundles/manifest-loader.js → walk up to the package root → join
// "bundles/manifest.json". When the package is installed from npm the
// bundles/ directory is included via package.json `files`.

import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve as pathResolve } from "node:path"
import { fileURLToPath } from "node:url"

import { parseToolchainManifestJsonText } from "../terminal/manifest.js"
import type { ToolchainManifest } from "../terminal/manifest.js"

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Default path to the packaged manifest. CLI / builtins consult this when
 * the operator doesn't pass `--toolchain-manifest`.
 */
export function defaultManifestPath(): string {
  // dist/bundles/manifest-loader.js → ../../bundles/manifest.json
  return pathResolve(HERE, "..", "..", "bundles", "manifest.json")
}

/**
 * Absolute path of the device-runtime package root. The CLI uses this to
 * locate optional sibling directories (e.g. bundles/archives) that ship
 * via package.json `files` when an operator builds a custom tarball with
 * pre-staged toolchain archives baked in.
 */
export function defaultPackageRoot(): string {
  // dist/bundles/manifest-loader.js → ../..
  return pathResolve(HERE, "..", "..")
}

/**
 * Default cache directory for extracted bundles. Honours XDG_CACHE_HOME
 * and falls back to ~/.cache/synapse/device-toolchains.
 */
export function defaultToolchainDir(): string {
  const xdg = process.env.XDG_CACHE_HOME
  const home = process.env.HOME ?? process.cwd()
  if (xdg && xdg.length > 0) {
    return pathResolve(xdg, "synapse", "device-toolchains")
  }
  return pathResolve(home, ".cache", "synapse", "device-toolchains")
}

export function loadManifestFromPath(path: string): ToolchainManifest {
  if (!existsSync(path)) {
    throw new Error(`toolchain manifest not found at ${path}`)
  }
  const raw = readFileSync(path, "utf-8")
  return parseToolchainManifestJsonText(raw)
}
