// Builds the one-click installer commands shown on the dashboard, and renders
// the installer scripts served by the public install routes.
//
// No DB / network side effects — it only reads the two static asset scripts
// from disk and does string substitution + hashing. Split into a pure command
// builder and an artifact loader so each is independently testable (see
// install-command.test.ts). Models the registry-pinning discipline of
// remote-agents/daemon-command.ts.
//
// TWO registries, never conflated:
//   - synapseRegistry  (private Verdaccio): only via @synapse:registry
//   - third-party deps: resolved client-side by the script (geo), not here
//
// SECURITY: the served script bytes are what we hash. The one-click command
// embeds that sha256 so the client verifies the downloaded script before
// running it (download-to-file-then-verify, never stream-exec / iex).

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Asset lookup: prefer dist/ (Docker / built), fall back to src/ (dev,
// `npm start` without a copy step). Both resolve relative to this module.
function readAsset(name: string): string {
  const candidates = [
    join(__dirname, "assets", name),
    // dist/modules/installer -> src/modules/installer/assets
    join(
      __dirname,
      "..",
      "..",
      "..",
      "src",
      "modules",
      "installer",
      "assets",
      name
    ),
  ]
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf8")
    } catch {
      // try next
    }
  }
  throw new Error(
    `installer asset not found: ${name} (looked in ${candidates.join(", ")})`
  )
}

const PLACEHOLDER_SERVER = "@@SYNAPSE_SERVER_URL@@"
const PLACEHOLDER_REGISTRY = "@@SYNAPSE_NPM_REGISTRY@@"
const PLACEHOLDER_PS1_SHA = "@@SYNAPSE_PS1_SHA256@@"

export interface InstallerConfig {
  /** External server origin baked into the scripts (config.app.baseUrl). */
  serverUrl: string
  /** Private @synapse registry (PUBLIC_NPM_REGISTRY_URL). Empty disables. */
  privateRegistry: string
}

export interface RenderedInstallerArtifacts {
  scriptSh: string
  scriptPs1: string
  shaSh: string
  shaPs1: string
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

// POSIX single-quote escaping: wrap in '...' and replace ' with '\''.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

// PowerShell single-quote escaping: wrap in '...' and double embedded quotes.
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// Substitute server/registry placeholders only. Values are quoted for the
// target shell context so a hostile/odd URL can't break out of the literal.
function renderScript(
  body: string,
  cfg: InstallerConfig,
  quote: (v: string) => string,
  extra?: Record<string, string>
): string {
  let out = body
    .split(PLACEHOLDER_SERVER)
    .join(stripQuotes(quote(cfg.serverUrl)))
    .split(PLACEHOLDER_REGISTRY)
    .join(stripQuotes(quote(cfg.privateRegistry)))
  for (const [k, v] of Object.entries(extra ?? {})) {
    out = out.split(k).join(v)
  }
  return out
}

// The placeholders sit inside the scripts' own quotes (SH="...", PS1='...'),
// so we substitute the bare (escaped) value, not a re-quoted one. We still run
// the value through the quoter to neutralize embedded quotes, then strip the
// outer wrapping quote the quoter added.
function stripQuotes(quoted: string): string {
  // shQuote/psQuote both wrap in single quotes; remove the first and last.
  return quoted.slice(1, -1)
}

/**
 * Render both installer scripts with the live instance values and compute
 * their sha256. Single-direction hash injection avoids a hash cycle:
 *   1. render install.ps1 -> shaPs1
 *   2. inject shaPs1 into install.sh (so the Git-Bash re-exec can verify the
 *      downloaded ps1) -> shaSh
 * install.ps1 NEVER embeds shaSh (the ps1 is verified by the one-click command
 * itself), so there is no circular dependency.
 *
 * Returns null when no private registry is configured (one-click bootstrap
 * cannot install @synapse/* without it).
 */
export function getRenderedInstallerArtifacts(
  cfg: InstallerConfig
): RenderedInstallerArtifacts | null {
  if (!cfg.privateRegistry || !cfg.privateRegistry.trim()) return null

  const scriptPs1 = renderScript(readAsset("install.ps1"), cfg, psQuote)
  const shaPs1 = sha256(scriptPs1)

  const scriptSh = renderScript(readAsset("install.sh"), cfg, shQuote, {
    [PLACEHOLDER_PS1_SHA]: shaPs1,
  })
  const shaSh = sha256(scriptSh)

  return { scriptSh, scriptPs1, shaSh, shaPs1 }
}

export interface OneClickCommands {
  unix: string
  windows: string
}

interface DeviceCommandInput {
  serverUrl: string
  pairingCode: string
  shaSh: string
  shaPs1: string
}

interface DaemonCommandInput {
  serverUrl: string
  apiKey: string
  shaSh: string
  shaPs1: string
}

// Unix one-liner: curl||wget the script to a temp file, verify the embedded
// sha256 (sha256sum||shasum), then `bash "$f" <flags>`. Never pipes to bash.
function unixCommand(
  serverUrl: string,
  shaSh: string,
  flagPairs: Array<[string, string]>
): string {
  const url = `${serverUrl.replace(/\/$/, "")}/api/v1/install.sh`
  const flags = flagPairs
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k} ${shQuote(v)}`)
    .join(" ")
  // download-to-file -> sha256 verify -> run; tools have fallbacks.
  return [
    `f=$(mktemp)`,
    `{ curl -fsSL ${shQuote(url)} -o "$f" || wget -qO "$f" ${shQuote(url)}; }`,
    `&& { echo ${shQuote(`${shaSh}  $f`)} | { sha256sum -c - 2>/dev/null || shasum -a 256 -c - 2>/dev/null; }; }`,
    `&& bash "$f" ${flags}`,
  ].join(" ")
}

// Windows one-liner: PowerShell-native (no `powershell -Command "..."` outer
// wrapper, which would pre-expand $f). Download -> Get-FileHash verify -> run.
function windowsCommand(
  serverUrl: string,
  shaPs1: string,
  flagPairs: Array<[string, string]>
): string {
  const url = `${serverUrl.replace(/\/$/, "")}/api/v1/install.ps1`
  const flags = flagPairs
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k} ${psQuote(v)}`)
    .join(" ")
  return [
    `$f=[IO.Path]::GetTempFileName()+'.ps1';`,
    `irm ${psQuote(url)} -OutFile $f;`,
    `if((Get-FileHash $f -Algorithm SHA256).Hash -ne ${psQuote(shaPs1.toUpperCase())}){throw 'install.ps1 sha256 mismatch'};`,
    `powershell -ExecutionPolicy Bypass -NoProfile -File $f ${flags}`,
  ].join(" ")
}

export function buildDeviceInstallCommands(
  input: DeviceCommandInput
): OneClickCommands {
  return {
    unix: unixCommand(input.serverUrl, input.shaSh, [
      ["--target", "device"],
      ["--server", input.serverUrl],
      ["--code", input.pairingCode],
    ]),
    windows: windowsCommand(input.serverUrl, input.shaPs1, [
      ["-Target", "device"],
      ["-Server", input.serverUrl],
      ["-Code", input.pairingCode],
    ]),
  }
}

export function buildDaemonInstallCommands(
  input: DaemonCommandInput
): OneClickCommands {
  return {
    unix: unixCommand(input.serverUrl, input.shaSh, [
      ["--target", "daemon"],
      ["--server", input.serverUrl],
      ["--api-key", input.apiKey],
    ]),
    windows: windowsCommand(input.serverUrl, input.shaPs1, [
      ["-Target", "daemon"],
      ["-Server", input.serverUrl],
      ["-ApiKey", input.apiKey],
    ]),
  }
}
