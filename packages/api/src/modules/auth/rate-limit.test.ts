/**
 * Contract test for the auth rate-limit configuration.
 *
 * The production `auth` instance (./better-auth.ts) imports the real DB pool and
 * config at module load, so it's too heavy for a fast unit test. Instead we
 * build a minimal Better Auth instance with the SAME rate-limit + IP config and
 * assert the two properties the feature depends on:
 *
 *   1. /sign-in/email is throttled — the default rule caps it at 3 / 10s, so the
 *      4th attempt returns 429 (the "too many attempts" path the clients map).
 *   2. The limiter keys off X-Forwarded-For, NOT the socket peer. Behind nginx
 *      every request shares one peer IP; without ipAddressHeaders the whole
 *      world would share one bucket. A second IP must start fresh (not 429).
 *
 * If these defaults or the config drift, this test fails loudly. It mirrors the
 * config block in better-auth.ts — keep the two in sync.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"

function makeAuth() {
  return betterAuth({
    secret: "test-secret-0123456789abcdef0123456789ab", // gitleaks:allow -- dummy secret for an isolated test instance
    baseURL: "http://localhost:3001",
    basePath: "/api/v1/auth",
    database: memoryAdapter({
      user: [],
      account: [],
      session: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    // Must match better-auth.ts.
    rateLimit: { enabled: true },
    advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
  })
}

function signInOnce(auth: ReturnType<typeof makeAuth>, forwardedFor: string) {
  const request = new Request(
    "http://localhost:3001/api/v1/auth/sign-in/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": forwardedFor,
      },
      body: JSON.stringify({
        email: "nobody@example.com",
        password: "wrong-password",
      }),
    }
  )
  return auth.handler(request)
}

test("sign-in is rate limited after the default 3 attempts / 10s", async () => {
  const auth = makeAuth()
  const statuses: number[] = []
  for (let i = 0; i < 4; i++) {
    const res = await signInOnce(auth, "203.0.113.1")
    statuses.push(res.status)
  }

  // First three: real credential failures (401). Fourth: rate limited (429).
  assert.deepEqual(statuses.slice(0, 3), [401, 401, 401])
  assert.equal(statuses[3], 429, "4th attempt from one IP should be throttled")
})

test("rate-limit buckets are keyed per X-Forwarded-For client IP", async () => {
  const auth = makeAuth()

  // Burn through one IP's budget until it's throttled.
  let exhausted = false
  for (let i = 0; i < 5; i++) {
    const res = await signInOnce(auth, "203.0.113.2")
    if (res.status === 429) exhausted = true
  }
  assert.ok(exhausted, "the first IP should hit 429 within its window")

  // A different client IP must start with a fresh bucket, not inherit the 429.
  const fresh = await signInOnce(auth, "198.51.100.9")
  assert.notEqual(
    fresh.status,
    429,
    "a different X-Forwarded-For must not share the first IP's bucket"
  )
})
