#!/usr/bin/env node

import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { spawn } from "node:child_process"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { resolveRequiredSubprojectRoot } from "./lib/subprojects.mjs"

const DEFAULT_NODE_VERSION = "24.14.1"
const DEFAULT_PYTHON_VERSION = "3.14.1"
const DEFAULT_PYTHON_STANDALONE_RELEASE = "20251202"
const DEFAULT_WINDOWS_GIT_VERSION = "2.49.0.windows.1"
const DEFAULT_FFMPEG_RELEASE_TAG = "n7.1-2"
const DEFAULT_PACKAGE_PROFILE = "default-data-v5"

const COMMANDLINE_ASSET_SCHEMA_VERSION = 3
const COMMANDLINE_ASSET_PREFIX = "cl"
const COMMANDLINE_NODE_MODULES_DIR = "nm"
const COMMANDLINE_PYTHON_HOME_DIR = "py"
const COMMANDLINE_PYTHON_SITE_PACKAGES_DIR = "sp"
const COMMANDLINE_MANAGED_BIN_DIR = "bin"
const COMMANDLINE_PROVIDER_DIR = "providers"
const COMMANDLINE_FFMPEG_DIR = "ff"
const COMMANDLINE_GIT_DIR = "git"

const PYTHON_DISTRIBUTIONS = {
  "linux-amd64": {
    distribution: "x86_64-unknown-linux-gnu-install_only_stripped",
    pipPlatform: "manylinux2014_x86_64",
  },
  "linux-arm64": {
    distribution: "aarch64-unknown-linux-gnu-install_only_stripped",
    pipPlatform: "manylinux2014_aarch64",
  },
  "darwin-amd64": {
    distribution: "x86_64-apple-darwin-install_only_stripped",
    pipPlatform: "macosx_10_13_x86_64",
  },
  "darwin-arm64": {
    distribution: "aarch64-apple-darwin-install_only_stripped",
    pipPlatform: "macosx_11_0_arm64",
  },
  "windows-amd64": {
    distribution: "x86_64-pc-windows-msvc-install_only_stripped",
    pipPlatform: "win_amd64",
  },
}

const FFMPEG_DISTRIBUTIONS = {
  "linux-amd64": {
    ffmpegAsset: "ffmpeg-linux-x64",
    ffprobeAsset: "ffprobe-linux-x64",
  },
  "linux-arm64": {
    ffmpegAsset: "ffmpeg-linux-arm64",
    ffprobeAsset: "ffprobe-linux-arm64",
  },
  "darwin-amd64": {
    ffmpegAsset: "ffmpeg-osx-x64",
    ffprobeAsset: "ffprobe-osx-x64",
  },
  "darwin-arm64": {
    ffmpegAsset: "ffmpeg-osx-arm64",
    ffprobeAsset: "ffprobe-osx-arm64",
  },
  "windows-amd64": {
    ffmpegAsset: "ffmpeg-win-x64.exe",
    ffprobeAsset: "ffprobe-win-x64.exe",
  },
}

const NODE_DEPENDENCIES = {
  "adm-zip": "^0.5.16",
  axios: "^1.9.0",
  archiver: "^7.0.1",
  cheerio: "^1.0.0",
  "csv-parse": "^5.5.6",
  "csv-stringify": "^6.5.2",
  docx: "^9.5.0",
  exceljs: "^4.4.0",
  "extract-zip": "^2.0.1",
  "fast-xml-parser": "^4.5.0",
  "form-data": "^4.0.2",
  "image-size": "^1.2.0",
  "iconv-lite": "^0.6.3",
  ini: "^5.0.0",
  jimp: "^1.6.0",
  jszip: "^3.10.1",
  mammoth: "^1.9.1",
  "mime-types": "^2.1.35",
  "music-metadata": "^10.5.1",
  "node-id3": "^0.2.9",
  papaparse: "^5.5.3",
  "pdf-lib": "^1.17.1",
  "pdf-parse": "^1.1.1",
  pptxgenjs: "^3.12.0",
  tar: "^7.4.3",
  toml: "^3.0.0",
  unzipper: "^0.12.3",
  wavefile: "^11.0.0",
  xlsx: "^0.18.5",
  xml2js: "^0.6.2",
  yaml: "^2.5.1",
}

const PYTHON_REQUIREMENTS = [
  "aiohttp==3.13.5",
  "beautifulsoup4==4.12.3",
  "click==8.1.8",
  "httpx==0.28.1",
  "imageio==2.36.0",
  "imageio-ffmpeg==0.6.0",
  "lxml==6.0.2",
  "mutagen==1.47.0",
  "openpyxl==3.1.5",
  "pandas==3.0.2",
  "pdfplumber==0.11.4",
  "Pillow==12.2.0",
  "pydub==0.25.1",
  "py7zr==1.1.0",
  "pyzipper==0.3.6",
  "pypdf==5.1.0",
  "pyxlsb==1.0.10",
  "prompt-toolkit==3.0.48",
  "qrcode==8.0",
  "python-docx==1.1.2",
  "python-pptx==1.0.2",
  "PyYAML==6.0.3",
  "requests==2.32.3",
  "tinytag==2.0.0",
  "xlrd==2.0.1",
]

const NODE_MODULE_PRUNE_DIRS = new Set([
  "__image_snapshots__",
  "__snapshots__",
  "__tests__",
  "__mocks__",
  "__fixtures__",
  "coverage",
  "benchmark",
  "benchmarks",
  "demo",
  "demos",
  "doc",
  "docs",
  "example",
  "examples",
  "test",
  "tests",
  "website",
  ".github",
])

const PYTHON_PACKAGE_PRUNE_DIRS = new Set([
  "__pycache__",
  "doc",
  "docs",
  "example",
  "examples",
  "test",
  "tests",
  "testing",
])

function parseArgs(argv) {
  const options = {
    targetPlatform: "",
    nodeVersion: DEFAULT_NODE_VERSION,
    pythonVersion: DEFAULT_PYTHON_VERSION,
    pythonStandaloneRelease: DEFAULT_PYTHON_STANDALONE_RELEASE,
    windowsGitVersion: DEFAULT_WINDOWS_GIT_VERSION,
    ffmpegReleaseTag: DEFAULT_FFMPEG_RELEASE_TAG,
    packageProfile: DEFAULT_PACKAGE_PROFILE,
  }

  for (const arg of argv) {
    if (arg.startsWith("--target-platform=")) {
      options.targetPlatform = arg.slice("--target-platform=".length)
      continue
    }
    if (arg.startsWith("--node-version=")) {
      options.nodeVersion = arg.slice("--node-version=".length)
      continue
    }
    if (arg.startsWith("--python-version=")) {
      options.pythonVersion = arg.slice("--python-version=".length)
      continue
    }
    if (arg.startsWith("--python-standalone-release=")) {
      options.pythonStandaloneRelease = arg.slice(
        "--python-standalone-release=".length
      )
      continue
    }
    if (arg.startsWith("--windows-git-version=")) {
      options.windowsGitVersion = arg.slice("--windows-git-version=".length)
      continue
    }
    if (arg.startsWith("--ffmpeg-release-tag=")) {
      options.ffmpegReleaseTag = arg.slice("--ffmpeg-release-tag=".length)
      continue
    }
    if (arg.startsWith("--package-profile=")) {
      options.packageProfile = arg.slice("--package-profile=".length)
      continue
    }
  }

  if (!options.targetPlatform) {
    throw new Error("missing required --target-platform=<goos-goarch> argument")
  }

  return options
}

