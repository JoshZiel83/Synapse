#!/usr/bin/env node
// Offline purge CLI (design §9) — the privileged maintenance entry point. This
// is NOT wired into the app; it is run manually by an operator with DB access.
//
//   tsx src/infrastructure/database/purge.ts retention --before-days 30
//   tsx src/infrastructure/database/purge.ts workspace --id <uuid> --confirm
//
// It invokes the SECURITY DEFINER purge functions (sd_purge_expired_soft_deleted
// / sd_purge_workspace), which run as synapse_purge_fn_owner and are the only
// sanctioned hard-delete path for persistent business data. Tenant hard-erase is
// irreversible and requires --confirm.

import { resolve } from "path"
import { fileURLToPath } from "url"
import { sql } from "kysely"
import { db } from "./kysely.js"

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith("--")) {
        out[key] = next
        i++
      } else {
        out[key] = true
      }
    }
  }
  return out
}

async function retention(beforeDays: number) {
  const before = new Date(Date.now() - beforeDays * 24 * 60 * 60 * 1000)
  const res = await sql<{ sd_purge_expired_soft_deleted: number }>`
    SELECT sd_purge_expired_soft_deleted(${before.toISOString()}::timestamptz)
  `.execute(db)
  const n = res.rows[0]?.sd_purge_expired_soft_deleted ?? 0
  console.log(
    `retention purge: removed ${n} row(s) soft-deleted before ${before.toISOString()}`
  )
}

async function purgeWorkspace(id: string) {
  await sql`SELECT sd_purge_workspace(${id}::uuid)`.execute(db)
  console.log(`tenant hard-erase complete for workspace ${id}`)
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  switch (cmd) {
    case "retention": {
      const days = Number(args["before-days"] ?? 30)
      if (!Number.isFinite(days) || days < 0)
        throw new Error("--before-days must be >= 0")
      await retention(days)
      break
    }
    case "workspace": {
      const id = args.id
      if (typeof id !== "string") throw new Error("--id <uuid> is required")
      if (args.confirm !== true) {
        throw new Error(
          "tenant hard-erase is IRREVERSIBLE; re-run with --confirm to proceed"
        )
      }
      await purgeWorkspace(id)
      break
    }
    default:
      console.error(
        "usage:\n" +
          "  purge.ts retention --before-days <n>\n" +
          "  purge.ts workspace --id <uuid> --confirm"
      )
      process.exit(1)
  }
  process.exit(0)
}

const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error("purge failed:", err)
    process.exit(1)
  })
}

export { retention, purgeWorkspace }
