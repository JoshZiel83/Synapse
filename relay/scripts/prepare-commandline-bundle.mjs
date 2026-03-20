#!/usr/bin/env node

import { createWriteStream } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const DEFAULT_NODE_VERSION = '20.19.5'
const DEFAULT_PYTHON_VERSION = '3.12.12'
const DEFAULT_PYTHON_STANDALONE_RELEASE = '20251010'
const DEFAULT_WINDOWS_GIT_VERSION = '2.49.0.windows.1'
const DEFAULT_FFMPEG_RELEASE_TAG = 'n7.1-2'
const DEFAULT_PACKAGE_PROFILE = 'default-data-v5'

const PYTHON_DISTRIBUTIONS = {
  'linux-amd64': {
    distribution: 'x86_64-unknown-linux-gnu-install_only_stripped',
    pipPlatform: 'manylinux2014_x86_64',
  },
  'linux-arm64': {
    distribution: 'aarch64-unknown-linux-gnu-install_only_stripped',
    pipPlatform: 'manylinux2014_aarch64',
  },
  'darwin-amd64': {
    distribution: 'x86_64-apple-darwin-install_only_stripped',
    pipPlatform: 'macosx_10_13_x86_64',
  },
  'darwin-arm64': {
    distribution: 'aarch64-apple-darwin-install_only_stripped',
    pipPlatform: 'macosx_11_0_arm64',
  },
  'windows-amd64': {
    distribution: 'x86_64-pc-windows-msvc-install_only_stripped',
    pipPlatform: 'win_amd64',
  },
}

const FFMPEG_DISTRIBUTIONS = {
  'linux-amd64': {
    ffmpegAsset: 'ffmpeg-linux-x64',
    ffprobeAsset: 'ffprobe-linux-x64',
  },
  'linux-arm64': {
    ffmpegAsset: 'ffmpeg-linux-arm64',
    ffprobeAsset: 'ffprobe-linux-arm64',
  },
  'darwin-amd64': {
    ffmpegAsset: 'ffmpeg-osx-x64',
    ffprobeAsset: 'ffprobe-osx-x64',
  },
  'darwin-arm64': {
    ffmpegAsset: 'ffmpeg-osx-arm64',
    ffprobeAsset: 'ffprobe-osx-arm64',
  },
  'windows-amd64': {
    ffmpegAsset: 'ffmpeg-win-x64.exe',
    ffprobeAsset: 'ffprobe-win-x64.exe',
  },
}

const NODE_DEPENDENCIES = {
  'adm-zip': '^0.5.16',
  axios: '^1.9.0',
  archiver: '^7.0.1',
  cheerio: '^1.0.0',
  'csv-parse': '^5.5.6',
  'csv-stringify': '^6.5.2',
  docx: '^9.5.0',
  exceljs: '^4.4.0',
  'extract-zip': '^2.0.1',
  'fast-xml-parser': '^4.5.0',
  'form-data': '^4.0.2',
  'image-size': '^1.2.0',
  'iconv-lite': '^0.6.3',
  ini: '^5.0.0',
  jimp: '^1.6.0',
  jszip: '^3.10.1',
  mammoth: '^1.9.1',
  'mime-types': '^2.1.35',
  'music-metadata': '^10.5.1',
  'node-id3': '^0.2.9',
  papaparse: '^5.5.3',
  'pdf-lib': '^1.17.1',
  'pdf-parse': '^1.1.1',
  pptxgenjs: '^3.12.0',
  tar: '^7.4.3',
  toml: '^3.0.0',
  unzipper: '^0.12.3',
  wavefile: '^11.0.0',
  xlsx: '^0.18.5',
  xml2js: '^0.6.2',
  yaml: '^2.5.1',
}

