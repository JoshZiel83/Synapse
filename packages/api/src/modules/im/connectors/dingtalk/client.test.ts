import test from "node:test"
import assert from "node:assert/strict"
import {
  _resetDingtalkTokenCache,
  getAccessToken,
  isDingtalkBusinessSuccess,
  sendDirectOpenApi,
  sendGroupOpenApi,
  sendViaSessionWebhook,
} from "./client.js"

test("isDingtalkBusinessSuccess: errcode 0 number = success", () => {
  assert.equal(isDingtalkBusinessSuccess({ errcode: 0 }), true)
})

test("isDingtalkBusinessSuccess: errcode '0' string = success after normalization", () => {
  assert.equal(isDingtalkBusinessSuccess({ errcode: "0" }), true)
})

test("isDingtalkBusinessSuccess: code 'ok' = success", () => {
  assert.equal(isDingtalkBusinessSuccess({ code: "ok" }), true)
})

test("isDingtalkBusinessSuccess: success: true = success", () => {
  assert.equal(isDingtalkBusinessSuccess({ success: true }), true)
})

test("isDingtalkBusinessSuccess: empty body falls back to HTTP 2xx success", () => {
  assert.equal(isDingtalkBusinessSuccess({}), true)
})

test("isDingtalkBusinessSuccess: errcode 88001 = failure", () => {
  assert.equal(isDingtalkBusinessSuccess({ errcode: 88001 }), false)
})

test("isDingtalkBusinessSuccess: success:true + errcode 88001 = failure (explicit-failure-first)", () => {
  assert.equal(
    isDingtalkBusinessSuccess({ errcode: 88001, success: true }),
    false
  )
})

test("isDingtalkBusinessSuccess: success: false wins over success signal", () => {
  assert.equal(isDingtalkBusinessSuccess({ errcode: 0, success: false }), false)
})

test("isDingtalkBusinessSuccess: non-ok code value = failure", () => {
  assert.equal(isDingtalkBusinessSuccess({ code: "rate_limited" }), false)
})

test("isDingtalkBusinessSuccess: subCode present = failure", () => {
  assert.equal(
    isDingtalkBusinessSuccess({ subCode: "ROBOT_NOT_AUTHORIZED" }),
    false
  )
})

// ───────────────────────── header / cache tests ─────────────────────────

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

