export const meta = {
  name: "camelcase-residual-cleanup",
  description:
    "Fix residual camelCase migration errors: lagging row-field access + hand-written row type aliases still declaring snake_case fields",
  phases: [{ title: "Fix", detail: "one agent per residual file" }],
}

const ROOT = "/projects/Synapse-dev/packages/api"
const files = args

const RESULT = {
  type: "object",
  additionalProperties: false,
  required: ["file", "status", "notes"],
  properties: {
    file: { type: "string" },
    status: { type: "string", enum: ["fixed", "partial", "failed"] },
    notes: { type: "string" },
  },
}

phase("Fix")
const results = await parallel(
  files.map(
    (file) => () =>
      agent(
        `Fix the residual TypeScript errors in ONE file after a snake_case->camelCase Kysely codegen migration. Postgres stays snake_case; the Kysely/TS surface (generated db types, result rows, TableRow/TableInsert/TableUpdate, table & column string literals) is now FULLY camelCase, with CamelCasePlugin({maintainNestedObjectKeys:true}) so JSONB VALUES are untouched.

FILE: ${ROOT}/${file}
Errors: read ${"/tmp/tcerr2/" + file.replace(/\//g, "__") + ".txt"}

These are RESIDUAL errors. Common root causes:
1. A row-FIELD ACCESS still snake_case (e.g. row.workspace_member_id) on a now-camelCase Kysely row -> rename to camelCase (row.workspaceMemberId). The compiler often suggests the exact camel name ("Did you mean 'X'?").
2. A HAND-WRITTEN row TYPE ALIAS (interface/type) that still declares snake_case fields but is assigned FROM a camelCase Kysely query result -> update the type alias's field names to camelCase so it matches the query. (e.g. type TransportAccountRow = { ...snake... } that's built from db.selectFrom("transportAccounts")... must become camelCase). Then fix every reader of that type accordingly.
3. An INSERT/UPDATE object literal whose KEYS are now wrong (TS2561 "did you mean 'workspace_id'" means the target column expects snake — that's a JSONB/raw or a still-snake hand type; vs "did you mean 'workspaceId'" means convert to camel).

CRITICAL distinctions:
- If an object literal is a DELIBERATE app/DTO/wire shape with snake_case keys (e.g. legacy *AccessRow app contracts, JSONB payloads, device-protocol wire), KEEP its keys snake_case and only fix the right-hand-side value accessors (the Kysely row reads). The error TS2561 "Did you mean to write 'workspace_id'?" means the TARGET type (a hand-written snake type) wants snake — in that case the SOURCE accessor is the thing to change, OR the hand type itself should be camelCased if it's actually a Kysely row type. Read the surrounding code to decide which side is the Kysely row (camel) and which is the app shape.
- Do NOT touch raw SQL bodies, JSONB value keys, enum/business string values, comments.

METHOD: Read the error file + the source. Fix minimally and correctly. Do NOT run tsc (a central typecheck runs after). Preserve runtime behavior.

Return {file, status, notes} — note any hand-written type alias you camelCased and any site you deliberately left snake_case.`,
        {
          label: file.replace("src/modules/", "").replace("src/", ""),
          phase: "Fix",
          schema: RESULT,
        }
      )
  )
)
return { results: results.filter(Boolean) }
