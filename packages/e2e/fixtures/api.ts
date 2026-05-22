/**
 * Lightweight typed REST client for the staging API, used by Playwright
 * fixtures to set up preconditions out of band (e.g. register a user,
 * create a workspace) before driving the UI.
 *
 * Mirrors the helpers in packages/api/test/integration/setup.ts but lives
 * in this workspace so the e2e package has no cross-workspace runtime
 * dependency on @synapse/api.
 */

import { randomBytes } from "node:crypto"

const stagingHost = process.env.SYNAPSE_STAGING_HOST || "127.0.0.1"
const stagingPort = process.env.NGINX_PORT
if (!stagingPort) {
  throw new Error(
    "NGINX_PORT not set. source infrastructure/scripts/staging-env.sh first."
  )
}
export const API_BASE = `http://${stagingHost}:${stagingPort}/api/v1`

function randomSlug(prefix = "test") {
  return `${prefix}-${randomBytes(6).toString("hex")}`
}

async function jsonRequest<T>(
  path: string,
  init: RequestInit & { json?: unknown; token?: string } = {}
): Promise<T> {
  const headers = new Headers(init.headers)
  let body = init.body
  if (Object.prototype.hasOwnProperty.call(init, "json")) {
    headers.set("Content-Type", "application/json")
    body = JSON.stringify(init.json)
  }
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`)
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, body })
  const text = await res.text()
  const data = text.length === 0 ? null : safeJson(text)
  if (!res.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} -> ${res.status}: ${JSON.stringify(data)}`
    )
  }
  return data as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export interface TestUser {
  email: string
  password: string
  sessionToken: string
  userId: string
  name: string
}

export async function registerUser(options?: {
  name?: string
}): Promise<TestUser> {
  const email = `${randomSlug("e2e")}@synapse.test`
  const password = "Test12345!"
  const name = options?.name ?? `E2E ${email}`

  const res = await jsonRequest<{
    user: { id: string; email: string; name: string }
    sessionToken?: string
  }>("/auth/register", {
    method: "POST",
    json: { email, password, name, transport: "token" },
  })

  if (!res.sessionToken) throw new Error("register did not return sessionToken")
  return {
    email,
    password,
    sessionToken: res.sessionToken,
    userId: res.user.id,
    name: res.user.name,
  }
}

export async function createWorkspace(
  token: string,
  options?: { name?: string }
): Promise<{ id: string; name: string; slug: string }> {
  const name = options?.name ?? randomSlug("ws")
  return jsonRequest("/workspaces", {
    method: "POST",
    json: { name },
    token,
  })
}
