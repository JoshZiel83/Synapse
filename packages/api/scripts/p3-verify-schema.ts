// P3 isolated-DB schema verification — DOUBLE-GATED against ever touching :5432.
// Gate 1: process.env.DATABASE_URL must point at the isolated :55632 throwaway.
// Gate 2: the app's fully-resolved config.database.url (post-dotenv) must ALSO be
//         :55632 — catches an override:true dotenv clobbering our inline var.
// Gate 3: ask the live connection which server port it is actually on.
// Only when ALL agree do we run the destructive rebuildDatabaseSchema().
import { config } from "../src/config/index.js"
import { rebuildDatabaseSchema } from "../src/infrastructure/database/bootstrap.js"
import {
  closeDatabasePool,
  pool,
} from "../src/infrastructure/database/index.js"

const ISOLATED = "55632"

async function main() {
  const envUrl = process.env.DATABASE_URL ?? ""
  const cfgUrl = config.database.url
  if (!envUrl.includes(`:${ISOLATED}/`))
    throw new Error(`GATE1 FAIL: env DATABASE_URL not :${ISOLATED}`)
  if (!cfgUrl.includes(`:${ISOLATED}/`))
    throw new Error(
      `GATE2 FAIL: config.database.url is NON-isolated (dotenv override footgun). Abort.`
    )

  // Gate 3: a durable marker schema exists ONLY in the isolated throwaway container
  // (planted out-of-band; survives DROP SCHEMA public). Prod has no such schema, so a
  // mis-targeted connection to :5432 fails this gate BEFORE any destructive op.
  // (inet_server_port() is useless here — both containers listen internally on 5432.)
  const mark = await pool.query(
    "SELECT current_database() AS db, EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name='refactor_marker') AS isolated"
  )
  if (mark.rows[0]?.isolated !== true)
    throw new Error(
      `GATE3 FAIL: connected db has no refactor_marker schema — NOT the isolated throwaway. Abort.`
    )
  console.log(
    `[p3-verify] gates OK — db=${mark.rows[0]?.db} isolated-marker=present`
  )

  console.log("[p3-verify] applying schema.sql via rebuildDatabaseSchema()...")
  await rebuildDatabaseSchema()
  console.log("[p3-verify] schema applied cleanly.")

  const col = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM information_schema.columns
       WHERE table_name='runtime_services' AND column_name='transport') AS exists`
  )
  const hasCol = col.rows[0]?.exists === true
  console.log(`[p3-verify] runtime_services.transport present: ${hasCol}`)

  const chk = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname='chk_runtime_services_transport_kind'`
  )
  const def = chk.rows[0]?.def ?? ""
  const checkOk =
    def.includes("bare_dataplane") &&
    def.includes("'direct'") &&
    def.includes("remote_agent_daemon")
  console.log(`[p3-verify] transport CHECK def: ${def || "(MISSING)"}`)

  if (!hasCol || !checkOk)
    throw new Error("[p3-verify] P3a DDL assertions FAILED")
  console.log("[p3-verify] ALL P3a DDL assertions passed.")
}

main()
  .then(async () => {
    await closeDatabasePool()
    process.exit(0)
  })
  .catch(async (e) => {
    console.error(e)
    await closeDatabasePool().catch(() => {})
    process.exit(1)
  })
