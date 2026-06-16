import test from "node:test"
import assert from "node:assert/strict"
import { postWeixinJson } from "./client.js"

interface CapturedRequest {
  url: string
  body: string
}

function withFetchStub(
  response: { status?: number; text: string },
  fn: (captured: CapturedRequest[]) => Promise<void>
) {
  return async () => {
    const captured: CapturedRequest[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: any, init?: any) => {
      captured.push({ url: String(url), body: String(init?.body ?? "") })
      return new Response(response.text, { status: response.status ?? 200 })
    }) as typeof fetch
    try {
      await fn(captured)
    } finally {
      globalThis.fetch = original
    }
  }
}

function request() {
  return {
    baseUrl: "https://weixin.example/",
    endpoint: "/ilink/bot/getupdates",
    body: { get_updates_buf: "cursor-1", base_info: {} },
    token: "TOKEN",
    timeoutMs: 1_000,
  }
}

test(
  "postWeixinJson parses object provider responses",
  withFetchStub(
    {
      text: JSON.stringify({
        ret: 0,
        errcode: 0,
        get_updates_buf: "cursor-2",
      }),
    },
    async (captured) => {
      const result = await postWeixinJson(request())

      assert.deepEqual(result, {
        ret: 0,
        errcode: 0,
        get_updates_buf: "cursor-2",
      })
      assert.equal(captured.length, 1)
      assert.equal(
        captured[0]!.url,
        "https://weixin.example/ilink/bot/getupdates"
      )
      assert.deepEqual(JSON.parse(captured[0]!.body), request().body)
    }
  )
)

test(
  "postWeixinJson keeps empty 2xx bodies as no-signal success-compatible objects",
  withFetchStub({ text: "" }, async () => {
    assert.deepEqual(await postWeixinJson(request()), {})
  })
)

test("postWeixinJson rejects malformed or non-object provider success bodies", async () => {
  for (const text of ["{not-json", "[]", "null", JSON.stringify("ok")]) {
    await withFetchStub({ text }, async () => {
      await assert.rejects(
        postWeixinJson(request()),
        /Weixin API .* returned (invalid JSON|non-object JSON)/
      )
    })()
  }
})

test(
  "postWeixinJson preserves non-2xx provider errors with raw body",
  withFetchStub({ status: 502, text: "bad gateway" }, async () => {
    await assert.rejects(
      postWeixinJson(request()),
      /Weixin API .* failed with 502: bad gateway/
    )
  })
)
