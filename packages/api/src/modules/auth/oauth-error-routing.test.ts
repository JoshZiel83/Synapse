/**
 * Routing of OAuth callback EARLY errors (provider cancelled / no code) across
 * web and native, plus the CSRF binding that guards the interceptor.
 *
 * Tests `resolveOAuthErrorRedirect` directly with a test-transaction executor so
 * the verification lookup sees the same uncommitted rows we insert. (Going
 * through the global `db` + Fastify inject wouldn't see the test transaction.)
 */

import test from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"

import { config } from "../../config/index.js"
import { withTestDb } from "../../test/helpers/db.js"
import { isOAuthCallbackEarlyError } from "./index.js"
import { resolveOAuthErrorRedirect } from "./oauth-error-routing.js"

// Replicate Better Auth's signed-cookie value: `${state}.${base64(HMAC(state))}`.
function signedStateCookie(state: string): string {
  const sig = createHmac("sha256", config.auth.secret)
    .update(state)
    .digest("base64")
  return `${state}.${sig}`
}

function futureExpiry(): string {
  // 10 min out; Timestamp column accepts an ISO string.
  return new Date(Date.now() + 10 * 60_000).toISOString()
}

function stateRow(
  state: string,
  payload: Record<string, unknown>
): { identifier: string; value: string; expires_at: string } {
  return {
    identifier: state,
    // A valid state carries oauthState + a finite future expiresAt (Better
    // Auth's stateDataSchema requires `expiresAt: z.number()`). Callers can
    // override either by passing it in `payload`.
    value: JSON.stringify({
      oauthState: state,
      expiresAt: Date.now() + 600_000,
      ...payload,
    }),
    expires_at: futureExpiry(),
  }
}

const WEB_BASE = config.auth.baseUrl

test("native flow: deep-links the error to the stored app scheme (full prefix)", async () => {
  await withTestDb(async (db) => {
    const state = "st_native_1"
    await db
      .insertInto("verification")
      .values(
        stateRow(state, {
          callbackURL: "synapse:///",
          errorURL: "synapse:///",
          expiresAt: Date.now() + 600_000,
        })
      )
      .execute()

    const { target, consumed } = await resolveOAuthErrorRedirect({
      executor: db,
      state,
      stateCookieValue: signedStateCookie(state),
      errorCode: "access_denied",
    })

    assert.ok(
      target.startsWith("synapse:///"),
      `expected full synapse:/// prefix, got ${target}`
    )
    assert.match(target, /error=access_denied/)
    assert.equal(consumed, true)
  })
})

test("native flow falls back to callbackURL when errorURL is absent", async () => {
  await withTestDb(async (db) => {
    const state = "st_native_2"
    await db
      .insertInto("verification")
      .values(stateRow(state, { callbackURL: "synapse:///" }))
      .execute()

    const { target, consumed } = await resolveOAuthErrorRedirect({
      executor: db,
      state,
      stateCookieValue: signedStateCookie(state),
      errorCode: "access_denied",
    })

    assert.ok(target.startsWith("synapse:///"))
    assert.equal(consumed, true)
  })
})

test("web flow: routes to the web callback on the configured base", async () => {
  await withTestDb(async (db) => {
    const state = "st_web_1"
    await db
      .insertInto("verification")
      .values(stateRow(state, { errorURL: "/auth/callback" }))
      .execute()

    const { target, consumed } = await resolveOAuthErrorRedirect({
      executor: db,
      state,
      stateCookieValue: signedStateCookie(state),
      errorCode: "access_denied",
    })

    assert.equal(
      target,
      `${new URL("/auth/callback", WEB_BASE).origin}/auth/callback?error=access_denied`
    )
    assert.equal(consumed, true)
  })
})

test("no state -> web fallback, nothing consumed", async () => {
  await withTestDb(async (db) => {
    const { target, consumed } = await resolveOAuthErrorRedirect({
      executor: db,
      state: undefined,
      stateCookieValue: undefined,
      errorCode: "access_denied",
    })
    assert.match(target, /\/auth\/callback\?error=access_denied$/)
    assert.equal(consumed, false)
  })
})

