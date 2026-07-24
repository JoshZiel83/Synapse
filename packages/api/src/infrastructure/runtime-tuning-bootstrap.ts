import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  runtimeTuningEnvOverrides,
  runtimeTuningSchema,
} from "../config/runtime-tuning-schema.js"

/**
 * Side-effect module: apply an optional runtime-tuning.json to process.env.
 *
 * MUST be imported AFTER env-bootstrap (dotenv) and BEFORE the config schema in
 * config/index.ts reads process.env, so the precedence is:
 *
 *   real environment  >  .env file  >  runtime-tuning.json  >  built-in defaults
 *
 * We only inject a knob's value when its env var is unset (set-if-absent),
 * mirroring dotenv, and warn when an env var shadows a file-provided value so an
 * edit to runtime-tuning.json that silently has no effect is visible. The
 * central config schema (config/index.ts) still owns coercion, bounds, and the
 * default for any knob left unset here.
 *
 * The file itself is validated against runtimeTuningSchema (strict) so a
 * misspelled knob fails loudly instead of being silently ignored. Fail-closed on
 * a malformed file — consistent with config/index.ts refusing to boot on bad env.
 *
 * Runs before the logger is configured, so notices go to console.
 */
function resolveTuningPath(): string {
  const override = process.env.RUNTIME_TUNING_CONFIG_PATH?.trim()
  if (override) {
    return isAbsolute(override) ? override : resolve(process.cwd(), override)
  }
  // Default: packages/api/config/runtime-tuning.json, resolved relative to this
  // module (independent of cwd — works from the api dir, repo root, or /app in
  // the image). This file lives in src/ (tsx) or dist/ (built); config/ is two
  // levels up from infrastructure/ in both layouts.
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "config",
    "runtime-tuning.json"
  )
}

/**
 * Fail closed, matching config/index.ts's loadEnvOrExit style: a clean, no-stack
 * message then a bare exit (this runs pre-telemetry, on the same import path the
 * db/tool scripts use, so a V8 stack trace would just be noise).
 */
function fail(message: string): never {
  // eslint-disable-next-line no-console
  console.error(message)
  process.exit(1)
}

function applyRuntimeTuning(): void {
  const path = resolveTuningPath()
  if (!existsSync(path)) return

  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (err) {
    fail(`runtime-tuning: cannot read ${path}: ${(err as Error).message}`)
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    fail(`runtime-tuning: ${path} is not valid JSON: ${(err as Error).message}`)
  }

  // Tolerate (and ignore) a top-level `$schema` self-reference — a near-universal
  // convention operators add for editor validation — instead of failing strict
  // validation on it and bricking boot for every config importer.
  if (json && typeof json === "object" && !Array.isArray(json)) {
    delete (json as Record<string, unknown>).$schema
  }

  const parsed = runtimeTuningSchema.safeParse(json)
  if (!parsed.success) {
    fail(`runtime-tuning: ${path} is invalid: ${parsed.error.message}`)
  }

  for (const { env, value } of runtimeTuningEnvOverrides(parsed.data)) {
    // A knob already provided by the environment or .env wins over the file.
    // Presence (not truthiness) is the test — a present-but-empty var counts as
    // set, so `real-env > file` holds even for "", matching dotenv's semantics
    // and letting an empty var request the central schema's default. Surface the
    // shadow so a file edit that has no effect is visible.
    if (process.env[env] !== undefined) {
      // eslint-disable-next-line no-console
      console.warn(
        `runtime-tuning: ${env} is already set (environment or .env); the value for this knob in ${path} is ignored`
      )
      continue
    }
    process.env[env] = value
  }
}

applyRuntimeTuning()
