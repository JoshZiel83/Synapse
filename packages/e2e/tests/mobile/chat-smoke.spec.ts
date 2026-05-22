import { test, expect } from "../../fixtures/auth"

test("mobile web root serves the expo bundle", async ({ page }) => {
  const response = await page.goto("/")
  expect(response?.status()).toBeLessThan(400)
  // The mobile app exports a static shell that always contains the Expo
  // router output. We assert the document loaded without 5xx and is
  // non-empty. Deeper checks (login form, tabs) come once we have a
  // logged-in fixture wired for native-RN auth.
  const html = await page.content()
  expect(html.length).toBeGreaterThan(200)
})

test("mobile login page is reachable", async ({ page }) => {
  const response = await page.goto("/login")
  expect(response?.status()).toBeLessThan(400)
})

test("authenticated user has a workspace from the REST API (mobile project)", async ({
  user,
  workspace,
}) => {
  expect(user.sessionToken).toBeTruthy()
  expect(workspace.id).toBeTruthy()
})