function getSharedNodeAssetVersion(targetPlatform, nodeVersion) {
  return `node-${nodeVersion}-${targetPlatform}`
}

function getNativeTargetPlatform() {
  const osMap = {
    win32: "windows",
    linux: "linux",
    darwin: "darwin",
  }
  const archMap = {
    x64: "amd64",
    arm64: "arm64",
  }
  const os = osMap[process.platform]
  const arch = archMap[process.arch]
  if (!os || !arch) {
    return ""
  }
  return `${os}-${arch}`
}

function shortHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 12)
}

function resolveManagedProviderVersion(versions) {
  const normalized = [
    ...new Set(
      (versions || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    ),
  ]
  if (normalized.length === 0) {
    return "bundled"
  }
  if (normalized.length === 1) {
    return normalized[0]
  }
  return "mixed"
}

function uniqueStrings(values) {
  return [
    ...new Set(
      (values || []).map((value) => String(value || "").trim()).filter(Boolean)
    ),
  ]
}

function runtimeSupportsTarget(runtime, targetPlatform) {
  const supportedTargets = Array.isArray(runtime?.supportedTargets)
    ? runtime.supportedTargets
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    : []
  if (supportedTargets.length === 0) {
    return true
  }
  return supportedTargets.includes(targetPlatform)
}

function capabilitySupportsTarget(capability, targetPlatform) {
  const supportedTargets = Array.isArray(capability?.supportedTargets)
    ? capability.supportedTargets
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    : []
  if (supportedTargets.length === 0) {
    return true
  }
  return supportedTargets.includes(targetPlatform)
}

function resolveDeclaredProviderVersion(provider) {
  if (!provider?.runtime || typeof provider.runtime !== "object") {
    return "bundled"
  }
  const packageVersion = String(provider.runtime.packageVersion || "").trim()
  if (packageVersion) {
    return packageVersion
  }
  const releaseVersion = String(provider.runtime.releaseVersion || "").trim()
  if (releaseVersion) {
    return releaseVersion
  }
  return "bundled"
}

function collectUnsupportedManagedEntries(providers, targetPlatform) {
  const managedProviders = []
  const managedCapabilities = []

  for (const provider of providers) {
    if (runtimeSupportsTarget(provider.runtime, targetPlatform)) {
      continue
    }
    const version = resolveDeclaredProviderVersion(provider)
    const reason = `${provider.displayName} is not officially supported on ${targetPlatform}`
    managedProviders.push({
      slug: provider.slug,
      displayName: provider.displayName,
      runtimeType: String(provider.runtime?.type || "unknown"),
      version,
    })
    for (const capability of provider.capabilities) {
      managedCapabilities.push({
        provider: provider.slug,
        providerDisplayName: provider.displayName,
        slug: capability.slug,
        command: capability.command,
        module: capability.module,
        version,
        unavailableReason: reason,
        probe: capability.probe,
      })
    }
  }

  return {
    managedProviders,
    managedCapabilities,
  }
}

function getCommandlineAssetVersion(
  options,
  nodeAssetVersion,
  managedProviders,
  managedCapabilities
) {
  return `${COMMANDLINE_ASSET_PREFIX}-${shortHash({
    schemaVersion: COMMANDLINE_ASSET_SCHEMA_VERSION,
    targetPlatform: options.targetPlatform,
    packageProfile: options.packageProfile,
    pythonVersion: options.pythonVersion,
    pythonStandaloneRelease: options.pythonStandaloneRelease,
    windowsGitVersion:
      options.targetPlatform === "windows-amd64"
        ? options.windowsGitVersion
        : "",
    ffmpegReleaseTag: options.ffmpegReleaseTag,
    nodeAssetVersion,
    nodeDependencies: NODE_DEPENDENCIES,
    pythonRequirements: PYTHON_REQUIREMENTS,
    managedProviders: managedProviders.map((provider) => ({
      slug: provider.slug,
      displayName: provider.displayName,
      runtimeType: provider.runtimeType,
      version: provider.version,
    })),
    managedCapabilities: managedCapabilities.map((capability) => ({
      provider: capability.provider,
      slug: capability.slug,
      command: capability.command,
      module: capability.module,
      version: capability.version,
      unavailableReason: capability.unavailableReason,
      probe: capability.probe,
      supportedTargets: capability.supportedTargets,
      extraPythonRequirements: capability.extraPythonRequirements,
      pythonPaths: capability.pythonPaths,
    })),
  })}`
}

async function loadSharedNodeManifest(relayRoot, targetPlatform, nodeVersion) {
  const manifestPath = join(
    relayRoot,
    "internal",
    "nodebundle",
    "assets",
    "manifest.json"
  )
  const expectedAssetVersion = getSharedNodeAssetVersion(
    targetPlatform,
    nodeVersion
  )
  let manifest

  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  } catch (error) {
    throw new Error(
      `shared Node bundle is missing; run prepare-node-bundle first (${error instanceof Error ? error.message : String(error)})`
    )
  }

  if (
    !manifest?.prepared ||
    manifest.platform !== targetPlatform ||
    manifest.assetVersion !== expectedAssetVersion ||
    !manifest.nodeBinary
  ) {
    throw new Error(
      `shared Node bundle is not ready for ${targetPlatform} (${expectedAssetVersion}); run prepare-node-bundle first`
    )
  }

  return manifest
}

function getPythonSpec(targetPlatform, pythonVersion, releaseTag) {
  const target = PYTHON_DISTRIBUTIONS[targetPlatform]
  if (!target) {
    throw new Error(`unsupported target platform ${targetPlatform}`)
  }

  const archiveFileName = `cpython-${pythonVersion}+${releaseTag}-${target.distribution}.tar.gz`
  return {
    archiveType: "tar",
    archiveFileName,
    pipPlatform: target.pipPlatform,
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${releaseTag}/${archiveFileName}`,
  }
}

function getWindowsGitSpec(version) {
  const portableVersion = version.replace(/\.windows\.\d+$/, "")
  return {
    archiveType: "7z",
    archiveFileName: `PortableGit-${portableVersion}-64-bit.7z.exe`,
    url: `https://github.com/git-for-windows/git/releases/download/v${version}/PortableGit-${portableVersion}-64-bit.7z.exe`,
  }
}

function getFFmpegSpec(targetPlatform, releaseTag) {
  const target = FFMPEG_DISTRIBUTIONS[targetPlatform]
  if (!target) {
    throw new Error(`unsupported FFmpeg target platform ${targetPlatform}`)
  }

  return {
    ffmpegFileName: target.ffmpegAsset,
    ffprobeFileName: target.ffprobeAsset,
    ffmpegURL: `https://github.com/shaka-project/static-ffmpeg-binaries/releases/download/${releaseTag}/${target.ffmpegAsset}`,
    ffprobeURL: `https://github.com/shaka-project/static-ffmpeg-binaries/releases/download/${releaseTag}/${target.ffprobeAsset}`,
  }
}

