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

function makeMockFetch(
  responder: (call: FetchCall) => { status: number; body: unknown }
) {
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
    return new Response(JSON.stringify(out.body), { status: out.status })
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
