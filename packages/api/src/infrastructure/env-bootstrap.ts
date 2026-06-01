import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { config as loadEnv } from "dotenv"

/**
 * Side-effect module: load the nearest .env into process.env.
 *
 * This MUST be imported before anything that reads process.env at module-eval
 * time — notably the shared logger (LOG_LEVEL/NODE_ENV) and the config schema.
 * ESM evaluates imports depth-first in source order, so importing this FIRST in
 * config/index.ts (and in any other early entrypoint) guarantees the .env is
 * applied before those readers run.
 *
 * Idempotent: dotenv does not override already-set vars, and we only load once.
 */
let loaded = false

function loadDotenvOnce(): void {
  if (loaded) return
  loaded = true
  for (const candidate of [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
  ]) {
    if (!existsSync(candidate)) continue
    loadEnv({ path: candidate })
    break
  }
}

loadDotenvOnce()