test("CSRF: missing / wrong / mismatched signed cookie -> web fallback, row NOT consumed", async () => {
  await withTestDb(async (db) => {
    const state = "st_csrf"
    await db
      .insertInto("verification")
      .values(stateRow(state, { callbackURL: "synapse:///" }))
      .execute()

    const badCookies = [
      undefined, // no cookie
      `${state}.not-a-valid-signature`, // bad signature
      signedStateCookie("a-different-state"), // signs a different value
    ]
    for (const stateCookieValue of badCookies) {
      const { target, consumed } = await resolveOAuthErrorRedirect({
        executor: db,
        state,
        stateCookieValue,
        errorCode: "access_denied",
      })
      assert.match(target, /\/auth\/callback\?error=access_denied$/)
      assert.equal(consumed, false)
    }

    // The forged attempts must not have deleted the row (we never report
    // consumed:true for them; the interceptor only deletes on consumed:true).
    const stillThere = await db
      .selectFrom("verification")
      .where("identifier", "=", state)
      .select("identifier")
      .executeTakeFirst()
    assert.ok(stillThere, "verification row must survive forged requests")
  })
})

test("expired state (db or payload) -> web fallback", async () => {
  await withTestDb(async (db) => {
    const state = "st_expired"
    await db
      .insertInto("verification")
      .values({
        identifier: state,
        value: JSON.stringify({
          oauthState: state,
          callbackURL: "synapse:///",
          expiresAt: Date.now() - 1000, // payload already expired
        }),
        expires_at: futureExpiry(),
      })
      .execute()

    const { target, consumed } = await resolveOAuthErrorRedirect({
      executor: db,
      state,
      stateCookieValue: signedStateCookie(state),
      errorCode: "access_denied",
    })
    assert.match(target, /\/auth\/callback\?error=access_denied$/)
    assert.equal(consumed, false)
  })
})

test("oauthState mismatch in stored payload -> web fallback", async () => {
  await withTestDb(async (db) => {
    const state = "st_mismatch"
    await db
      .insertInto("verification")
      .values({
        identifier: state,
        value: JSON.stringify({
          oauthState: "something-else",
          callbackURL: "synapse:///",
        }),
        expires_at: futureExpiry(),
      })
      .execute()

    const { consumed } = await resolveOAuthErrorRedirect({
      executor: db,
      state,
      stateCookieValue: signedStateCookie(state),
      errorCode: "access_denied",
    })
    assert.equal(consumed, false)
  })
})

test("disallowed scheme (javascript:) is never treated as native", async () => {
  await withTestDb(async (db) => {
    const state = "st_evil"
    await db
      .insertInto("verification")
      .values(stateRow(state, { callbackURL: "javascript://evil" }))
      .execute()

    const { target } = await resolveOAuthErrorRedirect({
      executor: db,
      state,
      stateCookieValue: signedStateCookie(state),
      errorCode: "access_denied",
    })
    assert.ok(target.startsWith(WEB_BASE) || target.includes("/auth/callback"))
    assert.ok(!target.startsWith("javascript:"))
  })
})

test("malicious error code is normalized and never injects into Location", async () => {
  await withTestDb(async (db) => {
    const state = "st_inject"
    await db
      .insertInto("verification")
      .values(stateRow(state, { errorURL: "/auth/callback" }))
      .execute()

    const { target } = await resolveOAuthErrorRedirect({
      executor: db,
      state,
      stateCookieValue: signedStateCookie(state),
      errorCode: "bad\r\nLocation: javascript:alert(1)",
    })
    assert.doesNotMatch(target, /[\r\n]/)
    assert.match(target, /error=oauth_error$/)
  })
})