async function downloadFile(url, destinationPath) {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(
      `download failed for ${url}: ${response.status} ${response.statusText}`
    )
  }

  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destinationPath)
  )
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const commandLabel = [command, ...args].join(" ")
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", (error) => {
      rejectCommand(
        new Error(
          `${commandLabel} failed to start: ${error instanceof Error ? error.message : String(error)}`
        )
      )
    })
    child.on("close", (code) => {
      if (code === 0) {
        resolveCommand({ stdout, stderr })
        return
      }
      rejectCommand(
        new Error(
          `${commandLabel} failed with exit code ${code}\n${stderr || stdout}`
        )
      )
    })
  })
}

async function extractArchive(archivePath, destinationPath, archiveType) {
  if (archiveType === "tar") {
    await runCommand("tar", ["-xf", archivePath, "-C", destinationPath], {
      shell: process.platform === "win32",
    })
    return
  }

  if (archiveType === "zip") {
    if (process.platform === "win32") {
      await runCommand(
        "powershell",
        [
          "-NoLogo",
          "-NoProfile",
          "-Command",
          "Expand-Archive -LiteralPath $env:ARCHIVE -DestinationPath $env:DEST -Force",
        ],
        {
          env: {
            ...process.env,
            ARCHIVE: archivePath,
            DEST: destinationPath,
          },
        }
      )
      return
    }

    await runCommand("unzip", ["-q", archivePath, "-d", destinationPath])
    return
  }

  if (archiveType === "7z") {
    if (
      process.platform === "win32" &&
      archivePath.toLowerCase().endsWith(".exe")
    ) {
      await runCommand(archivePath, [`-o${destinationPath}`, "-y"])
      return
    }

    await runCommand("7z", ["x", archivePath, `-o${destinationPath}`, "-y"], {
      shell: process.platform === "win32",
    })
    return
  }

  throw new Error(`unsupported archive type ${archiveType}`)
}

async function ensureExists(path) {
  try {
    await stat(path)
  } catch {
    throw new Error(`expected file is missing: ${path}`)
  }
}

async function writeNodePackage(directory) {
  const packageJsonPath = join(directory, "package.json")
  const packageJson = {
    name: "synapse-relay-commandline-node",
    private: true,
    version: "1.0.0",
    type: "commonjs",
    dependencies: NODE_DEPENDENCIES,
  }

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
  await runCommand(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-fund", "--no-audit"],
    {
      cwd: directory,
      shell: process.platform === "win32",
    }
  )
}

async function installPythonPackages(
  targetPlatform,
  pythonVersion,
  targetDirectory
) {
  const pythonSpec = PYTHON_DISTRIBUTIONS[targetPlatform]
  if (!pythonSpec) {
    throw new Error(`unsupported target platform ${targetPlatform}`)
  }

  const hostPython =
    process.env.PYTHON || (process.platform === "win32" ? "python" : "python3")
  const requirementsPath = join(targetDirectory, "requirements.txt")
  await writeFile(requirementsPath, `${PYTHON_REQUIREMENTS.join("\n")}\n`)

  await runCommand(
    hostPython,
    [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--no-compile",
      "--only-binary=:all:",
      "--implementation",
      "cp",
      "--python-version",
      pythonVersion.split(".").slice(0, 2).join("."),
      "--abi",
      `cp${pythonVersion.split(".").slice(0, 2).join("")}`,
      "--platform",
      pythonSpec.pipPlatform,
      "--target",
      targetDirectory,
      "-r",
      requirementsPath,
    ],
    {
      shell: process.platform === "win32",
    }
  )
}

async function findFiles(rootDir, matcher) {
  const queue = [rootDir]
  const matches = []

  while (queue.length > 0) {
    const current = queue.pop()
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(entryPath)
        continue
      }
      if (matcher(entryPath, entry.name)) {
        matches.push(entryPath)
      }
    }
  }

  return matches.sort((left, right) => left.length - right.length)
}

async function findPythonRuntime(extractedDir, targetPlatform) {
  const candidates = await findFiles(extractedDir, (_entryPath, entryName) => {
    if (targetPlatform.startsWith("windows-")) {
      return entryName.toLowerCase() === "python.exe"
    }
    return entryName === "python3" || entryName === "python"
  })

  if (candidates.length === 0) {
    throw new Error("failed to locate bundled Python executable")
  }

  const normalizedCandidates = candidates.map((candidate) => ({
    raw: candidate,
    normalized: candidate.split("\\").join("/"),
  }))
  const preferred =
    (
      normalizedCandidates.find((candidate) =>
        candidate.normalized.endsWith("/bin/python3")
      ) ||
      normalizedCandidates.find((candidate) =>
        candidate.normalized.endsWith("/bin/python")
      ) ||
      normalizedCandidates[0]
    )?.raw || candidates[0]

  const runtimeRoot = targetPlatform.startsWith("windows-")
    ? dirname(preferred)
    : dirname(dirname(preferred))

  return {
    executable: preferred,
    runtimeRoot,
    binaryRelativePath: normalizeRelativePath(runtimeRoot, preferred),
  }
}

async function copyDirectory(source, target) {
  await cp(source, target, {
    recursive: true,
    dereference: true,
    force: true,
  })
}

async function pruneDirectories(rootDir, removableNames) {
  const queue = [rootDir]
  let removed = 0

  while (queue.length > 0) {
    const current = queue.pop()
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const entryPath = join(current, entry.name)
      if (removableNames.has(entry.name.toLowerCase())) {
        await rm(entryPath, { recursive: true, force: true })
        removed += 1
        continue
      }

      queue.push(entryPath)
    }
  }

  return removed
}

function normalizeRelativePath(baseDir, targetPath) {
  return relative(baseDir, targetPath).split("\\").join("/")
}

async function loadManagedProviderManifest(relayRoot) {
  const manifestPath = join(relayRoot, "managed-command-providers.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  const providers = Array.isArray(manifest?.providers) ? manifest.providers : []

  return providers
    .map((provider) => ({
      slug: String(provider.slug || "").trim(),
      displayName: String(provider.displayName || "").trim(),
      subproject: String(provider.subproject || "").trim(),
      runtime:
        provider.runtime && typeof provider.runtime === "object"
          ? provider.runtime
          : {},
      skillSource:
        provider.skillSource && typeof provider.skillSource === "object"
          ? provider.skillSource
          : null,
      capabilities: Array.isArray(provider.capabilities)
        ? provider.capabilities
            .map((capability) => ({
              slug: String(capability.slug || "").trim(),
              repoDir: String(capability.repoDir || "").trim(),
              module: String(capability.module || "").trim(),
              command: String(capability.command || "").trim(),
              skillPath: String(capability.skillPath || "").trim(),
              supportedTargets: Array.isArray(capability.supportedTargets)
                ? capability.supportedTargets
                    .map((value) => String(value || "").trim())
                    .filter(Boolean)
                : [],
              extraPythonRequirements: Array.isArray(
                capability.extraPythonRequirements
              )
                ? capability.extraPythonRequirements
                    .map((value) => String(value || "").trim())
                    .filter(Boolean)
                : [],
              pythonPaths: Array.isArray(capability.pythonPaths)
                ? capability.pythonPaths
                    .map((value) => String(value || "").trim())
                    .filter(Boolean)
                : [],
              probe:
                capability.probe && typeof capability.probe === "object"
                  ? capability.probe
                  : { type: "wrapper_only" },
            }))
            .filter((capability) => capability.slug && capability.command)
        : [],
    }))
    .filter(
      (provider) =>
        provider.slug &&
        provider.displayName &&
        provider.runtime &&
        provider.capabilities.length > 0
    )
}

async function parseCliAnythingVersion(setupPath) {
  try {
    const setupPy = await readFile(setupPath, "utf8")
    const match = setupPy.match(/version\s*=\s*["']([^"']+)["']/)
    return match?.[1]?.trim() || "1.0.0"
  } catch {
    return "1.0.0"
  }
}

function extractQuotedStrings(text) {
  const values = []
  for (const pattern of [/"([^"\n]+)"/g, /'([^'\n]+)'/g]) {
    let match
    while ((match = pattern.exec(text)) !== null) {
      values.push(match[1])
    }
  }
  return values
}

