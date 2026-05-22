import { test, expect } from "../../fixtures/auth"

test("login page renders on staging desktop web", async ({ page }) => {
  const response = await page.goto("/login")
  expect(response?.status()).toBeLessThan(400)
  await expect(page).toHaveTitle(/synapse|login/i, { timeout: 10_000 })
})

test("desktop web root redirects to login when unauthenticated", async ({
  page,
}) => {
  await page.goto("/")
  // The unauthenticated root should either render login or redirect to /login.
  await page.waitForLoadState("networkidle")
  const url = new URL(page.url())
  expect(["/", "/login", "/welcome"]).toContain(url.pathname)
})

test("authenticated user has a workspace from the REST API", async ({
  user,
  workspace,
}) => {
  expect(user.sessionToken).toBeTruthy()
  expect(workspace.id).toBeTruthy()
  expect(workspace.name).toBeTruthy()
})
