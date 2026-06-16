import test from "node:test"
import assert from "node:assert/strict"
import {
  _resetQqTokenCacheForTests,
  getAccessToken,
  qqApiFetch,
} from "./client.js"

interface FetchCall {
  url: string
  headers: Record<string, string>
  body: unknown
}

interface MockFetchResponse {
  status: number
  body?: unknown
  rawText?: string
}

function makeMockFetch(responder: (call: FetchCall) => MockFetchResponse) {
  const calls: FetchCall[] = []
  const fn = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    const headers: Record<string, string> = {}
    const inputHeaders = init?.headers
    if (inputHeaders && typeof inputHeaders === "object") {
      for (const [k, v] of Object.entries(
        inputHeaders as Record<string, string>
      )) {
        headers[k] = v
      }
    }
    const url = typeof input === "string" ? input : input.toString()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const call: FetchCall = { url, headers, body }
    calls.push(call)
    const out = responder(call)
    return new Response(out.rawText ?? JSON.stringify(out.body), {
      status: out.status,
    })
  }
  return { fn, calls }
}

test("getAccessToken: parses object response and caches token by appId", async () => {
  _resetQqTokenCacheForTests()
  let issued = 0
  const mock = makeMockFetch(() => {
    issued += 1
    return {
      status: 200,
      body: { access_token: `token-${issued}`, expires_in: 7200 },
    }
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock.fn as unknown as typeof fetch
  try {
    const creds = { appId: "app-1", clientSecret: "secret-1" }
    const first = await getAccessToken(creds)
    const second = await getAccessToken(creds)

    assert.equal(first, "token-1")
    assert.equal(second, "token-1")
    assert.equal(issued, 1)
  } finally {
    globalThis.fetch = originalFetch
    _resetQqTokenCacheForTests()
  }
})

test("getAccessToken: numeric string expires_in keeps valid token accepted", async () => {
  _resetQqTokenCacheForTests()
  const mock = makeMockFetch(() => ({
    status: 200,
    body: { access_token: "token-string-ttl", expires_in: "7200" },
  }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock.fn as unknown as typeof fetch
  try {
    const token = await getAccessToken({
      appId: "app-1",
      clientSecret: "secret-1",
    })
    assert.equal(token, "token-string-ttl")
  } finally {
    globalThis.fetch = originalFetch
    _resetQqTokenCacheForTests()
  }
})

test("getAccessToken: malformed or non-object provider body fails closed", async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const response of [
      { status: 200, body: [] },
      { status: 200, body: null },
      { status: 200, body: "ok" },
      { status: 200, rawText: "{not-json" },
    ] satisfies MockFetchResponse[]) {
      _resetQqTokenCacheForTests()
      const mock = makeMockFetch(() => response)
      globalThis.fetch = mock.fn as unknown as typeof fetch

      await assert.rejects(
        getAccessToken({
          appId: "app-1",
          clientSecret: "secret-1",
        }),
        /QQ getAppAccessToken returned no token: code=malformed_response/
      )
    }
  } finally {
    globalThis.fetch = originalFetch
    _resetQqTokenCacheForTests()
  }
})

test("qqApiFetch: adds QQBot bearer token from decoded token response", async () => {
  _resetQqTokenCacheForTests()
  const mock = makeMockFetch((call) => {
    if (call.url.includes("getAppAccessToken")) {
      return {
        status: 200,
        body: { access_token: "token-for-api", expires_in: 7200 },
      }
    }
    return { status: 200, body: { ok: true } }
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock.fn as unknown as typeof fetch
  try {
    await qqApiFetch(
      { credentials: { appId: "app-1", clientSecret: "secret-1" } },
      "/v2/test",
      { method: "POST", body: JSON.stringify({ hello: "world" }) }
    )
    const apiCall = mock.calls.find((call) => call.url.includes("/v2/test"))
    assert.equal(apiCall?.headers.Authorization, "QQBot token-for-api")
  } finally {
    globalThis.fetch = originalFetch
    _resetQqTokenCacheForTests()
  }
})
