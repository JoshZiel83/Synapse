import { z } from "zod"

// Schema for the curated CLI prereq overlay (cli-prereq-overlay.json) — the
// authoritative, HUMAN-reviewed gating source consulted by the cli-catalog
// helper. It is the single source of truth for both the runtime validation (the
// bundled overlay is parsed with this at load) and the generated JSON Schema
// (schemas/cli-prereq-overlay.schema.json) that gives editor autocomplete +
// validation when a maintainer curates an entry. Descriptions are English and
// operator/maintainer-facing.

/** One curated prereq entry (keyed by cliName in the catalog). */
export const cliPrereqEntrySchema = z.strictObject({
  cliName: z
    .string()
    .describe("Catalog CLI name this prereq applies to (matches the catalog)."),
  entryPoint: z
    .string()
    .describe("The bare program the agent runs (e.g. cli-anything-<x>)."),
  underlying: z
    .strictObject({
      binary: z
        .array(z.string())
        .optional()
        .describe(
          "Executables that must be on PATH (alias-aware: python→python3/python, node→node/nodejs)."
        ),
      service: z
        .array(z.strictObject({ url: z.string().nullable() }))
        .optional()
        .describe(
          "Reachable services required. url null means 'a service is needed but its address is unknown' (unverifiable)."
        ),
      platform: z
        .array(z.string())
        .optional()
        .describe(
          "Allowed platforms (e.g. win32, darwin, linux); empty/omitted = any."
        ),
      minVersion: z
        .record(z.string(), z.string())
        .optional()
        .describe("Minimum version per binary, as { binary: semver }."),
    })
    .describe("The real-world prerequisites gating this CLI."),
  credential: z
    .boolean()
    .describe("Whether the CLI needs a credential/API key to be useful."),
  reviewed: z
    .boolean()
    .describe(
      "Human-reviewed gate: only reviewed:true entries are exposed to the agent; reviewed:false is safe-hidden until curated."
    ),
})

export type CliPrereq = z.infer<typeof cliPrereqEntrySchema>

/** The overlay document: provenance metadata plus the curated entries. */
export const cliPrereqOverlaySchema = z.strictObject({
  meta: z
    .strictObject({
      source: z.string().optional(),
      pin: z.string().optional(),
      generator: z.string().optional(),
    })
    .optional()
    .describe("Provenance of the draft this overlay was curated from."),
  _note: z.string().optional().describe("Free-form maintainer note."),
  entries: z
    .array(cliPrereqEntrySchema)
    .describe("The curated prereq entries."),
})

export type CliPrereqOverlay = z.infer<typeof cliPrereqOverlaySchema>
