export const meta = {
  name: "camelcase-kysely-codemod",
  description:
    "Convert Kysely query identifiers + row field access from snake_case to camelCase across packages/api, file by file, preserving JSONB/wire/raw-SQL/comments",
  phases: [
    {
      title: "Codemod",
      detail: "one agent per file converts its Kysely surface",
    },
  ],
}

const ROOT = "/projects/Synapse-dev/packages/api"
const worklist = args // array of {file, errs, test}

const RESULT = {
  type: "object",
  additionalProperties: false,
  required: ["file", "status", "notes"],
  properties: {
    file: { type: "string" },
    status: {
      type: "string",
      enum: ["converted", "no-change-needed", "partial", "failed"],
    },
    notes: {
      type: "string",
      description:
        "what was changed and any site left intentionally (JSONB/wire/raw-sql) or anything uncertain",
    },
  },
}

function prompt(file) {
  return `You are performing a precise, mechanical CODEMOD on ONE file in the Synapse API at ${ROOT}.

CONTEXT: We enabled Kysely \`CamelCasePlugin({ maintainNestedObjectKeys: true })\` + codegen \`camelCase: true\`. Postgres stays snake_case, but the TypeScript/Kysely side is now FULLY camelCase. The generated DB types (src/infrastructure/database/generated/db.ts) now expose camelCase table names and column names. Your job: fix THIS FILE so it compiles under the new camelCase Kysely surface.

FILE: ${file}
Its current TypeScript errors are in: /tmp/tcerr/${file.replace(/\//g, "__")}.txt  (Read this file first.)

WHAT TO CONVERT (snake_case -> camelCase):
1. Table-name string literals in Kysely calls: selectFrom("workspace_invites") -> selectFrom("workspaceInvites"); insertInto/updateTable/deleteFrom likewise. Aliased forms too: "workspace_invites as wi" -> "workspaceInvites as wi" (the ALIAS part stays as-is, e.g. "wi").
2. Column references in Kysely string positions: .where("created_at", ...) -> .where("createdAt", ...); .select(["workspace_id","trust_level"]) -> camelCase; onRef("a.workspace_id","=","b.id") -> "a.workspaceId"; orderBy, groupBy, returning, distinctOn, etc. Qualified refs keep the alias prefix: "wi.workspace_id" -> "wi.workspaceId".
3. Object-literal KEYS in .values({...}) (insert), .set({...}) (update), and onConflict columns: { workspace_id: x } -> { workspaceId: x }.
4. TableRow<"x">/TableInsert<"x">/TableUpdate<"x">/Selectable<DB["x"]> generic args: snake table name -> camel.
5. Row FIELD ACCESS on Kysely result rows: row.workspace_id -> row.workspaceId, invite.created_at -> invite.createdAt, etc. (the rows are now camelCase).
6. Column alias OUTPUT in raw sql / .select("x.name as workspace_name"): the alias should become camelCase too IF it is consumed as a row field in TS (app projection). Keep it consistent with how the field is read.
7. Local type aliases derived from rows that listed snake fields (e.g. \`& { workspace_name?: string }\`) -> camelCase to match.

WHAT TO ABSOLUTELY PRESERVE (do NOT touch):
- JSONB payload object keys: any object that is STORED INTO or READ FROM a jsonb column value (e.g. policy specs, metadata contents, collaboration_state inner keys, wire/signed-envelope payloads, MCP _meta/structuredContent, provider_options). These are values, not Kysely identifiers — the plugin does NOT transform them (maintainNestedObjectKeys:true). If unsure whether an object key is a column key or a JSONB value key, check whether it's inside .values()/.set() at the TOP LEVEL (column => convert) vs nested inside a value (JSONB => preserve).
- Raw SQL string bodies: sql\`... snake_case ...\` and CompiledQuery.raw("SELECT ... snake_case") — the SQL text targets the physical snake_case DB. DO NOT camelCase inside raw SQL text. (But a raw-sql column ALIAS that TS reads as a camelCase field may need aligning — only if an error points at it.)
- snake_case in: comments, string DATA/enums/business values (e.g. "remote_agent_daemon" service kind, status values like "pending_approval"), env var names, redis keys, file paths, device-protocol wire field names in wire payloads, HTTP routes.
- Better Auth tables/columns if any are accessed via its own adapter.

METHOD:
- Read the per-file error list AND the file. The error list pinpoints exact line:col of every snake_case Kysely identifier / row-field-access to fix. Fix every one.
- Also scan the whole file for sibling sites the error list may not enumerate (e.g. once you fix a TableRow type, dependent row.snake accesses elsewhere). Convert all Kysely-surface snake_case in the file.
- Do NOT run tsc yourself (it is too slow/heavy to run in parallel). Rely on the error list + careful reading. A central typecheck runs after all files are done.
- If a site is genuinely ambiguous (can't tell column-key vs JSONB-value-key), PRESERVE it and note it for manual review.
- Do NOT change runtime behavior. Pure naming/shape conversion only.

Return {file, status, notes}. In notes, list any sites you intentionally left snake_case (JSONB/wire/raw-sql) and any ambiguous site you preserved for manual review.`
}

phase("Codemod")

// Pipeline: convert each file. Concurrency is capped by the runtime (~14).
const results = await parallel(
  worklist.map(
    (w) => () =>
      agent(prompt(w.file), {
        label: w.file.replace("src/modules/", "").replace("src/", ""),
        phase: "Codemod",
        schema: RESULT,
      })
  )
)

const ok = results.filter(Boolean)
const failed = ok.filter((r) => r.status === "failed" || r.status === "partial")
log(
  `Codemod done: ${ok.length}/${worklist.length} returned; ${failed.length} partial/failed`
)
return { results: ok, failed }