test("sendViaSessionWebhook: sets x-acs-dingtalk-access-token header", async () => {
  const mock = makeMockFetch(() => ({ status: 200, body: { errcode: 0 } }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock.fn as unknown as typeof fetch
  try {
    const r = await sendViaSessionWebhook(
      "https://example.com/wh",
      { msgtype: "markdown", markdown: { title: "t", text: "body" } },
      "TOKEN-XYZ"
    )
    assert.equal(r.httpOk, true)
    assert.equal(
      mock.calls[0].headers["x-acs-dingtalk-access-token"],
      "TOKEN-XYZ"
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("sendViaSessionWebhook: empty 2xx body remains no-signal success-compatible", async () => {
  const mock = makeMockFetch(() => ({ status: 200, rawText: "" }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock.fn as unknown as typeof fetch
  try {
    const r = await sendViaSessionWebhook(
      "https://example.com/wh",
      { msgtype: "text", text: { content: "body" } },
      "TOKEN-XYZ"
    )
    assert.equal(r.httpOk, true)
    assert.deepEqual(r.body, {})
    assert.equal(isDingtalkBusinessSuccess(r.body), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("sendViaSessionWebhook: malformed or non-object provider body is business failure", async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const response of [
      { status: 200, body: [] },
      { status: 200, body: null },
      { status: 200, body: "ok" },
      { status: 200, rawText: "{not-json" },
    ] satisfies MockFetchResponse[]) {
      const mock = makeMockFetch(() => response)
      globalThis.fetch = mock.fn as unknown as typeof fetch
      const r = await sendViaSessionWebhook(
        "https://example.com/wh",
        { msgtype: "text", text: { content: "body" } },
        "TOKEN-XYZ"
      )
      assert.equal(r.httpOk, true)
      assert.equal(r.body.code, "malformed_response")
      assert.equal(isDingtalkBusinessSuccess(r.body), false)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("sendGroupOpenApi: posts to groupMessages/send with token header", async () => {
  const mock = makeMockFetch(() => ({
    status: 200,
    body: { processQueryKey: "pqk-1" },
  }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock.fn as unknown as typeof fetch
  try {
    const r = await sendGroupOpenApi({
      openConversationId: "ocid-1",
      msgKey: "sampleMarkdown",
      msgParam: '{"title":"t","text":"body"}',
      accessToken: "TKN",
    })
    assert.equal(r.body.processQueryKey, "pqk-1")
    assert.ok(mock.calls[0].url.includes("groupMessages/send"))
    assert.equal(mock.calls[0].headers["x-acs-dingtalk-access-token"], "TKN")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("sendGroupOpenApi: non-object provider body is not treated as success", async () => {
  const mock = makeMockFetch(() => ({ status: 200, body: [] }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock.fn as unknown as typeof fetch
  try {
    const r = await sendGroupOpenApi({
      openConversationId: "ocid-1",
      msgKey: "sampleMarkdown",
      msgParam: '{"title":"t","text":"body"}',
      accessToken: "TKN",
    })
    assert.equal(r.httpOk, true)
    assert.equal(r.body.code, "malformed_response")
    assert.equal(isDingtalkBusinessSuccess(r.body), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("sendDirectOpenApi: posts to oToMessages/batchSend with userIds array", async () => {
  const mock = makeMockFetch(() => ({
    status: 200,
    body: { processQueryKey: "pqk-2" },
  }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock.fn as unknown as typeof fetch
  try {
    await sendDirectOpenApi({
      userId: "alice",
      msgKey: "sampleMarkdown",
      msgParam: '{"title":"t","text":"body"}',
      accessToken: "TKN",
    })
    assert.ok(mock.calls[0].url.includes("oToMessages/batchSend"))
    assert.deepEqual((mock.calls[0].body as { userIds: string[] }).userIds, [
      "alice",
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("getAccessToken: cache key includes secret hash (rotation invalidates token)", async () => {
  _resetDingtalkTokenCache()
  let issued = 0
  const mock = makeMockFetch(() => {
    issued += 1
    return {
      status: 200,
      body: { accessToken: `tkn-${issued}`, expireIn: 7200 },
    }
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock.fn as unknown as typeof fetch
  try {
    const a = await getAccessToken({
      id: "acc-1",
      transportKind: "dingtalk",
      credentials: { clientId: "ding-1", clientSecret: "secret-old" },
    } as never)
    const b = await getAccessToken({
      id: "acc-1",
      transportKind: "dingtalk",
      credentials: { clientId: "ding-1", clientSecret: "secret-old" },
    } as never)
    // Same secret → cache hit, only 1 token issued.
    assert.equal(issued, 1)
    assert.equal(a, b)
    const c = await getAccessToken({
      id: "acc-1",
      transportKind: "dingtalk",
      credentials: { clientId: "ding-1", clientSecret: "secret-new" },
    } as never)
    // Different secret → cache miss, 2nd token issued.
    assert.equal(issued, 2)
    assert.notEqual(a, c)
  } finally {
    globalThis.fetch = originalFetch
    _resetDingtalkTokenCache()
  }
})

test("getAccessToken: malformed provider response fails closed", async () => {
  _resetDingtalkTokenCache()
  const mock = makeMockFetch(() => ({ status: 200, body: [] }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock.fn as unknown as typeof fetch
  try {
    await assert.rejects(
      getAccessToken({
        id: "acc-1",
        transportKind: "dingtalk",
        credentials: { clientId: "ding-1", clientSecret: "secret-old" },
      } as never),
      /returned no accessToken/
    )
  } finally {
    globalThis.fetch = originalFetch
    _resetDingtalkTokenCache()
  }
})

test("getAccessToken: non-number expireIn falls back without rejecting valid token", async () => {
  _resetDingtalkTokenCache()
  const mock = makeMockFetch(() => ({
    status: 200,
    body: { accessToken: "tkn-string-expiry", expireIn: "7200" },
  }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock.fn as unknown as typeof fetch
  try {
    const token = await getAccessToken({
      id: "acc-1",
      transportKind: "dingtalk",
      credentials: { clientId: "ding-1", clientSecret: "secret-old" },
    } as never)
    assert.equal(token, "tkn-string-expiry")
  } finally {
    globalThis.fetch = originalFetch
    _resetDingtalkTokenCache()
  }
})
