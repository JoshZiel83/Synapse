#!/usr/bin/env node

import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const DEFAULT_NODE_VERSION = '24.14.1'

const NODE_DISTRIBUTIONS = {
  'linux-amd64': { archiveType: 'tar', distName: 'linux-x64', extension: 'tar.xz' },
  'linux-arm64': { archiveType: 'tar', distName: 'linux-arm64', extension: 'tar.xz' },
  'darwin-amd64': { archiveType: 'tar', distName: 'darwin-x64', extension: 'tar.gz' },
  'darwin-arm64': { archiveType: 'tar', distName: 'darwin-arm64', extension: 'tar.gz' },
  'windows-amd64': { archiveType: 'zip', distName: 'win-x64', extension: 'zip' },
}

function parseArgs(argv) {
  const options = {
    targetPlatform: '',
    nodeVersion: DEFAULT_NODE_VERSION,
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
  }

  if (!options.targetPlatform) {
    throw new Error('missing required --target-platform=<goos-goarch> argument')
  }

  return options
}

function getNodeSpec(targetPlatform, nodeVersion) {
  const target = NODE_DISTRIBUTIONS[targetPlatform]
  if (!target) {
    throw new Error(`unsupported target platform ${targetPlatform}`)
  }

  const baseName = `node-v${nodeVersion}-${target.distName}`
  return {
    archiveType: target.archiveType,
    archiveFileName: `${baseName}.${target.extension}`,
    rootDirName: baseName,
    url: `https://nodejs.org/dist/v${nodeVersion}/${baseName}.${target.extension}`,
  }
}

function getSharedNodeAssetVersion(targetPlatform, nodeVersion) {
  return `node-${nodeVersion}-${targetPlatform}`
}

async function downloadFile(url, destinationPath) {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`download failed for ${url}: ${response.status} ${response.statusText}`)
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath))
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

async function ensureExists(path) {
  try {
    await stat(path)
  } catch {
    throw new Error(`expected file is missing: ${path}`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const relayRoot = resolve(scriptDir, '..')
  const assetsDir = join(relayRoot, 'internal', 'nodebundle', 'assets')
  const workDir = await mkdtemp(join(tmpdir(), 'nodebundle-'))

  try {
    const nodeSpec = getNodeSpec(options.targetPlatform, options.nodeVersion)
    const nodeArchivePath = join(workDir, nodeSpec.archiveFileName)
    const nodeExtractDir = join(workDir, 'node-extract')

    await mkdir(nodeExtractDir, { recursive: true })

    console.log(`Downloading shared Node ${options.nodeVersion} for ${options.targetPlatform}`)
    await downloadFile(nodeSpec.url, nodeArchivePath)
    await extractArchive(nodeArchivePath, nodeExtractDir, nodeSpec.archiveType)

    const nodeSourceDir = join(nodeExtractDir, nodeSpec.rootDirName)
    const nodeBinary = options.targetPlatform.startsWith('windows-') ? 'node/node.exe' : 'node/bin/node'
    const sourceNodeBinary = options.targetPlatform.startsWith('windows-')
      ? join(nodeSourceDir, 'node.exe')
      : join(nodeSourceDir, 'bin', 'node')

    await ensureExists(sourceNodeBinary)

    await rm(assetsDir, { recursive: true, force: true })
    await mkdir(assetsDir, { recursive: true })
    await mkdir(join(assetsDir, 'node', options.targetPlatform.startsWith('windows-') ? '' : 'bin'), { recursive: true })
    await copyFile(sourceNodeBinary, join(assetsDir, nodeBinary))
    try {
      await copyFile(join(nodeSourceDir, 'LICENSE'), join(assetsDir, 'node', 'LICENSE'))
    } catch {
      // Some Node distributions do not include a standalone LICENSE file.
    }

    const manifest = {
      prepared: true,
      assetVersion: getSharedNodeAssetVersion(options.targetPlatform, options.nodeVersion),
      platform: options.targetPlatform,
      nodeBinary,
    }

    await writeFile(join(assetsDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`Prepared shared Node runtime in ${assetsDir}`)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