test("malformed state (missing/non-number expiresAt) -> web fallback, not consumed", async () => {
  await withTestDb(async (db) => {
    // Missing expiresAt
    await db
      .insertInto("verification")
      .values({
        identifier: "st_no_exp",
        value: JSON.stringify({
          oauthState: "st_no_exp",
          callbackURL: "synapse:///",
        }),
        expires_at: futureExpiry(),
      })
      .execute()
    // Non-number expiresAt
    await db
      .insertInto("verification")
      .values({
        identifier: "st_bad_exp",
        value: JSON.stringify({
          oauthState: "st_bad_exp",
          callbackURL: "synapse:///",
          expiresAt: "soon",
        }),
        expires_at: futureExpiry(),
      })
      .execute()

    for (const state of ["st_no_exp", "st_bad_exp"]) {
      const { target, consumed } = await resolveOAuthErrorRedirect({
        executor: db,
        state,
        stateCookieValue: signedStateCookie(state),
        errorCode: "access_denied",
      })
      assert.match(target, /\/auth\/callback\?error=access_denied$/)
      assert.equal(consumed, false, `${state} must not be consumed`)
    }
  })
})

test("web flow preserves the stored return URL's redirect/path context", async () => {
  await withTestDb(async (db) => {
    const state = "st_web_redirect"
    // The popup helper threads ?redirect= into the callback URL it stores.
    await db
      .insertInto("verification")
      .values(
        stateRow(state, {
          errorURL: "/auth/callback?redirect=%2Fdashboard%2Fsettings",
        })
      )
      .execute()

    const { target, consumed } = await resolveOAuthErrorRedirect({
      executor: db,
      state,
      stateCookieValue: signedStateCookie(state),
      errorCode: "access_denied",
    })
    const url = new URL(target)
    assert.equal(url.origin, new URL(WEB_BASE).origin)
    assert.equal(url.pathname, "/auth/callback")
    assert.equal(url.searchParams.get("redirect"), "/dashboard/settings")
    assert.equal(url.searchParams.get("error"), "access_denied")
    assert.equal(consumed, true)
  })
})

test("web flow ignores a cross-origin stored errorURL (falls back to web base)", async () => {
  await withTestDb(async (db) => {
    const state = "st_web_evil"
    await db
      .insertInto("verification")
      .values(
        stateRow(state, { errorURL: "https://evil.example.com/auth/callback" })
      )
      .execute()

    const { target } = await resolveOAuthErrorRedirect({
      executor: db,
      state,
      stateCookieValue: signedStateCookie(state),
      errorCode: "access_denied",
    })
    assert.equal(new URL(target).origin, new URL(WEB_BASE).origin)
  })
})

// --- wiring: the interceptor trigger predicate (no DB needed) ---

test("wiring: GET callback with ?error= is intercepted", () => {
  const sp = new URLSearchParams({ error: "access_denied", state: "x" })
  assert.equal(
    isOAuthCallbackEarlyError("GET", "/api/v1/auth/oauth2/callback/feishu", sp),
    true
  )
})

test("wiring: GET callback with no code (no error) is intercepted", () => {
  assert.equal(
    isOAuthCallbackEarlyError(
      "GET",
      "/api/v1/auth/oauth2/callback/feishu",
      new URLSearchParams()
    ),
    true
  )
})

test("wiring: happy path (?code=, no error) is NOT intercepted", () => {
  const sp = new URLSearchParams({ code: "abc", state: "x" })
  assert.equal(
    isOAuthCallbackEarlyError("GET", "/api/v1/auth/oauth2/callback/feishu", sp),
    false
  )
})

test("wiring: non-callback auth paths and non-GET are NOT intercepted", () => {
  const err = new URLSearchParams({ error: "access_denied" })
  // sign-in endpoint, not the callback
  assert.equal(
    isOAuthCallbackEarlyError("GET", "/api/v1/auth/sign-in/oauth2", err),
    false
  )
  // POST to the callback path
  assert.equal(
    isOAuthCallbackEarlyError(
      "POST",
      "/api/v1/auth/oauth2/callback/feishu",
      err
    ),
    false
  )
})
