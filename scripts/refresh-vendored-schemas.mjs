#!/usr/bin/env node
/**
 * Refresh the vendored third-party JSON Schemas under /schemas/vendor.
 *
 * These are checked in so editor validation works offline / behind restricted
 * networks (see schemas/vendor/README.md). This script re-fetches them from
 * their canonical upstream sources — run it intentionally when you want to bump
 * a vendored schema; it is NOT part of CI.
 *
 *   npm run schema:refresh-vendored
 */
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const VENDOR_DIR = join(REPO_ROOT, "schemas", "vendor")

/** @type {{ url: string, out: string }[]} */
const VENDORED = [
  {
    url: "https://raw.githubusercontent.com/compose-spec/compose-spec/master/schema/compose-spec.json",
    out: "compose-spec.schema.json",
  },
]

async function main() {
  for (const { url, out } of VENDORED) {
    process.stdout.write(`fetching ${out} … `)
    const res = await fetch(url, { redirect: "follow" })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    const text = await res.text()
    // Sanity-gate before overwriting the committed copy: it must parse as JSON
    // and actually look like a JSON Schema (guards against an upstream that
    // starts serving HTML, an error page, or a non-schema payload).
    const parsed = JSON.parse(text)
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.$schema !== "string"
    ) {
      throw new Error(
        `${out}: fetched payload is not a JSON Schema (missing a "$schema" dialect) — refusing to overwrite`
      )
    }
    const normalized = text.endsWith("\n") ? text : text + "\n"
    writeFileSync(join(VENDOR_DIR, out), normalized)
    console.log(`ok (${normalized.length} bytes)`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
