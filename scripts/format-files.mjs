#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const prettierExtensions = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".css",
  ".md",
  ".mdx",
  ".yml",
  ".yaml",
  ".html",
])

const excludedPrefixes = ["subprojects/", ".agents/", ".setup/"]
const excludedFiles = new Set([
  "packages/web-next/public/web-chat-service-worker.js",
  "packages/mobile-app/public/chat-service-worker.js",
])

const args = process.argv.slice(2)
const positional = []
let all = false
let check = false
let formatter = "all"

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]

  if (arg === "--all") {
    all = true
    continue
  }

  if (arg === "--check") {
    check = true
    continue
  }

  if (arg === "--formatter") {
    formatter = args[index + 1] ?? formatter
    index += 1
    continue
  }

  if (arg.startsWith("--formatter=")) {
    formatter = arg.slice("--formatter=".length)
    continue
  }

  positional.push(arg)
}

if (!["all", "prettier", "gofmt"].includes(formatter)) {
  console.error(`Unknown formatter: ${formatter}`)
  process.exit(1)
}

const files = all ? trackedFiles() : positional
const normalizedFiles = unique(
  files.map(normalizePath).filter((file) => file && shouldConsider(file))
)

const prettierFiles = normalizedFiles.filter(isPrettierFile)
const goFiles = normalizedFiles.filter(isGoFile)

if (formatter === "all" || formatter === "prettier") {
  runPrettier(prettierFiles)
}

if (formatter === "all" || formatter === "gofmt") {
  runGofmt(goFiles)
}

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })

  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "")
    process.exit(result.status ?? 1)
  }

  return result.stdout.split("\0").filter(Boolean)
}

function normalizePath(file) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file)
  const relative = path.relative(root, absolute)

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return ""
  }

  return relative.split(path.sep).join("/")
}

function shouldConsider(file) {
  if (excludedFiles.has(file)) {
    return false
  }

  if (excludedPrefixes.some((prefix) => file.startsWith(prefix))) {
    return false
  }

  return existsSync(path.join(root, file))
}

function isPrettierFile(file) {
  return prettierExtensions.has(path.extname(file))
}

function isGoFile(file) {
  return path.extname(file) === ".go"
}

function runPrettier(files) {
  if (files.length === 0) {
    return
  }

  const prettier = localBin("prettier")
  const mode = check ? "--check" : "--write"

  if (check) {
    let failed = false

    for (const chunk of chunkFiles(files)) {
      const result = spawnSync(prettier, [mode, "--ignore-unknown", ...chunk], {
        cwd: root,
        stdio: "inherit",
      })

      if (result.error) {
        console.error(result.error.message)
        process.exit(1)
      }

      if (result.status !== 0) {
        failed = true
      }
    }

    if (failed) {
      process.exit(1)
    }

    return
  }

  for (const chunk of chunkFiles(files)) {
    run(prettier, [mode, "--ignore-unknown", ...chunk])
  }
}

function runGofmt(files) {
  if (files.length === 0) {
    return
  }

  if (!check) {
    for (const chunk of chunkFiles(files)) {
      run("gofmt", ["-w", ...chunk])
    }
    return
  }

  let unformatted = []

  for (const chunk of chunkFiles(files)) {
    const result = spawnSync("gofmt", ["-l", ...chunk], {
      cwd: root,
      encoding: "utf8",
    })

    if (result.error) {
      console.error(result.error.message)
      process.exit(1)
    }

    if (result.status !== 0) {
      process.stderr.write(result.stderr ?? "")
      process.exit(result.status ?? 1)
    }

    unformatted = unformatted.concat(result.stdout.split("\n").filter(Boolean))
  }

  if (unformatted.length > 0) {
    console.error("The following Go files need gofmt:")
    console.error(unformatted.join("\n"))
    process.exit(1)
  }
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
  })

  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function localBin(name) {
  const suffix = process.platform === "win32" ? ".cmd" : ""
  const bin = path.join(root, "node_modules", ".bin", `${name}${suffix}`)

  if (!existsSync(bin)) {
    console.error(`Missing ${name}. Run npm ci before formatting.`)
    process.exit(1)
  }

  return bin
}

function chunkFiles(files, size = 100) {
  const chunks = []

  for (let index = 0; index < files.length; index += size) {
    chunks.push(files.slice(index, index + size))
  }

  return chunks
}

function unique(values) {
  return [...new Set(values)]
}
