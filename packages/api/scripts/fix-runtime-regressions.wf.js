export const meta = {
  name: "camelcase-runtime-regression-fix",
  description:
    "Fix runtime regressions from the camelCase migration: raw sql<> result keys are now camelCased by CamelCasePlugin but hand-written reads/types stayed snake_case (compiles, breaks at runtime). Verify by running tests.",
  phases: [
    { title: "Fix", detail: "one agent per module area, verify-driven" },
  ],
}

const ROOT = "/projects/Synapse-dev/packages/api"
const areas = args // [{label, testCmd, failing:[...], hint}]

const RESULT = {
  type: "object",
  additionalProperties: false,
  required: ["area", "status", "pass", "fail", "notes"],
  properties: {
    area: { type: "string" },
    status: {
      type: "string",
      enum: ["all-pass", "improved", "no-change", "failed"],
    },
    pass: { type: "number" },
    fail: { type: "number" },
    notes: {
      type: "string",
      description:
        "root causes found + fixes made; any still-failing test with reason",
    },
  },
}

phase("Fix")
const results = await parallel(
  areas.map(
    (a) => () =>
      agent(
        `Fix runtime-failing tests in the Synapse API (${ROOT}) caused by the snake_case->camelCase Kysely migration.

THE KEY SEMANTIC (root cause of these failures):
We enabled \`CamelCasePlugin({ maintainNestedObjectKeys: true })\` on the Kysely instance. This plugin's transformResult() camelCases the TOP-LEVEL keys of EVERY result row returned through the Kysely executor — INCLUDING raw \`sql<RowType>\`...\`.execute(db|trx|executor)\` tagged-template queries and \`db.executeQuery(CompiledQuery.raw(...))\`. So:
- A raw query \`sql<{ current_snapshot_id: string }>\`SELECT current_snapshot_id ...\`.execute(db)\` now returns a row with key \`currentSnapshotId\` at RUNTIME, even though the SQL text and the <RowType> say snake_case. Reading \`row.current_snapshot_id\` returns UNDEFINED → test fails (compiles fine because the hand-written <RowType> still declares snake).
- EXCEPTION: queries run through bare-pg (\`pool.query\`, \`client.query\`, a \`runOnDb\`/raw pg runner that does NOT go through the Kysely executor) do NOT get the plugin — their rows stay snake_case. Check how the query is actually executed before changing reads.

YOUR AREA: ${a.label}
Failing tests (names): ${JSON.stringify(a.failing)}
${a.hint || ""}

METHOD (verify-driven):
1. Run the failing tests: \`cd ${ROOT} && ${a.testCmd}\` and read the actual errors (look for \`+ undefined\` / \`- 'expected'\` assertion diffs, or "is not a ... address" style logic failures from an undefined field).
2. For each failure, trace the field that's undefined back to its query. Determine execution path:
   - Through Kysely executor (\`.execute(db|trx|executor)\`, \`db.executeQuery(...)\`, runBuilder/runCompilable which call executor.executeQuery) => result keys are CAMELCASE at runtime. Fix the <RowType> generic AND the reads to camelCase. You may keep the SQL body's column names snake_case (physical DB) OR alias them; the plugin camelCases the returned keys regardless, so reads must be camelCase.
   - Through bare-pg (pool/client.query / a non-Kysely raw runner) => keys stay SNAKE_CASE; reads must stay snake. If a prior codemod wrongly camelCased these reads, revert them to snake.
3. Also fix test-side reads/object-keys that access these rows with the wrong case (incl. \`(row as any).snake_field\` casts that escaped the typed codemod).
4. Do NOT touch: JSONB value keys, enum/business string values, comments, the raw SQL body column names (unless adding an alias), wire/device-protocol payloads.
5. Re-run the failing tests until they pass (or you've reduced failures as far as correctness allows). Some tests need a live DB (withTestDb / testcontainers) — that's fine, it's available. If a test was ALREADY failing before this migration for an unrelated reason, note it and move on.

Report {area, status, pass, fail, notes}. In notes: the root-cause per file, what you changed (which row types/reads went camel, which stayed snake for bare-pg), and any residual failure with its reason.`,
        { label: a.label, phase: "Fix", schema: RESULT }
      )
  )
)
return { results: results.filter(Boolean) }