function parseCliAnythingEntryPoint(setupPy, commandName, fallbackModuleName) {
  const entries = extractQuotedStrings(setupPy)
    .filter((value) => value.includes("=") && value.includes("cli-anything"))
    .map((value) => {
      const [name, target] = value.split("=", 2).map((part) => part.trim())
      return { name, target }
    })
    .filter((entry) => entry.name && entry.target)

  const chosen =
    entries.find((entry) => entry.name === commandName) || entries[0]
  if (!chosen || !chosen.target.includes(":")) {
    return {
      scriptName: commandName,
      modulePath: `cli_anything.${fallbackModuleName}`,
      functionName: "main",
    }
  }

  const [modulePath, functionName] = chosen.target
    .split(":", 2)
    .map((part) => part.trim())
  return {
    scriptName: chosen.name,
    modulePath,
    functionName,
  }
}

function parsePyModules(setupPy) {
  const match = setupPy.match(/py_modules\s*=\s*\[([\s\S]*?)\]/)
  if (!match?.[1]) {
    return []
  }
  return extractQuotedStrings(match[1])
    .map((value) => value.trim())
    .filter(Boolean)
}

async function copyCliAnythingPackages(
  cliAnythingRoot,
  targetDirectory,
  capabilities
) {
  const copied = []
  const namespaceRoot = join(targetDirectory, "cli_anything")
  await mkdir(namespaceRoot, { recursive: true })

  for (const capability of capabilities) {
    const harnessRoot = join(
      cliAnythingRoot,
      capability.repoDir,
      "agent-harness"
    )
    const setupPath = join(harnessRoot, "setup.py")
    const setupPy = await readFile(setupPath, "utf8")
    const sourceDir = join(harnessRoot, "cli_anything", capability.module)
    await ensureExists(sourceDir)
    const targetDir = join(namespaceRoot, capability.module)
    await copyDirectory(sourceDir, targetDir)

    const pyModules = parsePyModules(setupPy)
    for (const pyModule of pyModules) {
      const sourceModulePath = join(harnessRoot, `${pyModule}.py`)
      await ensureExists(sourceModulePath)
      await copyFile(sourceModulePath, join(targetDirectory, `${pyModule}.py`))
    }

    const entryPoint = parseCliAnythingEntryPoint(
      setupPy,
      capability.command,
      capability.module
    )

    copied.push({
      ...capability,
      version: await parseCliAnythingVersion(setupPath),
      entryPointTarget: `${entryPoint.modulePath}:${entryPoint.functionName}`,
      scriptName: entryPoint.scriptName,
      pyModules,
    })
  }

  return copied
}

function cliAnythingWrapperPathListSeparator(targetPlatform) {
  return targetPlatform.startsWith("windows-") ? ";" : ":"
}

export function buildCliAnythingWrapperContent(
  pythonBinaryRelative,
  capability,
  targetPlatform
) {
  const [modulePath, functionName] = String(
    capability.entryPointTarget || ""
  ).split(":", 2)
  const pathListSeparator = cliAnythingWrapperPathListSeparator(targetPlatform)
  const pythonPaths = Array.isArray(capability.pythonPaths)
    ? capability.pythonPaths
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    : []
  const pythonCode = [
    "import importlib, sys",
    ...(pythonPaths.length > 0
      ? [
          `sys.path[:0] = [${pythonPaths.map((value) => JSON.stringify(value)).join(", ")}]`,
        ]
      : []),
    `sys.argv[0] = ${JSON.stringify(capability.command)}`,
    `module = importlib.import_module(${JSON.stringify(modulePath || `cli_anything.${capability.module}`)})`,
    `raise SystemExit(getattr(module, ${JSON.stringify(functionName || "main")})())`,
  ].join("; ")

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"',
    `PYTHON_BIN="${"$"}ROOT_DIR/${pythonBinaryRelative}"`,
    `export PYTHONHOME="${"$"}{ROOT_DIR}/${COMMANDLINE_PYTHON_HOME_DIR}"`,
    'if [ -n "${PYTHONPATH:-}" ]; then',
    `  export PYTHONPATH="${"$"}{ROOT_DIR}/${COMMANDLINE_PYTHON_SITE_PACKAGES_DIR}${pathListSeparator}${"$"}{PYTHONPATH}"`,
    "else",
    `  export PYTHONPATH="${"$"}{ROOT_DIR}/${COMMANDLINE_PYTHON_SITE_PACKAGES_DIR}"`,
    "fi",
    "export PYTHONUTF8=1",
    `exec "${"$"}PYTHON_BIN" -c '${pythonCode}' "${"$"}@"`,
    "",
  ].join("\n")
}

async function writeCliAnythingWrappers(
  assetsDir,
  pythonBinaryRelative,
  capabilities,
  targetPlatform
) {
  const managedBinDir = join(assetsDir, COMMANDLINE_MANAGED_BIN_DIR)
  await mkdir(managedBinDir, { recursive: true })

  const wrapperPaths = []
  for (const capability of capabilities) {
    const wrapperPath = join(managedBinDir, capability.command)
    await writeFile(
      wrapperPath,
      buildCliAnythingWrapperContent(
        pythonBinaryRelative,
        capability,
        targetPlatform
      ),
      "utf8"
    )
    if (!targetPlatform.startsWith("windows-")) {
      await runCommand("chmod", ["755", wrapperPath])
    }
    wrapperPaths.push(normalizeRelativePath(assetsDir, wrapperPath))
  }

  return {
    managedBinDir: COMMANDLINE_MANAGED_BIN_DIR,
    wrapperPaths,
  }
}

function packageNamePath(packageName) {
  return packageName.split("/").filter(Boolean).join("/")
}

async function installManagedNodePackages(
  directory,
  providers,
  targetPlatform
) {
  const packageSpecs = providers
    .filter(
      (provider) =>
        provider.runtime?.type === "npm_package" &&
        runtimeSupportsTarget(provider.runtime, targetPlatform)
    )
    .map((provider) => ({
      packageName: String(provider.runtime.packageName || "").trim(),
      packageVersion: String(provider.runtime.packageVersion || "").trim(),
    }))
    .filter((entry) => entry.packageName && entry.packageVersion)
    .map((entry) => `${entry.packageName}@${entry.packageVersion}`)

  if (packageSpecs.length === 0) {
    return
  }

  await runCommand(
    "npm",
    ["install", "--omit=dev", "--no-fund", "--no-audit", ...packageSpecs],
    {
      cwd: directory,
      shell: process.platform === "win32",
    }
  )
}

