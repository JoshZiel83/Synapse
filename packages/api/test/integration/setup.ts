/**
 * Integration test harness for the Synapse API.
 *
 * Strategy: BLACK-BOX. Tests issue HTTP requests against a running staging
 * API (host configured via STAGING_API_URL env var, defaults to
 * http://127.0.0.1:${NGINX_PORT}/api/v1).
 *
 * Tests must not assume state of the database; use random IDs and emails to
 * avoid collisions with other test runs sharing the same staging DB.
 *
 * Later stages may add white-box helpers (per-process Fastify boot + temp
 * schema isolation) on top of this file.
 */

import { randomBytes } from "node:crypto"

export interface ApiClient {
  baseUrl: string
  token?: string
  fetch: (
    path: string,
    init?: RequestInit & { json?: unknown }
  ) => Promise<Response>
  json: <T = unknown>(
    path: string,
    init?: RequestInit & { json?: unknown }
  ) => Promise<T>
  withToken: (token: string) => ApiClient
}

function resolveBaseUrl(): string {
  const explicit = process.env.STAGING_API_URL
  if (explicit && explicit.trim().length > 0) {
    return explicit.replace(/\/$/, "")
  }
  const host = process.env.SYNAPSE_STAGING_HOST || "127.0.0.1"
  const port = process.env.NGINX_PORT
  if (!port) {
    throw new Error(
      "STAGING_API_URL not set and NGINX_PORT missing. Did you `source infrastructure/scripts/staging-env.sh`?"
    )
  }
  return `http://${host}:${port}/api/v1`
}

export function createApiClient(options?: {
  baseUrl?: string
  token?: string
}): ApiClient {
  const baseUrl = (options?.baseUrl ?? resolveBaseUrl()).replace(/\/$/, "")
  const token = options?.token

  const client: ApiClient = {
    baseUrl,
    token,
    async fetch(path, init) {
      const url = path.startsWith("http") ? path : `${baseUrl}${path}`
      const headers = new Headers(init?.headers)
      if (token && !headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${token}`)
      }
      let body = init?.body
      if (init && Object.prototype.hasOwnProperty.call(init, "json")) {
        headers.set("Content-Type", "application/json")
        body = JSON.stringify(init.json)
      }
      return fetch(url, { ...init, headers, body })
    },
    async json(path, init) {
      const res = await client.fetch(path, init)
      const text = await res.text()
      const data = text.length === 0 ? null : safeJsonParse(text)
      if (!res.ok) {
        throw new ApiError(
          res.status,
          data ?? text,
          `${init?.method ?? "GET"} ${path} -> ${res.status}`
        )
      }
      return data as never
    },
    withToken(nextToken: string) {
      return createApiClient({ baseUrl, token: nextToken })
    },
  }
  return client
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, body: unknown, message: string) {
    super(message)
    this.status = status
    this.body = body
  }
}

/** Build a random identity slug for ad-hoc test users / workspaces. */
export function randomSlug(prefix = "test"): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`
}

/** Convenience: register a fresh user, return { client, user, sessionToken }. */
export interface CreatedUserContext {
  client: ApiClient
  email: string
  password: string
  user: {
    id: string
    email: string
    name: string
  }
  sessionToken: string
}

export async function registerTestUser(
  baseClient: ApiClient,
  options?: { name?: string }
): Promise<CreatedUserContext> {
  const email = `${randomSlug("e2e")}@synapse.test`
  const password = "Test12345!"
  const name = options?.name ?? `Test ${email}`

  const registerRes = await baseClient.json<{
    user: { id: string; email: string; name: string }
    session: { transport: string }
    sessionToken?: string
  }>("/auth/register", {
    method: "POST",
    json: { email, password, name, transport: "token" },
  })

  const sessionToken = registerRes.sessionToken
  if (!sessionToken) {
    throw new Error(
      "register response missing sessionToken; did you pass transport: 'token'?"
    )
  }
  return {
    client: baseClient.withToken(sessionToken),
    email,
    password,
    user: registerRes.user,
    sessionToken,
  }
}

/** Create a fresh workspace owned by the authenticated user. */
export async function createTestWorkspace(
  authedClient: ApiClient,
  options?: { name?: string }
): Promise<{ id: string; name: string; slug: string }> {
  const name = options?.name ?? randomSlug("ws")
  const res = await authedClient.json<{
    id: string
    name: string
    slug: string
  }>("/workspaces", {
    method: "POST",
    json: { name },
  })
  return res
}
