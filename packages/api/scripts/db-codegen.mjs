#!/usr/bin/env node
// kysely-codegen reads DATABASE_URL via env(). We optionally pre-load it from a
// repo-root .env if one exists, then exec the CLI with whatever extra flags the
// caller passed (e.g. --verify). The previous .kysely-codegenrc.json pinned
// envFile to ../../.env, which throws ReferenceError when the file is absent —
// that broke fresh worktrees that don't carry a checked-in .env.
import { existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { config as loadDotenv } from "dotenv"

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, "..")
const candidates = []
let cursor = pkgRoot
for (;;) {
  candidates.push(resolve(cursor, ".env"))
  const parent = resolve(cursor, "..")
  if (parent === cursor) break
  cursor = parent
}
for (const candidate of candidates) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate })
    break
  }
}

const args = [
  "--config-file",
  resolve(pkgRoot, ".kysely-codegenrc.json"),
  ...process.argv.slice(2),
]
const result = spawnSync(
  process.execPath,
  [
    resolve(pkgRoot, "../../node_modules/kysely-codegen/dist/cli/bin.js"),
    ...args,
  ],
  { stdio: "inherit", cwd: pkgRoot }
)
process.exit(result.status ?? 1)