function buildManagedNodeWrapperContent(scriptRelativePath, targetPlatform) {
  const pathListSeparator = cliAnythingWrapperPathListSeparator(targetPlatform)
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"',
    'if [ -n "${NODE_PATH:-}" ]; then',
    `  export NODE_PATH="${"$"}{ROOT_DIR}/${COMMANDLINE_NODE_MODULES_DIR}${pathListSeparator}${"$"}{NODE_PATH}"`,
    "else",
    `  export NODE_PATH="${"$"}{ROOT_DIR}/${COMMANDLINE_NODE_MODULES_DIR}"`,
    "fi",
    `exec node "${"$"}ROOT_DIR/${scriptRelativePath}" "${"$"}@"`,
    "",
  ].join("\n")
}

async function writeManagedNodeWrappers(assetsDir, providers, targetPlatform) {
  const managedBinDir = join(assetsDir, COMMANDLINE_MANAGED_BIN_DIR)
  await mkdir(managedBinDir, { recursive: true })

  const wrapperPaths = []
  const managedProviders = []
  const managedCapabilities = []

  for (const provider of providers) {
    if (
      provider.runtime?.type !== "npm_package" ||
      !runtimeSupportsTarget(provider.runtime, targetPlatform)
    ) {
      continue
    }
    const packageName = String(provider.runtime.packageName || "").trim()
    const packageVersion = String(provider.runtime.packageVersion || "").trim()
    const runner = String(provider.runtime.runner || "").trim()
    if (!packageName || !packageVersion || !runner) {
      continue
    }

    const scriptRelativePath = `${COMMANDLINE_NODE_MODULES_DIR}/${packageNamePath(packageName)}/${runner}`
    managedProviders.push({
      slug: provider.slug,
      displayName: provider.displayName,
      runtimeType: provider.runtime.type,
      version: packageVersion,
    })

    for (const capability of provider.capabilities) {
      const wrapperPath = join(managedBinDir, capability.command)
      await writeFile(
        wrapperPath,
        buildManagedNodeWrapperContent(scriptRelativePath, targetPlatform),
        "utf8"
      )
      if (!targetPlatform.startsWith("windows-")) {
        await runCommand("chmod", ["755", wrapperPath])
      }
      wrapperPaths.push(normalizeRelativePath(assetsDir, wrapperPath))
      managedCapabilities.push({
        provider: provider.slug,
        providerDisplayName: provider.displayName,
        slug: capability.slug,
        command: capability.command,
        module: capability.module,
        version: packageVersion,
        probe: capability.probe,
      })
    }
  }

  return {
    wrapperPaths,
    managedProviders,
    managedCapabilities,
  }
}

function buildManagedPythonEntrypointWrapperContent(
  pythonBinaryRelative,
  capability,
  targetPlatform
) {
  const [modulePath, functionName] = String(
    capability.entryPointTarget || ""
  ).split(":", 2)
  const pathListSeparator = cliAnythingWrapperPathListSeparator(targetPlatform)
  const pythonCode = [
    "import importlib, sys",
    `sys.argv[0] = ${JSON.stringify(capability.command)}`,
    `module = importlib.import_module(${JSON.stringify(modulePath)})`,
    `raise SystemExit(getattr(module, ${JSON.stringify(functionName || "main")})())`,
  ].join("; ")

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"',
    `PYTHON_BIN="${"$"}ROOT_DIR/${pythonBinaryRelative}"`,
    `export PYTHONHOME="${"$"}{ROOT_DIR}/${COMMANDLINE_PYTHON_HOME_DIR}"`,
    'if [ -n "${PYTHONPATH:-}" ]; then',
    `  export PYTHONPATH="${"$"}{ROOT_DIR}/${COMMANDLINE_PYTHON_SITE_PACKAGES_DIR}${pathListSeparator}${"$"}{PYTHONPATH}"`,
    "else",
    `  export PYTHONPATH="${"$"}{ROOT_DIR}/${COMMANDLINE_PYTHON_SITE_PACKAGES_DIR}"`,
    "fi",
    "export PYTHONUTF8=1",
    `exec "${"$"}PYTHON_BIN" -c '${pythonCode}' "${"$"}@"`,
    "",
  ].join("\n")
}

function resolveManagedPythonInstallSpec(provider, providerRoots) {
  const packageName = String(provider.runtime.packageName || "").trim()
  const packageVersion = String(provider.runtime.packageVersion || "").trim()
  const source = String(provider.runtime.source || "")
    .trim()
    .toLowerCase()
  if (source === "subproject") {
    const providerRoot = provider.subproject
      ? providerRoots.get(provider.slug)
      : ""
    if (!providerRoot) {
      throw new Error(
        `missing subproject checkout for python provider ${provider.slug}`
      )
    }
    return {
      installSpec: providerRoot,
      version: packageVersion || "bundled",
      allowSourceDists: true,
    }
  }
  if (!packageName || !packageVersion) {
    return null
  }
  return {
    installSpec: `${packageName}==${packageVersion}`,
    version: packageVersion,
    allowSourceDists: false,
  }
}

async function installManagedPythonPackages(
  targetPlatform,
  pythonVersion,
  targetDirectory,
  providers,
  providerRoots
) {
  const pythonSpec = PYTHON_DISTRIBUTIONS[targetPlatform]
  if (!pythonSpec) {
    throw new Error(`unsupported target platform ${targetPlatform}`)
  }

  const hostPython =
    process.env.PYTHON || (process.platform === "win32" ? "python" : "python3")
  for (const provider of providers) {
    if (
      provider.runtime?.type !== "python_package" ||
      !runtimeSupportsTarget(provider.runtime, targetPlatform)
    ) {
      continue
    }
    const installSpec = resolveManagedPythonInstallSpec(provider, providerRoots)
    if (!installSpec) {
      continue
    }
    console.log(
      `Installing ${provider.displayName} ${installSpec.version} for ${targetPlatform}`
    )
    const pipArgs = [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--no-compile",
      "--upgrade",
      "--target",
      targetDirectory,
    ]
    const shouldAllowSourceDists =
      installSpec.allowSourceDists &&
      targetPlatform === getNativeTargetPlatform()
    if (!shouldAllowSourceDists) {
      pipArgs.push(
        "--only-binary=:all:",
        "--implementation",
        "cp",
        "--python-version",
        pythonVersion.split(".").slice(0, 2).join("."),
        "--abi",
        `cp${pythonVersion.split(".").slice(0, 2).join("")}`,
        "--platform",
        pythonSpec.pipPlatform
      )
    }
    pipArgs.push(installSpec.installSpec)
    await runCommand(hostPython, pipArgs, {
      shell: process.platform === "win32",
    })
  }
}

async function installCliAnythingExtraPythonPackages(
  targetPlatform,
  pythonVersion,
  targetDirectory,
  capabilities
) {
  const pythonSpec = PYTHON_DISTRIBUTIONS[targetPlatform]
  if (!pythonSpec) {
    throw new Error(`unsupported target platform ${targetPlatform}`)
  }

  const requirements = uniqueStrings(
    capabilities.flatMap((capability) =>
      Array.isArray(capability.extraPythonRequirements)
        ? capability.extraPythonRequirements
        : []
    )
  )
  if (requirements.length === 0) {
    return
  }

  const hostPython =
    process.env.PYTHON || (process.platform === "win32" ? "python" : "python3")
  const pipArgs = [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--no-compile",
    "--upgrade",
    "--target",
    targetDirectory,
  ]

  if (targetPlatform !== getNativeTargetPlatform()) {
    pipArgs.push(
      "--only-binary=:all:",
      "--implementation",
      "cp",
      "--python-version",
      pythonVersion.split(".").slice(0, 2).join("."),
      "--abi",
      `cp${pythonVersion.split(".").slice(0, 2).join("")}`,
      "--platform",
      pythonSpec.pipPlatform
    )
  }

  pipArgs.push(...requirements)
  console.log(
    `Installing CLI-Anything extra Python packages for ${targetPlatform}: ${requirements.join(", ")}`
  )
  await runCommand(hostPython, pipArgs, {
    shell: process.platform === "win32",
  })
}

