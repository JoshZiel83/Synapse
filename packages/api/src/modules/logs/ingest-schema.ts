// Log-ingest batch schema + per-record salvage (leaf module — no fastify/db
// imports so the salvage semantics are unit-testable in isolation).
//
// DEGRADE-NOT-REJECT (docs/trace-correctness-remediation-plan-2026-07-12.md
// §4.I change 5, adjudication 11/12 + §3c receiver rule):
//   - `trace_id` degrades at the FIELD level: an oversized / wrong-type /
//     non-canonical / all-zero value becomes absent — the record keeps its
//     content, it only loses correlation, and the raw invalid value is never
//     echoed anywhere.
//   - Records malformed in NON-trace fields are salvaged PER RECORD: valid
//     records are accepted, invalid ones are only counted.
//   - Only a batch whose envelope itself is malformed (no `records` array /
//     over MAX_RECORDS) is rejected outright.
// Before this, one bad trace_id 400-dropped up to 200 records with no trace.
import { z } from "zod"

export const LEVELS = ["debug", "info", "warn", "error"] as const
export type Level = (typeof LEVELS)[number]

export const MAX_RECORDS = 200
export const MAX_MSG_LEN = 4_000

export const RecordSchema = z
  .object({
    level: z.enum(LEVELS).default("info"),
    // Client-side domain/component (their own taxonomy, e.g. web.client.*); kept
    // as fields, not forced into the api LOG_DOMAINS enum.
    domain: z.string().max(120).optional(),
    component: z.string().max(120).optional(),
    msg: z.string().max(MAX_MSG_LEN).default(""),
    time: z.string().max(64).optional(),
    // Field-level degrade-not-reject (§3c receiver rule). The `.catch` is
    // load-bearing: without it `.max(64)`/type failures run BEFORE the
    // transform and reject the whole record. The transform then keeps only a
    // canonical lowercase-hex 32-char trace id, rejecting the all-zero id
    // (which would pollute the Loki→Tempo derived-link grouping). Anything
    // else degrades to absent.
    trace_id: z
      .string()
      .max(64)
      .optional()
      .catch(undefined)
      .transform((v) =>
        v && /^(?!0{32})[0-9a-f]{32}$/.test(v) ? v : undefined
      ),
    fields: z.record(z.string(), z.unknown()).optional(),
  })
  .strip()

export type IngestRecord = z.infer<typeof RecordSchema>

// Batch envelope only — records are parsed INDIVIDUALLY (per-record salvage)
// so one malformed record cannot poison the other 199.
const BodySchema = z.object({
  records: z.array(z.unknown()).max(MAX_RECORDS),
})

export interface SalvagedBatch {
  records: IngestRecord[]
  rejected: number
}

/**
 * Parse an ingest body with per-record salvage. `null` ⇔ the batch ENVELOPE is
 * malformed (⇒ 400); otherwise every parseable record is accepted and the rest
 * are counted (⇒ 202 with `{accepted, rejected}`).
 */
export function salvageLogBatch(body: unknown): SalvagedBatch | null {
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) return null

  let rejected = 0
  const records: IngestRecord[] = []
  for (const raw of parsed.data.records) {
    const record = RecordSchema.safeParse(raw)
    if (record.success) {
      records.push(record.data)
    } else {
      rejected++
    }
  }
  return { records, rejected }
}