const PYTHON_REQUIREMENTS = [
  'aiohttp==3.10.11',
  'beautifulsoup4==4.12.3',
  'httpx==0.28.1',
  'imageio==2.36.0',
  'imageio-ffmpeg==0.6.0',
  'lxml==5.3.0',
  'mutagen==1.47.0',
  'openpyxl==3.1.5',
  'pandas==2.2.3',
  'pdfplumber==0.11.4',
  'Pillow==11.0.0',
  'pydub==0.25.1',
  'py7zr==0.22.0',
  'pyzipper==0.3.6',
  'pypdf==5.1.0',
  'pyxlsb==1.0.10',
  'qrcode==8.0',
  'python-docx==1.1.2',
  'python-pptx==1.0.2',
  'PyYAML==6.0.2',
  'requests==2.32.3',
  'tinytag==2.0.0',
  'xlrd==2.0.1',
]

function parseArgs(argv) {
  const options = {
    targetPlatform: '',
    nodeVersion: DEFAULT_NODE_VERSION,
    pythonVersion: DEFAULT_PYTHON_VERSION,
    pythonStandaloneRelease: DEFAULT_PYTHON_STANDALONE_RELEASE,
    windowsGitVersion: DEFAULT_WINDOWS_GIT_VERSION,
    ffmpegReleaseTag: DEFAULT_FFMPEG_RELEASE_TAG,
    packageProfile: DEFAULT_PACKAGE_PROFILE,
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
    if (arg.startsWith('--python-version=')) {
      options.pythonVersion = arg.slice('--python-version='.length)
      continue
    }
    if (arg.startsWith('--python-standalone-release=')) {
      options.pythonStandaloneRelease = arg.slice('--python-standalone-release='.length)
      continue
    }
    if (arg.startsWith('--windows-git-version=')) {
      options.windowsGitVersion = arg.slice('--windows-git-version='.length)
      continue
    }
    if (arg.startsWith('--ffmpeg-release-tag=')) {
      options.ffmpegReleaseTag = arg.slice('--ffmpeg-release-tag='.length)
      continue
    }
    if (arg.startsWith('--package-profile=')) {
      options.packageProfile = arg.slice('--package-profile='.length)
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

function getPythonSpec(targetPlatform, pythonVersion, releaseTag) {
  const target = PYTHON_DISTRIBUTIONS[targetPlatform]
  if (!target) {
    throw new Error(`unsupported target platform ${targetPlatform}`)
  }

  const archiveFileName = `cpython-${pythonVersion}+${releaseTag}-${target.distribution}.tar.gz`
  return {
    archiveType: 'tar',
    archiveFileName,
    pipPlatform: target.pipPlatform,
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${releaseTag}/${archiveFileName}`,
  }
}

function getWindowsGitSpec(version) {
  const portableVersion = version.replace(/\.windows\.\d+$/, '')
  return {
    archiveType: '7z',
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

  if (archiveType === 'zip') {
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
    return
  }

  if (archiveType === '7z') {
    await runCommand('7z', ['x', archivePath, `-o${destinationPath}`, '-y'], {
      shell: process.platform === 'win32',
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
  const packageJsonPath = join(directory, 'package.json')
  const packageJson = {
    name: 'synapse-relay-commandline-node',
    private: true,
    version: '1.0.0',
    type: 'commonjs',
    dependencies: NODE_DEPENDENCIES,
  }

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
  await runCommand('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-fund', '--no-audit'], {
    cwd: directory,
    shell: process.platform === 'win32',
  })
}

async function installPythonPackages(targetPlatform, pythonVersion, targetDirectory) {
  const pythonSpec = PYTHON_DISTRIBUTIONS[targetPlatform]
  if (!pythonSpec) {
    throw new Error(`unsupported target platform ${targetPlatform}`)
  }

  const hostPython = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const requirementsPath = join(targetDirectory, 'requirements.txt')
  await writeFile(requirementsPath, `${PYTHON_REQUIREMENTS.join('\n')}\n`)

  await runCommand(hostPython, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-compile',
    '--only-binary=:all:',
    '--implementation',
    'cp',
    '--python-version',
    pythonVersion.split('.').slice(0, 2).join('.'),
    '--abi',
    `cp${pythonVersion.split('.').slice(0, 2).join('')}`,
    '--platform',
    pythonSpec.pipPlatform,
    '--target',
    targetDirectory,
    '-r',
    requirementsPath,
  ], {
    shell: process.platform === 'win32',
  })
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
    if (targetPlatform.startsWith('windows-')) {
      return entryName.toLowerCase() === 'python.exe'
    }
    return entryName === 'python3' || entryName === 'python'
  })

  if (candidates.length === 0) {
    throw new Error('failed to locate bundled Python executable')
  }

  const normalizedCandidates = candidates.map((candidate) => ({ raw: candidate, normalized: candidate.split('\\').join('/') }))
  const preferred = (normalizedCandidates.find((candidate) => candidate.normalized.endsWith('/bin/python3'))
    || normalizedCandidates.find((candidate) => candidate.normalized.endsWith('/bin/python'))
    || normalizedCandidates[0])?.raw
    || candidates[0]

  const runtimeRoot = targetPlatform.startsWith('windows-')
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

function normalizeRelativePath(baseDir, targetPath) {
  return relative(baseDir, targetPath).split('\\').join('/')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const relayRoot = resolve(scriptDir, '..')
  const assetsDir = join(relayRoot, 'internal', 'commandlinebundle', 'assets')
  const workDir = await mkdtemp(join(tmpdir(), 'commandlinebundle-'))

  try {
    const pythonSpec = getPythonSpec(options.targetPlatform, options.pythonVersion, options.pythonStandaloneRelease)
    const ffmpegSpec = getFFmpegSpec(options.targetPlatform, options.ffmpegReleaseTag)
    const sharedNodeManifest = await loadSharedNodeManifest(relayRoot, options.targetPlatform, options.nodeVersion)

    const nodePackageDir = join(workDir, 'node-packages')
    const pythonArchivePath = join(workDir, pythonSpec.archiveFileName)
    const pythonExtractDir = join(workDir, 'python-extract')
    const pythonPackageDir = join(workDir, 'python-site-packages')
    const gitExtractDir = join(workDir, 'git-extract')
    const ffmpegDownloadDir = join(workDir, 'ffmpeg-downloads')

    await mkdir(nodePackageDir, { recursive: true })
    await mkdir(pythonExtractDir, { recursive: true })
    await mkdir(pythonPackageDir, { recursive: true })
    await mkdir(gitExtractDir, { recursive: true })
    await mkdir(ffmpegDownloadDir, { recursive: true })

    console.log(`Preparing bundled Node packages (${options.packageProfile})`)
    await writeNodePackage(nodePackageDir)

    console.log(`Downloading Python ${options.pythonVersion} standalone runtime for ${options.targetPlatform}`)
    await downloadFile(pythonSpec.url, pythonArchivePath)
    await extractArchive(pythonArchivePath, pythonExtractDir, pythonSpec.archiveType)

    console.log(`Installing bundled Python packages (${options.packageProfile})`)
    await installPythonPackages(options.targetPlatform, options.pythonVersion, pythonPackageDir)

    const ffmpegDownloadPath = join(ffmpegDownloadDir, ffmpegSpec.ffmpegFileName)
    const ffprobeDownloadPath = join(ffmpegDownloadDir, ffmpegSpec.ffprobeFileName)

    console.log(`Downloading FFmpeg tools (${options.ffmpegReleaseTag}) for ${options.targetPlatform}`)
    await downloadFile(ffmpegSpec.ffmpegURL, ffmpegDownloadPath)
    await downloadFile(ffmpegSpec.ffprobeURL, ffprobeDownloadPath)

    let gitBinary = ''
    let bashBinary = ''

    await rm(assetsDir, { recursive: true, force: true })
    await mkdir(assetsDir, { recursive: true })

    await copyDirectory(join(nodePackageDir, 'node_modules'), join(assetsDir, 'node-modules'))
    await copyFile(join(nodePackageDir, 'package.json'), join(assetsDir, 'node-modules', 'package.json'))
    const nodeLockPath = join(nodePackageDir, 'package-lock.json')
    if (await stat(nodeLockPath).then(() => true).catch(() => false)) {
      await copyFile(nodeLockPath, join(assetsDir, 'node-modules', 'package-lock.json'))
    }

    const {
      executable: sourcePythonBinary,
      runtimeRoot: pythonRuntimeRoot,
      binaryRelativePath: pythonBinaryPathInsideRuntime,
    } = await findPythonRuntime(pythonExtractDir, options.targetPlatform)
    await ensureExists(sourcePythonBinary)
    await copyDirectory(pythonRuntimeRoot, join(assetsDir, 'python'))
    await copyDirectory(pythonPackageDir, join(assetsDir, 'python-site-packages'))
    await rm(join(assetsDir, 'python', 'share', 'terminfo'), { recursive: true, force: true })

    const ffmpegBinary = options.targetPlatform.startsWith('windows-') ? 'ffmpeg/ffmpeg.exe' : 'ffmpeg/ffmpeg'
    const ffprobeBinary = options.targetPlatform.startsWith('windows-') ? 'ffmpeg/ffprobe.exe' : 'ffmpeg/ffprobe'
    await mkdir(join(assetsDir, 'ffmpeg'), { recursive: true })
    await copyFile(ffmpegDownloadPath, join(assetsDir, ffmpegBinary))
    await copyFile(ffprobeDownloadPath, join(assetsDir, ffprobeBinary))

    const pythonBinaryTarget = join(assetsDir, 'python', pythonBinaryPathInsideRuntime.split('/').join(process.platform === 'win32' ? '\\' : '/'))
    if (!pythonBinaryTarget) {
      throw new Error('failed to locate bundled Python executable after copying runtime')
    }

    if (options.targetPlatform === 'windows-amd64') {
      const gitSpec = getWindowsGitSpec(options.windowsGitVersion)
      const gitArchivePath = join(workDir, gitSpec.archiveFileName)

      console.log(`Downloading PortableGit ${options.windowsGitVersion}`)
      await downloadFile(gitSpec.url, gitArchivePath)
      await extractArchive(gitArchivePath, gitExtractDir, gitSpec.archiveType)

      const gitCandidates = await findFiles(gitExtractDir, (_entryPath, entryName) => entryName.toLowerCase() === 'git.exe')
      const bashCandidates = await findFiles(gitExtractDir, (_entryPath, entryName) => entryName.toLowerCase() === 'bash.exe')
      const sourceGitBinary = gitCandidates.find((entry) => entry.endsWith('\\cmd\\git.exe') || entry.endsWith('/cmd/git.exe')) || gitCandidates[0]
      const sourceBashBinary = bashCandidates.find((entry) => entry.endsWith('\\bin\\bash.exe') || entry.endsWith('/bin/bash.exe')) || bashCandidates[0]
      if (!sourceGitBinary || !sourceBashBinary) {
        throw new Error('failed to locate bundled Git Bash binaries')
      }

      const portableRoot = dirname(dirname(sourceGitBinary))
      await copyDirectory(portableRoot, join(assetsDir, 'git'))
      gitBinary = 'git/cmd/git.exe'
      bashBinary = 'git/bin/bash.exe'
    }

    const pythonBinaryRelative = normalizeRelativePath(assetsDir, pythonBinaryTarget)
    const executables = [pythonBinaryRelative, ffmpegBinary, ffprobeBinary]
    if (gitBinary) {
      executables.push(gitBinary)
    }
    if (bashBinary) {
      executables.push(bashBinary)
    }

    const manifest = {
      prepared: true,
      platform: options.targetPlatform,
      nodeAssetVersion: sharedNodeManifest.assetVersion,
      nodeModulesDir: 'node-modules',
      pythonHomeDir: 'python',
      pythonBinary: pythonBinaryRelative,
      pythonSitePackagesDir: 'python-site-packages',
      ffmpegBinary,
      ffprobeBinary,
      gitBinary,
      bashBinary,
      packageProfile: options.packageProfile,
      ffmpegReleaseTag: options.ffmpegReleaseTag,
      assetVersion: `commandline-${options.packageProfile}-python-${options.pythonVersion}-${options.pythonStandaloneRelease}-ffmpeg-${options.ffmpegReleaseTag}-${options.targetPlatform}`,
      executables,
    }

    await writeFile(join(assetsDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`Prepared bundled commandline runtime in ${assetsDir}`)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
