#!/usr/bin/env tsx
/**
 * Generate JSON Schema files from the repo's Zod schemas — SINGLE SOURCE OF TRUTH.
 *
 * Zod is authoritative; every file under /schemas that this script owns is a
 * GENERATED artifact. Editing those files by hand is pointless — the next
 * `npm run schema:gen` overwrites them, and `npm run guard:schemas` (run in the
 * api `pretest` chain AND in scripts/verify-boundary.sh's guard block) fails on
 * any drift.
 *
 * The generated schemas drive IDE autocomplete + inline validation in VS Code
 * (JSON natively; YAML via the redhat.vscode-yaml extension), mapped from the
 * repo-root .vscode/settings.json.
 *
 * Design notes (see docs/config-json-schema-extraction-plan-2026-07-24.md):
 *   - target 'draft-7': VS Code's JSON language service and redhat.vscode-yaml
 *     fully support draft-04..07 but only PARTIALLY support 2019-09 / 2020-12
 *     (which z.toJSONSchema emits by default). draft-7 is load-bearing for
 *     reliable editor hints — do not change it without re-checking editor support.
 *   - io 'input': operators edit the pre-parse (input) shape of the config.
 *   - Cross-field rules declared with Zod `.superRefine()` are, by design, NOT
 *     representable in JSON Schema and are silently dropped here. They stay
 *     enforced at runtime by Zod. Editor validation is shape / enum / type only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { z } from "zod"

import { modelGroupsFileSchema } from "../src/modules/model-groups/schemas.js"

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
)
const SCHEMAS_DIR = join(REPO_ROOT, "schemas")

interface SchemaEntry {
  /** Output filename under /schemas. */
  out: string
  /** The Zod schema to generate from (the authoritative source of truth). */
  schema: z.ZodType
  /** Human-facing title shown by editors. */
  title: string
  /** Longer description surfaced as hover text at the document root. */
  description: string
}

/**
 * Registry of generated schemas. Each extraction phase appends an entry here;
 * the corresponding Zod schema stays the single source of truth.
 */
const REGISTRY: SchemaEntry[] = [
  {
    out: "model-groups.schema.json",
    schema: modelGroupsFileSchema,
    title: "Synapse model-groups configuration",
    description:
      "Declarative platform model-group config imported by the API " +
      "(packages/api/config/model-groups.yaml). API keys must be `${ENV_VAR}` " +
      "references, never literal secrets. Cross-field rules (at most one default " +
      "group, unique group names, unique item display names) are enforced at " +
      "import time by Zod and are intentionally not expressed here.",
  },
]

const GEN_OPTS = {
  target: "draft-7",
  io: "input",
  unrepresentable: "any",
} as const

function generate(entry: SchemaEntry): string {
  const body = z.toJSONSchema(entry.schema, GEN_OPTS) as Record<string, unknown>
  const { $schema, ...rest } = body
  // Idiomatic key order: dialect, generated-file banner, human-facing metadata,
  // then the shape. `$comment` is ignored by validators (a no-op keyword), so it
  // is purely a marker for anyone who opens the committed file.
  const doc = {
    $schema,
    $comment:
      "GENERATED from Zod by `npm run schema:gen` — do not hand-edit; " +
      "drift-checked by `npm run guard:schemas`.",
    title: entry.title,
    description: entry.description,
    ...rest,
  }
  return JSON.stringify(doc, null, 2) + "\n"
}

function main(): void {
  const check = process.argv.includes("--check")
  const drifted: string[] = []

  for (const entry of REGISTRY) {
    const target = join(SCHEMAS_DIR, entry.out)
    const next = generate(entry)

    if (check) {
      const current = existsSync(target) ? readFileSync(target, "utf8") : ""
      if (current !== next) drifted.push(entry.out)
    } else {
      writeFileSync(target, next)
      // eslint-disable-next-line no-console
      console.log(`generated schemas/${entry.out}`)
    }
  }

  if (check && drifted.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `config schema drift detected in: ${drifted.join(", ")}\n` +
        "The committed /schemas/*.schema.json are out of sync with their Zod " +
        "sources. Run `npm run schema:gen` and commit the result."
    )
    process.exit(1)
  }
}

main()
