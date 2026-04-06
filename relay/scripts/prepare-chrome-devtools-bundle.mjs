#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEFAULT_NODE_VERSION = '24.14.1'
const DEFAULT_PACKAGE_VERSION = '0.20.0'
const CHROME_DEVTOOLS_ASSET_SCHEMA_VERSION = 1
const CHROME_DEVTOOLS_ASSET_PREFIX = 'cdm'
const CHROME_DEVTOOLS_PACKAGE_DIR = 'p'

function parseArgs(argv) {
  const options = {
    targetPlatform: '',
    nodeVersion: DEFAULT_NODE_VERSION,
    packageVersion: DEFAULT_PACKAGE_VERSION,
  }

  for (const arg of argv) {
    if (arg.startsWith('--target-platform=')) {
      options.targetPlatform = arg.slice('--target-platform='.length)
      continue
    }
    if (arg.startsWith('--node-version=')) {
      options.nodeVersion = arg.slice('--node-version='.length)
      continue
    }
    if (arg.startsWith('--package-version=')) {
      options.packageVersion = arg.slice('--package-version='.length)
      continue
    }
  }

  if (!options.targetPlatform) {
    throw new Error('missing required --target-platform=<goos-goarch> argument')
  }

  return options
}

function getSharedNodeAssetVersion(targetPlatform, nodeVersion) {
  return `node-${nodeVersion}-${targetPlatform}`
}

function shortHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12)
}

function getChromeDevtoolsAssetVersion(options, nodeAssetVersion) {
  return `${CHROME_DEVTOOLS_ASSET_PREFIX}-${shortHash({
    schemaVersion: CHROME_DEVTOOLS_ASSET_SCHEMA_VERSION,
    targetPlatform: options.targetPlatform,
    packageVersion: options.packageVersion,
    nodeAssetVersion,
  })}`
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const commandLabel = [command, ...args].join(' ')
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      rejectCommand(new Error(`${commandLabel} failed to start: ${error instanceof Error ? error.message : String(error)}`))
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolveCommand({ stdout, stderr })
        return
      }
      rejectCommand(new Error(`${commandLabel} failed with exit code ${code}\n${stderr || stdout}`))
    })
  })
}

async function extractArchive(archivePath, destinationPath, archiveType) {
  if (archiveType === 'tar') {
    await runCommand('tar', ['-xf', archivePath, '-C', destinationPath], {
      shell: process.platform === 'win32',
    })
    return
  }

  if (archiveType !== 'zip') {
    throw new Error(`unsupported archive type ${archiveType}`)
  }

  if (process.platform === 'win32') {
    await runCommand(
      'powershell',
      ['-NoLogo', '-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:ARCHIVE -DestinationPath $env:DEST -Force'],
      {
        env: {
          ...process.env,
          ARCHIVE: archivePath,
          DEST: destinationPath,
        },
      },
    )
    return
  }

  await runCommand('unzip', ['-q', archivePath, '-d', destinationPath])
}

async function npmPack(packageVersion, workingDirectory) {
  const { stdout } = await runCommand(
    'npm',
    ['pack', `chrome-devtools-mcp@${packageVersion}`, '--silent'],
    {
      cwd: workingDirectory,
      shell: process.platform === 'win32',
    },
  )

  const archiveFileName = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
  if (!archiveFileName) {
    throw new Error('npm pack did not return an archive file name')
  }

  return join(workingDirectory, archiveFileName)
}

async function ensureExists(path) {
  try {
    await stat(path)
  } catch {
    throw new Error(`expected file is missing: ${path}`)
  }
}

async function loadSharedNodeManifest(relayRoot, targetPlatform, nodeVersion) {
  const manifestPath = join(relayRoot, 'internal', 'nodebundle', 'assets', 'manifest.json')
  const expectedAssetVersion = getSharedNodeAssetVersion(targetPlatform, nodeVersion)
  let manifest

  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`shared Node bundle is missing; run prepare-node-bundle first (${error instanceof Error ? error.message : String(error)})`)
  }

  if (!manifest?.prepared || manifest.platform !== targetPlatform || manifest.assetVersion !== expectedAssetVersion || !manifest.nodeBinary) {
    throw new Error(`shared Node bundle is not ready for ${targetPlatform} (${expectedAssetVersion}); run prepare-node-bundle first`)
  }

  return manifest
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const relayRoot = resolve(scriptDir, '..')
  const assetsDir = join(relayRoot, 'internal', 'chromemcpbundle', 'assets')
  const workDir = await mkdtemp(join(tmpdir(), 'chromemcpbundle-'))

  try {
    const packageExtractDir = join(workDir, 'package-extract')
    await mkdir(packageExtractDir, { recursive: true })

    const sharedNodeManifest = await loadSharedNodeManifest(relayRoot, options.targetPlatform, options.nodeVersion)

    console.log(`Packing chrome-devtools-mcp@${options.packageVersion}`)
    const packageArchivePath = await npmPack(options.packageVersion, workDir)
    await extractArchive(packageArchivePath, packageExtractDir, 'tar')

    const packageSourceDir = join(packageExtractDir, 'package')
    const entryScript = `${CHROME_DEVTOOLS_PACKAGE_DIR}/build/src/bin/chrome-devtools-mcp.js`

    await ensureExists(join(packageSourceDir, 'build', 'src', 'bin', 'chrome-devtools-mcp.js'))

    await rm(assetsDir, { recursive: true, force: true })
    await mkdir(assetsDir, { recursive: true })
    await cp(packageSourceDir, join(assetsDir, CHROME_DEVTOOLS_PACKAGE_DIR), { recursive: true })

    const manifest = {
      prepared: true,
      assetVersion: getChromeDevtoolsAssetVersion(options, sharedNodeManifest.assetVersion),
      platform: options.targetPlatform,
      nodeAssetVersion: sharedNodeManifest.assetVersion,
      packageDir: CHROME_DEVTOOLS_PACKAGE_DIR,
      entryScript,
      packageVersion: options.packageVersion,
    }

    await writeFile(join(assetsDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`Prepared bundled Chrome DevTools runtime in ${assetsDir}`)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
