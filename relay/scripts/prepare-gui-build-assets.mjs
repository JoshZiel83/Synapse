#!/usr/bin/env node

import {
  cp,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..", "..")
const relayRoot = join(repoRoot, "relay")
const guiRoot = join(relayRoot, "cmd", "synapse-relay-gui")
const buildRoot = join(guiRoot, "build")
const windowsBuildRoot = join(buildRoot, "windows")
const windowsInstallerRoot = join(windowsBuildRoot, "installer")
const windowsRuntimeStageFile = join(windowsBuildRoot, "runtime-path.txt")
const packagingRoot = join(guiRoot, "packaging", "windows")

const args = parseArgs(process.argv.slice(2))
const goos =
  (args.goos ?? process.env.GOOS ?? "").trim().toLowerCase() || hostGoos()
const runtimeMode = (args["runtime-mode"] ?? "portable").trim().toLowerCase()
const runtimeOutput = args["runtime-output"]
  ? resolve(repoRoot, args["runtime-output"])
  : ""

await mkdir(buildRoot, { recursive: true })
await mkdir(windowsInstallerRoot, { recursive: true })

await copyPath(
  join(repoRoot, "packages", "web-next", "public", "synapse.png"),
  join(buildRoot, "appicon.png"),
  { force: true }
)

const windowsPackagedRuntime = await resolveWindowsPackagedRuntime()
await writeWindowsInstallerScript(windowsPackagedRuntime?.stagePath ?? "..\\r")

if (runtimeOutput) {
  await stageRuntimeBundles(runtimeOutput)
  if (!windowsPackagedRuntime) {
    await rm(join(windowsBuildRoot, "r"), { recursive: true, force: true })
    await rm(windowsRuntimeStageFile, { force: true })
  }
} else if (windowsPackagedRuntime) {
  await stageRuntimeBundles(windowsPackagedRuntime.physicalRoot)
  await writeFile(
    windowsRuntimeStageFile,
    `${windowsPackagedRuntime.stagePath}\n`
  )
} else {
  await rm(join(windowsBuildRoot, "r"), { recursive: true, force: true })
  await rm(windowsRuntimeStageFile, { force: true })
}

console.log(`Prepared GUI build assets for ${goos} (${runtimeMode})`)

function parseArgs(values) {
  const result = {}
  for (const value of values) {
    if (!value.startsWith("--")) {
      continue
    }
    const trimmed = value.slice(2)
    const separator = trimmed.indexOf("=")
    if (separator === -1) {
      result[trimmed] = "true"
      continue
    }
    result[trimmed.slice(0, separator)] = trimmed.slice(separator + 1)
  }
  return result
}

function hostGoos() {
  switch (process.platform) {
    case "win32":
      return "windows"
    case "darwin":
      return "darwin"
    default:
      return process.platform
  }
}

async function resolveWindowsPackagedRuntime() {
  if (goos !== "windows" || runtimeMode !== "packaged") {
    return null
  }

  if (runtimeOutput) {
    return {
      physicalRoot: runtimeOutput,
      stagePath: runtimeOutput,
    }
  }

  const physicalRoot = join(tmpdir(), "srg")
  await mkdir(physicalRoot, { recursive: true })
  const stagePath =
    process.platform === "win32"
      ? await ensureWindowsSubstDrive(physicalRoot)
      : physicalRoot

  return { physicalRoot, stagePath }
}

async function writeWindowsInstallerScript(runtimeStagePath) {
  const templatePath = join(packagingRoot, "installer", "project.nsi")
  const installerPath = join(windowsInstallerRoot, "project.nsi")
  const template = await readFile(templatePath, "utf8")
  const nsisRuntimeStagePath = runtimeStagePath.replaceAll("/", "\\")
  await writeFile(
    installerPath,
    template.replaceAll("__SYNAPSE_RUNTIME_STAGE__", nsisRuntimeStagePath)
  )
}

async function ensureWindowsSubstDrive(targetPath) {
  const candidateLetters = ["R", "S", "T", "U", "V", "W", "X", "Y", "Z"]

  for (const letter of candidateLetters) {
    const driveRoot = `${letter}:\\`
    if (await pathExists(driveRoot)) {
      continue
    }
    await runCommand("subst", [`${letter}:`, targetPath])
    if (await pathExists(driveRoot)) {
      return driveRoot
    }
  }

  throw new Error(
    `unable to allocate a free Windows SUBST drive for ${targetPath}`
  )
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
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

async function stageRuntimeBundles(runtimeRoot) {
  await rm(runtimeRoot, { recursive: true, force: true })

  await stageRuntimeBundle(
    {
      name: "node",
      sourceDir: join(relayRoot, "internal", "nodebundle", "assets"),
    },
    runtimeRoot
  )
  await stageRuntimeBundle(
    {
      name: "cl",
      sourceDir: join(relayRoot, "internal", "commandlinebundle", "assets"),
    },
    runtimeRoot
  )
  await stageRuntimeBundle(
    {
      name: "cdm",
      sourceDir: join(relayRoot, "internal", "chromemcpbundle", "assets"),
    },
    runtimeRoot
  )
}

async function stageRuntimeBundle(
  { name, sourceDir },
  runtimeRoot = join(windowsBuildRoot, "runtime")
) {
  const manifest = await readPreparedManifest(sourceDir, name)
  const bundleRoot = join(runtimeRoot, name)
  const targetDir = join(bundleRoot, manifest.assetVersion)
  await mkdir(bundleRoot, { recursive: true })
  await mkdir(targetDir, { recursive: true })

  for (const entry of await readdir(sourceDir)) {
    await copyPath(join(sourceDir, entry), join(targetDir, entry), {
      recursive: true,
      force: true,
    })
  }

  await writeFile(
    join(bundleRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  await writeFile(join(targetDir, ".ready"), manifest.assetVersion)
  console.log(`Staged runtime payload ${name}@${manifest.assetVersion}`)
}

async function readPreparedManifest(sourceDir, name) {
  const manifestPath = join(sourceDir, "manifest.json")
  const raw = await readFile(manifestPath, "utf8")
  const manifest = JSON.parse(raw)
  if (
    !manifest?.prepared ||
    !manifest?.assetVersion ||
    manifest.assetVersion === "unprepared"
  ) {
    throw new Error(
      `bundle ${name} is not prepared; run the relay bundle preparation scripts first`
    )
  }
  return manifest
}

async function copyPath(source, target, options = {}) {
  try {
    await cp(source, target, options)
    return
  } catch (error) {
    if (!["EACCES", "ENOTSUP", "EXDEV"].includes(error?.code)) {
      throw error
    }
  }

  await copyPathPortable(source, target, Boolean(options.force))
}

async function copyPathPortable(source, target, force) {
  const metadata = await lstat(source)
  if (force) {
    await rm(target, { recursive: true, force: true })
  }

  if (metadata.isDirectory()) {
    await mkdir(target, { recursive: true })
    await chmod(target, metadata.mode & 0o777).catch(() => {})
    for (const entry of await readdir(source)) {
      await copyPathPortable(join(source, entry), join(target, entry), force)
    }
    return
  }

  await mkdir(dirname(target), { recursive: true })
  if (metadata.isSymbolicLink()) {
    const linkTarget = await readlink(source)
    await symlink(linkTarget, target)
    return
  }

  const data = await readFile(source)
  await writeFile(target, data)
  await chmod(target, metadata.mode & 0o777).catch(() => {})
}