async function writeManagedPythonPackageWrappers(
  assetsDir,
  pythonBinaryRelative,
  providers,
  targetPlatform
) {
  const managedBinDir = join(assetsDir, COMMANDLINE_MANAGED_BIN_DIR)
  await mkdir(managedBinDir, { recursive: true })

  const wrapperPaths = []
  const managedProviders = []
  const managedCapabilities = []

  for (const provider of providers) {
    if (
      provider.runtime?.type !== "python_package" ||
      !runtimeSupportsTarget(provider.runtime, targetPlatform)
    ) {
      continue
    }
    const packageVersion = String(provider.runtime.packageVersion || "").trim()
    const entryPointTarget = String(
      provider.runtime.entryPointTarget || ""
    ).trim()
    if (!packageVersion || !entryPointTarget) {
      continue
    }

    managedProviders.push({
      slug: provider.slug,
      displayName: provider.displayName,
      runtimeType: provider.runtime.type,
      version: packageVersion,
    })

    for (const capability of provider.capabilities) {
      const wrapperPath = join(managedBinDir, capability.command)
      await writeFile(
        wrapperPath,
        buildManagedPythonEntrypointWrapperContent(
          pythonBinaryRelative,
          {
            ...capability,
            entryPointTarget,
          },
          targetPlatform
        ),
        "utf8"
      )
      if (!targetPlatform.startsWith("windows-")) {
        await runCommand("chmod", ["755", wrapperPath])
      }
      wrapperPaths.push(normalizeRelativePath(assetsDir, wrapperPath))
      managedCapabilities.push({
        provider: provider.slug,
        providerDisplayName: provider.displayName,
        slug: capability.slug,
        command: capability.command,
        module: capability.module,
        version: packageVersion,
        probe: capability.probe,
      })
    }
  }

  return {
    wrapperPaths,
    managedProviders,
    managedCapabilities,
  }
}

function getReleaseArchiveExtension(targetPlatform) {
  return targetPlatform.startsWith("windows-") ? "zip" : "tar.gz"
}

function getReleaseBinaryFileName(binaryName, targetPlatform) {
  return targetPlatform.startsWith("windows-")
    ? `${binaryName}.exe`
    : binaryName
}

function inferArchiveType(archiveFileName) {
  const normalized = String(archiveFileName || "")
    .trim()
    .toLowerCase()
  if (normalized.endsWith(".zip")) {
    return "zip"
  }
  if (normalized.endsWith(".tar.gz") || normalized.endsWith(".tgz")) {
    return "tar"
  }
  throw new Error(`unsupported release archive ${archiveFileName}`)
}

export function getReleaseBinarySpec(targetPlatform, runtime) {
  const repository = String(runtime.repository || "").trim()
  const releaseVersion = String(runtime.releaseVersion || "").trim()
  const binaryName = String(runtime.binaryName || "").trim()
  const runtimeType = String(runtime.type || "").trim()
  const [os, arch] = targetPlatform.split("-", 2)
  if (
    !repository ||
    !releaseVersion ||
    !binaryName ||
    !runtimeType ||
    !os ||
    !arch
  ) {
    throw new Error(
      `invalid release binary runtime definition for ${repository || binaryName || "provider"}`
    )
  }
  const archiveFileNames =
    runtime.archiveFileNames && typeof runtime.archiveFileNames === "object"
      ? runtime.archiveFileNames
      : {}
  const overrideArchiveFileName = String(
    archiveFileNames[targetPlatform] || ""
  ).trim()
  const archiveExt = getReleaseArchiveExtension(targetPlatform)
  const archiveFileName =
    overrideArchiveFileName || `${binaryName}-${os}-${arch}.${archiveExt}`
  let url = ""
  switch (runtimeType) {
    case "github_release_binary":
      url = `https://github.com/${repository}/releases/download/${releaseVersion}/${archiveFileName}`
      break
    case "gitlab_release_binary":
      url = `https://gitlab.com/${repository}/-/releases/${releaseVersion}/downloads/${archiveFileName}`
      break
    default:
      throw new Error(`unsupported release binary runtime type ${runtimeType}`)
  }
  return {
    repository,
    releaseVersion,
    binaryName,
    archiveType: inferArchiveType(archiveFileName),
    archiveFileName,
    binaryFileName:
      String(runtime.binaryFileName || "").trim() ||
      getReleaseBinaryFileName(binaryName, targetPlatform),
    url,
  }
}

function buildManagedBinaryWrapperContent(binaryRelativePath) {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"',
    `exec "${"$"}ROOT_DIR/${binaryRelativePath}" "${"$"}@"`,
    "",
  ].join("\n")
}

