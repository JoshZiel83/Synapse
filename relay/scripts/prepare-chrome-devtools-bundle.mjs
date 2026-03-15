#!/usr/bin/env node

import { createWriteStream } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, stat, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const DEFAULT_NODE_VERSION = '20.19.5'
const DEFAULT_PACKAGE_VERSION = '0.20.0'

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

async function downloadFile(url, destinationPath) {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`download failed for ${url}: ${response.status} ${response.statusText}`)
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath))
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
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
    child.on('error', rejectCommand)
    child.on('close', (code) => {
      if (code === 0) {
        resolveCommand({ stdout, stderr })
        return
      }
      rejectCommand(new Error(`${command} ${args.join(' ')} failed with exit code ${code}\n${stderr || stdout}`))
    })
  })
}

async function extractArchive(archivePath, destinationPath, archiveType) {
  if (archiveType === 'tar') {
    await runCommand('tar', ['-xf', archivePath, '-C', destinationPath])
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
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const { stdout } = await runCommand(
    npmCommand,
    ['pack', `chrome-devtools-mcp@${packageVersion}`, '--silent'],
    { cwd: workingDirectory },
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

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const relayRoot = resolve(scriptDir, '..')
  const assetsDir = join(relayRoot, 'internal', 'chromemcpbundle', 'assets')
  const workDir = await mkdtemp(join(tmpdir(), 'chromemcpbundle-'))

  try {
    const nodeSpec = getNodeSpec(options.targetPlatform, options.nodeVersion)
    const nodeArchivePath = join(workDir, nodeSpec.archiveFileName)
    const nodeExtractDir = join(workDir, 'node-extract')
    const packageExtractDir = join(workDir, 'package-extract')

    await mkdir(nodeExtractDir, { recursive: true })
    await mkdir(packageExtractDir, { recursive: true })

    console.log(`Downloading Node ${options.nodeVersion} for ${options.targetPlatform}`)
    await downloadFile(nodeSpec.url, nodeArchivePath)
    await extractArchive(nodeArchivePath, nodeExtractDir, nodeSpec.archiveType)

    console.log(`Packing chrome-devtools-mcp@${options.packageVersion}`)
    const packageArchivePath = await npmPack(options.packageVersion, workDir)
    await extractArchive(packageArchivePath, packageExtractDir, 'tar')

    const nodeSourceDir = join(nodeExtractDir, nodeSpec.rootDirName)
    const packageSourceDir = join(packageExtractDir, 'package')
    const nodeBinary = options.targetPlatform.startsWith('windows-') ? 'node/node.exe' : 'node/bin/node'
    const entryScript = 'package/build/src/bin/chrome-devtools-mcp.js'
    const sourceNodeBinary = options.targetPlatform.startsWith('windows-')
      ? join(nodeSourceDir, 'node.exe')
      : join(nodeSourceDir, 'bin', 'node')

    await ensureExists(sourceNodeBinary)
    await ensureExists(join(packageSourceDir, 'build', 'src', 'bin', 'chrome-devtools-mcp.js'))

    await rm(assetsDir, { recursive: true, force: true })
    await mkdir(assetsDir, { recursive: true })
    await mkdir(join(assetsDir, 'node', options.targetPlatform.startsWith('windows-') ? '' : 'bin'), { recursive: true })
    await copyFile(sourceNodeBinary, join(assetsDir, nodeBinary))
    try {
      await copyFile(join(nodeSourceDir, 'LICENSE'), join(assetsDir, 'node', 'LICENSE'))
    } catch {
      // Some Node distributions do not include a standalone LICENSE file.
    }
    await cp(packageSourceDir, join(assetsDir, 'package'), { recursive: true })

    const manifest = {
      prepared: true,
      assetVersion: `chrome-devtools-mcp-${options.packageVersion}-node-${options.nodeVersion}-${options.targetPlatform}`,
      platform: options.targetPlatform,
      nodeBinary,
      packageDir: 'package',
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
