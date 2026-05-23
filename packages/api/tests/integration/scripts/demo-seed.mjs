// One-shot demo seed: create user, workspace, member, session token for the
// canonical-content-blocks worktree's isolated API on 127.0.0.1:38001.
// Run via:
//   PG=postgresql://synapse:test_password@127.0.0.1:55433/synapse \
//     npx tsx packages/api/tests/integration/scripts/demo-seed.mjs

import crypto from "node:crypto"
import bcrypt from "bcryptjs"
import pg from "pg"

const PG_URL =
  process.env.PG ||
  "postgresql://synapse:test_password@127.0.0.1:55433/synapse_test"

// User-facing demo creds. NOT secure — for trying out the local stack.
const EMAIL = process.env.DEMO_EMAIL || "demo@cb.local"
const PASSWORD = process.env.DEMO_PASSWORD || "demo-cb-pass"
const USER_NAME = "CB Demo"
const WORKSPACE_NAME = "CB Demo Workspace"
const WORKSPACE_SLUG = `cb-demo-${crypto.randomBytes(2).toString("hex")}`

function generateSessionToken() {
  return crypto.randomBytes(48).toString("base64url")
}
function tokenHash(t) {
  return crypto.createHash("sha256").update(t).digest("hex")
}
function tokenHint(t) {
  return t.slice(0, 8)
}

async function main() {
  const client = new pg.Client({ connectionString: PG_URL })
  await client.connect()

  // Reset any prior demo rows
  await client.query(`DELETE FROM users WHERE email = $1`, [EMAIL])

  const passwordHash = await bcrypt.hash(PASSWORD, 10)
  const { rows: userRows } = await client.query(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
    [EMAIL, USER_NAME, passwordHash]
  )
  const userId = userRows[0].id

  const { rows: wsRows } = await client.query(
    `INSERT INTO workspaces (name, slug, owner_id, is_trusted)
     VALUES ($1, $2, $3, true) RETURNING id`,
    [WORKSPACE_NAME, WORKSPACE_SLUG, userId]
  )
  const workspaceId = wsRows[0].id

  const { rows: memberRows } = await client.query(
    `INSERT INTO workspace_members (workspace_id, user_id, trust_level)
     VALUES ($1, $2, 'admin') RETURNING id`,
    [workspaceId, userId]
  )
  const workspaceMemberId = memberRows[0].id

  const sessionToken = generateSessionToken()
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  await client.query(
    `INSERT INTO auth_sessions (user_id, client_type, transport, token_hash, token_hint, expires_at)
     VALUES ($1, 'web', 'token', $2, $3, $4)`,
    [userId, tokenHash(sessionToken), tokenHint(sessionToken), expires]
  )

  await client.end()

  console.log("")
  console.log("=== Canonical-Content-Blocks Demo Account ===")
  console.log(`API URL              http://127.0.0.1:38001`)
  console.log(`Health               http://127.0.0.1:38001/api/v1/health`)
  console.log(`Email                ${EMAIL}`)
  console.log(`Password             ${PASSWORD}`)
  console.log(`Workspace ID         ${workspaceId}`)
  console.log(`Workspace Member ID  ${workspaceMemberId}`)
  console.log(`User ID              ${userId}`)
  console.log(`Bearer token (30d)   ${sessionToken}`)
  console.log("")
  console.log("Smoke test (list conversations):")
  console.log(
    `  curl -sS -H "Authorization: Bearer ${sessionToken}" http://127.0.0.1:38001/api/v1/workspaces/${workspaceId}/chat/conversations`
  )
  console.log("")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
