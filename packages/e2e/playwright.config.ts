import { defineConfig, devices } from "@playwright/test"

const stagingPort = process.env.NGINX_PORT
const stagingHost = process.env.SYNAPSE_STAGING_HOST || "127.0.0.1"

if (!stagingPort) {
  throw new Error(
    "NGINX_PORT not set. Run `source infrastructure/scripts/staging-env.sh` from the repo root before invoking playwright."
  )
}

const baseUrl = `http://${stagingHost}:${stagingPort}`

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "list" : "html",
  timeout: 60_000,
  expect: { timeout: 5_000 },

  use: {
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    extraHTTPHeaders: {
      // Tag staging traffic so server logs can distinguish E2E runs.
      "x-e2e-source": "synapse-e2e",
    },
  },

  projects: [
    {
      name: "web",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `${baseUrl}/`,
      },
      testDir: "./tests/web",
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        baseURL: `${baseUrl}/mobile/`,
      },
      testDir: "./tests/mobile",
    },
  ],
})
