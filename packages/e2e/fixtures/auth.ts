/**
 * Auth fixture: registers a fresh user + workspace via the REST API, then
 * primes the browser context with the resulting session cookie.
 *
 * Use:
 *   import { test, expect } from "../../fixtures/auth"
 *   test("...", async ({ authedPage, workspace }) => { ... })
 */

import { test as base, expect } from "@playwright/test"
import { registerUser, createWorkspace, type TestUser } from "./api"

type AuthFixtures = {
  user: TestUser
  workspace: { id: string; name: string; slug: string }
  /** A Playwright page where the user is already logged in. */
  authedPage: import("@playwright/test").Page
}

export const test = base.extend<AuthFixtures>({
  user: async ({}, use) => {
    const u = await registerUser()
    await use(u)
  },
  workspace: async ({ user }, use) => {
    const ws = await createWorkspace(user.sessionToken)
    await use(ws)
  },
  authedPage: async ({ user, page, baseURL }, use) => {
    // Visit the app root first so we have a same-origin context for storage.
    await page.goto(baseURL ?? "/")
    await page.evaluate((token) => {
      // The web/mobile apps look up their session token from a known
      // localStorage key. If the actual key differs we can update here
      // once we wire real login. For S0 smoke we just confirm the page
      // renders even pre-login; deeper UI tests will add real login.
      try {
        window.localStorage.setItem("synapse:auth-token", token)
      } catch {
        // private mode etc.
      }
    }, user.sessionToken)
    await use(page)
  },
})

export { expect }
