import assert from "node:assert/strict"
import test from "node:test"

import { refreshFeishuUserAccessToken } from "./auth.js"

async function withFetch<T>(
  handler: typeof fetch,
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test("refreshFeishuUserAccessToken requires provider responses to be JSON objects", async () => {
  const input = {
    brand: "feishu" as const,
    openBaseUrl: "https://open.feishu.example",
    appId: "app-id",
    appSecret: "app-secret",
    refreshToken: "old-refresh",
  }

  await withFetch(
    (async () =>
      new Response(
        JSON.stringify({
          access_token: "next-access",
          refresh_token: "next-refresh",
          expires_in: 3600,
          refresh_token_expires_in: 86400,
          scope: "offline_access docs:read",
          token_type: "Bearer",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )) as typeof fetch,
    async () => {
      assert.deepEqual(await refreshFeishuUserAccessToken(input), {
        accessToken: "next-access",
        refreshToken: "next-refresh",
        expiresIn: 3600,
        refreshExpiresIn: 86400,
        scope: "offline_access docs:read",
        tokenType: "Bearer",
      })
    }
  )

  for (const body of ["[1,2,3]", "null", '"scalar"']) {
    await withFetch(
      (async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      async () => {
        await assert.rejects(refreshFeishuUserAccessToken(input), {
          message: "Feishu auth response must be a JSON object.",
        })
      }
    )
  }

  await withFetch(
    (async () =>
      new Response("{not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    async () => {
      await assert.rejects(refreshFeishuUserAccessToken(input), {
        message: "Feishu auth response must be valid JSON.",
      })
    }
  )
})