async function installManagedReleaseBinaryProviders(
  workDir,
  assetsDir,
  providers,
  targetPlatform
) {
  const managedBinDir = join(assetsDir, COMMANDLINE_MANAGED_BIN_DIR)
  await mkdir(managedBinDir, { recursive: true })

  const wrapperPaths = []
  const bundledBinaryPaths = []
  const managedProviders = []
  const managedCapabilities = []

  for (const provider of providers) {
    if (
      !["github_release_binary", "gitlab_release_binary"].includes(
        String(provider.runtime?.type || "")
      ) ||
      !runtimeSupportsTarget(provider.runtime, targetPlatform)
    ) {
      continue
    }

    const spec = getReleaseBinarySpec(targetPlatform, provider.runtime)
    const archivePath = join(workDir, spec.archiveFileName)
    const extractDir = join(workDir, `${provider.slug}-extract`)
    await mkdir(extractDir, { recursive: true })

    console.log(
      `Downloading ${provider.displayName} ${spec.releaseVersion} for ${targetPlatform}`
    )
    await downloadFile(spec.url, archivePath)
    await extractArchive(archivePath, extractDir, spec.archiveType)

    const binaryCandidates = await findFiles(
      extractDir,
      (_entryPath, entryName) =>
        entryName.toLowerCase() === spec.binaryFileName.toLowerCase()
    )
    const sourceBinary = binaryCandidates[0]
    if (!sourceBinary) {
      throw new Error(
        `failed to locate ${spec.binaryFileName} for ${provider.slug}`
      )
    }

    const providerDir = join(assetsDir, COMMANDLINE_PROVIDER_DIR, provider.slug)
    await mkdir(providerDir, { recursive: true })
    const targetBinaryPath = join(providerDir, spec.binaryFileName)
    await copyFile(sourceBinary, targetBinaryPath)
    const binaryRelativePath = normalizeRelativePath(
      assetsDir,
      targetBinaryPath
    )
    bundledBinaryPaths.push(binaryRelativePath)

    managedProviders.push({
      slug: provider.slug,
      displayName: provider.displayName,
      runtimeType: provider.runtime.type,
      version: spec.releaseVersion,
    })

    for (const capability of provider.capabilities) {
      const wrapperPath = join(managedBinDir, capability.command)
      await writeFile(
        wrapperPath,
        buildManagedBinaryWrapperContent(binaryRelativePath),
        "utf8"
      )
      if (!targetPlatform.startsWith("windows-")) {
        await runCommand("chmod", ["755", wrapperPath])
        await runCommand("chmod", ["755", targetBinaryPath])
      }
      wrapperPaths.push(normalizeRelativePath(assetsDir, wrapperPath))
      managedCapabilities.push({
        provider: provider.slug,
        providerDisplayName: provider.displayName,
        slug: capability.slug,
        command: capability.command,
        module: capability.module,
        version: spec.releaseVersion,
        probe: capability.probe,
      })
    }
  }

  return {
    wrapperPaths,
    bundledBinaryPaths,
    managedProviders,
    managedCapabilities,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const relayRoot = resolve(scriptDir, "..")
  const repoRoot = resolve(relayRoot, "..")
  const assetsDir = join(relayRoot, "internal", "commandlinebundle", "assets")
  const workDir = await mkdtemp(join(tmpdir(), "commandlinebundle-"))

  try {
    const managedProviderManifest = await loadManagedProviderManifest(relayRoot)
    const providerRoots = new Map()
    for (const provider of managedProviderManifest) {
      if (!provider.subproject) {
        continue
      }
      providerRoots.set(
        provider.slug,
        await resolveRequiredSubprojectRoot(repoRoot, provider.subproject)
      )
    }
    const cliAnythingProvider = managedProviderManifest.find(
      (provider) => provider.slug === "cli-anything"
    )
    const cliAnythingRoot = cliAnythingProvider
      ? providerRoots.get(cliAnythingProvider.slug)
      : ""
    const cliAnythingCapabilities = cliAnythingProvider?.capabilities || []
    const activeCliAnythingCapabilities = cliAnythingCapabilities.filter(
      (capability) =>
        capabilitySupportsTarget(capability, options.targetPlatform)
    )
    const pythonSpec = getPythonSpec(
      options.targetPlatform,
      options.pythonVersion,
      options.pythonStandaloneRelease
    )
    const ffmpegSpec = getFFmpegSpec(
      options.targetPlatform,
      options.ffmpegReleaseTag
    )
    const sharedNodeManifest = await loadSharedNodeManifest(
      relayRoot,
      options.targetPlatform,
      options.nodeVersion
    )

    const nodePackageDir = join(workDir, "node-packages")
    const pythonArchivePath = join(workDir, pythonSpec.archiveFileName)
    const pythonExtractDir = join(workDir, "python-extract")
    const pythonPackageDir = join(workDir, "python-site-packages")
    const gitExtractDir = join(workDir, "git-extract")
    const ffmpegDownloadDir = join(workDir, "ffmpeg-downloads")

    await mkdir(nodePackageDir, { recursive: true })
    await mkdir(pythonExtractDir, { recursive: true })
    await mkdir(pythonPackageDir, { recursive: true })
    await mkdir(gitExtractDir, { recursive: true })
    await mkdir(ffmpegDownloadDir, { recursive: true })

    console.log(`Preparing bundled Node packages (${options.packageProfile})`)
    await writeNodePackage(nodePackageDir)
    await installManagedNodePackages(
      nodePackageDir,
      managedProviderManifest,
      options.targetPlatform
    )

    console.log(
      `Downloading Python ${options.pythonVersion} standalone runtime for ${options.targetPlatform}`
    )
    await downloadFile(pythonSpec.url, pythonArchivePath)
    await extractArchive(
      pythonArchivePath,
      pythonExtractDir,
      pythonSpec.archiveType
    )

    console.log(
      `Installing bundled Python packages (${options.packageProfile})`
    )
    await installPythonPackages(
      options.targetPlatform,
      options.pythonVersion,
      pythonPackageDir
    )
    await installManagedPythonPackages(
      options.targetPlatform,
      options.pythonVersion,
      pythonPackageDir,
      managedProviderManifest,
      providerRoots
    )
    await installCliAnythingExtraPythonPackages(
      options.targetPlatform,
      options.pythonVersion,
      pythonPackageDir,
      activeCliAnythingCapabilities
    )

    const ffmpegDownloadPath = join(
      ffmpegDownloadDir,
      ffmpegSpec.ffmpegFileName
    )
    const ffprobeDownloadPath = join(
      ffmpegDownloadDir,
      ffmpegSpec.ffprobeFileName
    )

    console.log(
      `Downloading FFmpeg tools (${options.ffmpegReleaseTag}) for ${options.targetPlatform}`
    )
    await downloadFile(ffmpegSpec.ffmpegURL, ffmpegDownloadPath)
    await downloadFile(ffmpegSpec.ffprobeURL, ffprobeDownloadPath)

    let gitBinary = ""
    let bashBinary = ""

    await rm(assetsDir, { recursive: true, force: true })
    await mkdir(assetsDir, { recursive: true })

    await copyDirectory(
      join(nodePackageDir, "node_modules"),
      join(assetsDir, COMMANDLINE_NODE_MODULES_DIR)
    )
    await copyFile(
      join(nodePackageDir, "package.json"),
      join(assetsDir, COMMANDLINE_NODE_MODULES_DIR, "package.json")
    )
    const nodeLockPath = join(nodePackageDir, "package-lock.json")
    if (
      await stat(nodeLockPath)
        .then(() => true)
        .catch(() => false)
    ) {
      await copyFile(
        nodeLockPath,
        join(assetsDir, COMMANDLINE_NODE_MODULES_DIR, "package-lock.json")
      )
    }
    const prunedNodeDirs = await pruneDirectories(
      join(assetsDir, COMMANDLINE_NODE_MODULES_DIR),
      NODE_MODULE_PRUNE_DIRS
    )
    if (prunedNodeDirs > 0) {
      console.log(
        `Pruned ${prunedNodeDirs} non-runtime Node module directories`
      )
    }

    const {
      executable: sourcePythonBinary,
      runtimeRoot: pythonRuntimeRoot,
      binaryRelativePath: pythonBinaryPathInsideRuntime,
    } = await findPythonRuntime(pythonExtractDir, options.targetPlatform)
    await ensureExists(sourcePythonBinary)
    await copyDirectory(
      pythonRuntimeRoot,
      join(assetsDir, COMMANDLINE_PYTHON_HOME_DIR)
    )
    await copyDirectory(
      pythonPackageDir,
      join(assetsDir, COMMANDLINE_PYTHON_SITE_PACKAGES_DIR)
    )
    const prunedPythonDirs = await pruneDirectories(
      join(assetsDir, COMMANDLINE_PYTHON_SITE_PACKAGES_DIR),
      PYTHON_PACKAGE_PRUNE_DIRS
    )
    if (prunedPythonDirs > 0) {
      console.log(
        `Pruned ${prunedPythonDirs} non-runtime Python package directories`
      )
    }
    let bundledCliAnythingCapabilities = []
    if (cliAnythingRoot && activeCliAnythingCapabilities.length > 0) {
      console.log(
        `Bundling CLI-Anything packages (${activeCliAnythingCapabilities.length} capabilities)`
      )
      bundledCliAnythingCapabilities = await copyCliAnythingPackages(
        cliAnythingRoot,
        join(assetsDir, COMMANDLINE_PYTHON_SITE_PACKAGES_DIR),
        activeCliAnythingCapabilities
      )
    }
    await rm(
      join(assetsDir, COMMANDLINE_PYTHON_HOME_DIR, "share", "terminfo"),
      { recursive: true, force: true }
    )

    const ffmpegBinary = options.targetPlatform.startsWith("windows-")
      ? `${COMMANDLINE_FFMPEG_DIR}/ffmpeg.exe`
      : `${COMMANDLINE_FFMPEG_DIR}/ffmpeg`
    const ffprobeBinary = options.targetPlatform.startsWith("windows-")
      ? `${COMMANDLINE_FFMPEG_DIR}/ffprobe.exe`
      : `${COMMANDLINE_FFMPEG_DIR}/ffprobe`
    await mkdir(join(assetsDir, COMMANDLINE_FFMPEG_DIR), { recursive: true })
    await copyFile(ffmpegDownloadPath, join(assetsDir, ffmpegBinary))
    await copyFile(ffprobeDownloadPath, join(assetsDir, ffprobeBinary))

    const pythonBinaryTarget = join(
      assetsDir,
      COMMANDLINE_PYTHON_HOME_DIR,
      pythonBinaryPathInsideRuntime
        .split("/")
        .join(process.platform === "win32" ? "\\" : "/")
    )
    if (!pythonBinaryTarget) {
      throw new Error(
        "failed to locate bundled Python executable after copying runtime"
      )
    }

    const pythonBinaryRelative = normalizeRelativePath(
      assetsDir,
      pythonBinaryTarget
    )
    const cliAnythingWrapperResult = await writeCliAnythingWrappers(
      assetsDir,
      pythonBinaryRelative,
      bundledCliAnythingCapabilities,
      options.targetPlatform
    )
    const managedNodeWrapperResult = await writeManagedNodeWrappers(
      assetsDir,
      managedProviderManifest,
      options.targetPlatform
    )
    const managedPythonWrapperResult = await writeManagedPythonPackageWrappers(
      assetsDir,
      pythonBinaryRelative,
      managedProviderManifest,
      options.targetPlatform
    )
    const managedReleaseBinaryResult =
      await installManagedReleaseBinaryProviders(
        workDir,
        assetsDir,
        managedProviderManifest,
        options.targetPlatform
      )
    const unsupportedManagedEntries = collectUnsupportedManagedEntries(
      managedProviderManifest,
      options.targetPlatform
    )

    const managedProviders = []
    if (cliAnythingProvider) {
      managedProviders.push({
        slug: cliAnythingProvider.slug,
        displayName: cliAnythingProvider.displayName,
        runtimeType: String(
          cliAnythingProvider.runtime?.type || "python_source"
        ),
        version:
          bundledCliAnythingCapabilities.length > 0
            ? resolveManagedProviderVersion(
                bundledCliAnythingCapabilities.map(
                  (capability) => capability.version
                )
              )
            : "bundled",
      })
    }
    managedProviders.push(
      ...managedNodeWrapperResult.managedProviders,
      ...managedPythonWrapperResult.managedProviders,
      ...managedReleaseBinaryResult.managedProviders,
      ...unsupportedManagedEntries.managedProviders
    )

    const managedCapabilities = [
      ...bundledCliAnythingCapabilities.map((capability) => ({
        provider: "cli-anything",
        providerDisplayName: cliAnythingProvider?.displayName || "CLI-Anything",
        slug: capability.slug,
        command: capability.command,
        module: capability.module,
        version: capability.version,
        supportedTargets: capability.supportedTargets,
        extraPythonRequirements: capability.extraPythonRequirements,
        pythonPaths: capability.pythonPaths,
        probe: capability.probe,
      })),
      ...managedNodeWrapperResult.managedCapabilities,
      ...managedPythonWrapperResult.managedCapabilities,
      ...managedReleaseBinaryResult.managedCapabilities,
      ...unsupportedManagedEntries.managedCapabilities,
    ]

    if (options.targetPlatform === "windows-amd64") {
      const gitSpec = getWindowsGitSpec(options.windowsGitVersion)
      const gitArchivePath = join(workDir, gitSpec.archiveFileName)

      console.log(`Downloading PortableGit ${options.windowsGitVersion}`)
      await downloadFile(gitSpec.url, gitArchivePath)
      await extractArchive(gitArchivePath, gitExtractDir, gitSpec.archiveType)

      const gitCandidates = await findFiles(
        gitExtractDir,
        (_entryPath, entryName) => entryName.toLowerCase() === "git.exe"
      )
      const bashCandidates = await findFiles(
        gitExtractDir,
        (_entryPath, entryName) => entryName.toLowerCase() === "bash.exe"
      )
      const sourceGitBinary =
        gitCandidates.find(
          (entry) =>
            entry.endsWith("\\cmd\\git.exe") || entry.endsWith("/cmd/git.exe")
        ) || gitCandidates[0]
      const sourceBashBinary =
        bashCandidates.find(
          (entry) =>
            entry.endsWith("\\bin\\bash.exe") || entry.endsWith("/bin/bash.exe")
        ) || bashCandidates[0]
      if (!sourceGitBinary || !sourceBashBinary) {
        throw new Error("failed to locate bundled Git Bash binaries")
      }

      const portableRoot = dirname(dirname(sourceGitBinary))
      await copyDirectory(portableRoot, join(assetsDir, COMMANDLINE_GIT_DIR))
      gitBinary = `${COMMANDLINE_GIT_DIR}/cmd/git.exe`
      bashBinary = `${COMMANDLINE_GIT_DIR}/bin/bash.exe`
    }

    const wrapperPaths = [
      ...cliAnythingWrapperResult.wrapperPaths,
      ...managedNodeWrapperResult.wrapperPaths,
      ...managedPythonWrapperResult.wrapperPaths,
      ...managedReleaseBinaryResult.wrapperPaths,
    ]
    const executables = [
      pythonBinaryRelative,
      ffmpegBinary,
      ffprobeBinary,
      ...managedReleaseBinaryResult.bundledBinaryPaths,
      ...wrapperPaths,
    ]
    if (gitBinary) {
      executables.push(gitBinary)
    }
    if (bashBinary) {
      executables.push(bashBinary)
    }

    const assetVersion = getCommandlineAssetVersion(
      options,
      sharedNodeManifest.assetVersion,
      managedProviders,
      managedCapabilities
    )

    const manifest = {
      prepared: true,
      platform: options.targetPlatform,
      nodeAssetVersion: sharedNodeManifest.assetVersion,
      nodeModulesDir: COMMANDLINE_NODE_MODULES_DIR,
      pythonHomeDir: COMMANDLINE_PYTHON_HOME_DIR,
      pythonBinary: pythonBinaryRelative,
      pythonSitePackagesDir: COMMANDLINE_PYTHON_SITE_PACKAGES_DIR,
      managedBinDir: cliAnythingWrapperResult.managedBinDir,
      ffmpegBinary,
      ffprobeBinary,
      gitBinary,
      bashBinary,
      managedProviders,
      managedCapabilities,
      packageProfile: options.packageProfile,
      ffmpegReleaseTag: options.ffmpegReleaseTag,
      assetVersion,
      executables,
    }

    await writeFile(
      join(assetsDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
    console.log(`Prepared bundled commandline runtime in ${assetsDir}`)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
