import test from "node:test"
import assert from "node:assert/strict"
import {
  makeSyntheticMessageId,
  parseSessionWebhookExpiry,
  sendDingtalkMessage,
} from "./outbound.js"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"
import { _resetDingtalkTokenCache } from "./client.js"

// ─────────── pure helpers ───────────

test("parseSessionWebhookExpiry: number ms passes through", () => {
  assert.equal(parseSessionWebhookExpiry(1700003600000), 1700003600000)
})

test("parseSessionWebhookExpiry: number seconds is scaled to ms", () => {
  assert.equal(parseSessionWebhookExpiry(1_700_003_600), 1_700_003_600_000)
})

test("parseSessionWebhookExpiry: numeric string parses", () => {
  assert.equal(parseSessionWebhookExpiry("1700003600000"), 1700003600000)
})

test("parseSessionWebhookExpiry: ISO string parses", () => {
  const iso = "2025-01-01T00:00:00Z"
  assert.equal(parseSessionWebhookExpiry(iso), Date.parse(iso))
})

test("parseSessionWebhookExpiry: garbage returns undefined", () => {
  assert.equal(parseSessionWebhookExpiry("abc"), undefined)
  assert.equal(parseSessionWebhookExpiry(""), undefined)
  assert.equal(parseSessionWebhookExpiry(undefined), undefined)
})

test("makeSyntheticMessageId: bounded length ≤ 60 (well under VARCHAR(255))", () => {
  const longId = "cid:" + "x".repeat(1000)
  const session = makeSyntheticMessageId("session", longId)
  const openapi = makeSyntheticMessageId("openapi", longId)
  assert.ok(session.length <= 60)
  assert.ok(openapi.length <= 60)
  assert.ok(session.startsWith("dingtalk-session:"))
  assert.ok(openapi.startsWith("dingtalk-openapi:"))
})

// ─────────── outbound flow with mocked global fetch ───────────

interface FetchCall {
  kind: "token" | "webhook" | "group" | "direct" | "unknown"
  url: string
  body: unknown
  headers: Record<string, string>
}

interface ResponderInputs {
  call: FetchCall
}

interface CanonicalResponse {
  status: number
  body: unknown
  throws?: Error
}

function classifyUrl(url: string): FetchCall["kind"] {
  if (url.includes("/oauth2/accessToken")) return "token"
  if (url.includes("/robot/groupMessages/send")) return "group"
  if (url.includes("/robot/oToMessages/batchSend")) return "direct"
  if (url.includes("example.com/wh/")) return "webhook"
  return "unknown"
}

interface MockFetchOptions {
  token?: CanonicalResponse
  webhook?: CanonicalResponse
  group?: CanonicalResponse
  direct?: CanonicalResponse
}

function installFetchMock(options: MockFetchOptions) {
  const calls: FetchCall[] = []
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const kind = classifyUrl(url)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const headers: Record<string, string> = {}
    const inHeaders = init?.headers
    if (inHeaders && typeof inHeaders === "object") {
      for (const [k, v] of Object.entries(
        inHeaders as Record<string, string>
      )) {
        headers[k] = v
      }
    }
    const call: FetchCall = { kind, url, body, headers }
    calls.push(call)
    let canned: CanonicalResponse | undefined
    switch (kind) {
      case "token":
        canned = options.token ?? {
          status: 200,
          body: { accessToken: "TKN", expireIn: 7200 },
        }
        break
      case "webhook":
        canned = options.webhook
        break
      case "group":
        canned = options.group
        break
      case "direct":
        canned = options.direct
        break
      default:
        throw new Error(`unmocked URL ${url}`)
    }
    if (!canned) throw new Error(`no canned response for ${kind}: ${url}`)
    if (canned.throws) throw canned.throws
    return new Response(JSON.stringify(canned.body), { status: canned.status })
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = previous
      _resetDingtalkTokenCache()
    },
  }
}

function groupEndpoint(meta: Record<string, unknown> = {}) {
  return {
    endpointType: "group" as const,
    externalId: "cid-group-1",
    metadata: {
      sessionWebhook: "https://example.com/wh/xyz",
      ...meta,
    },
  }
}

function directEndpoint(meta: Record<string, unknown> = {}) {
  return {
    endpointType: "direct" as const,
    externalId: "cid-direct-1",
    metadata: {
      sessionWebhook: "https://example.com/wh/abc",
      ...meta,
    },
  }
}

const ACCOUNT = {
  id: "acc-1",
  transportKind: "dingtalk",
  credentials: { clientId: "ding-1", clientSecret: "secret-1" },
} as never

const SIMPLE_MSG = buildCanonicalMessage([{ type: "text", text: "hello" }])

// ─────────── webhook success / fallback to OpenAPI ───────────

test("outbound: sessionWebhook success returns synthetic 'dingtalk-session:' id", async () => {
  const mock = installFetchMock({
    webhook: { status: 200, body: { errcode: 0 } },
  })
  try {
    const r = await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: groupEndpoint(),
      message: SIMPLE_MSG,
    })
    assert.ok(r.externalMessageId.startsWith("dingtalk-session:"))
    const kinds = mock.calls.map((c) => c.kind)
    assert.deepEqual(kinds, ["token", "webhook"])
    // Check the x-acs-dingtalk-access-token header is set
    assert.equal(mock.calls[1].headers["x-acs-dingtalk-access-token"], "TKN")
  } finally {
    mock.restore()
  }
})

test("outbound: sessionWebhook business failure falls back to group OpenAPI", async () => {
  const mock = installFetchMock({
    webhook: { status: 200, body: { errcode: 88001 } },
    group: { status: 200, body: { processQueryKey: "pqk-group" } },
  })
  try {
    const r = await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: groupEndpoint(),
      message: SIMPLE_MSG,
    })
    assert.equal(r.externalMessageId, "pqk-group")
    const kinds = mock.calls.map((c) => c.kind)
    assert.deepEqual(kinds, ["token", "webhook", "group"])
  } finally {
    mock.restore()
  }
})

test("outbound: sessionWebhook 5xx falls back to OpenAPI", async () => {
  const mock = installFetchMock({
    webhook: { status: 503, body: {} },
    group: { status: 200, body: { processQueryKey: "pqk-g" } },
  })
  try {
    const r = await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: groupEndpoint(),
      message: SIMPLE_MSG,
    })
    assert.equal(r.externalMessageId, "pqk-g")
    const kinds = mock.calls.map((c) => c.kind)
    assert.deepEqual(kinds, ["token", "webhook", "group"])
  } finally {
    mock.restore()
  }
})

test("outbound: sessionWebhook throw falls back to OpenAPI", async () => {
  const mock = installFetchMock({
    webhook: { status: 0, body: {}, throws: new Error("ECONNRESET") },
    group: { status: 200, body: { processQueryKey: "pqk-g" } },
  })
  try {
    await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: groupEndpoint(),
      message: SIMPLE_MSG,
    })
    const kinds = mock.calls.map((c) => c.kind)
    assert.deepEqual(kinds, ["token", "webhook", "group"])
  } finally {
    mock.restore()
  }
})

test("outbound: no sessionWebhook → straight to OpenAPI, still has access token header", async () => {
  const mock = installFetchMock({
    group: { status: 200, body: { processQueryKey: "pqk-g" } },
  })
  try {
    await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: groupEndpoint({ sessionWebhook: undefined }),
      message: SIMPLE_MSG,
    })
    const kinds = mock.calls.map((c) => c.kind)
    assert.deepEqual(kinds, ["token", "group"])
    const groupCall = mock.calls.find((c) => c.kind === "group")!
    assert.equal(groupCall.headers["x-acs-dingtalk-access-token"], "TKN")
  } finally {
    mock.restore()
  }
})

test("outbound: expired sessionWebhook → skip webhook, go to OpenAPI", async () => {
  const mock = installFetchMock({
    group: { status: 200, body: { processQueryKey: "pqk-g" } },
  })
  try {
    await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: groupEndpoint({
        sessionWebhookExpiredTime: Date.now() - 60_000,
      }),
      message: SIMPLE_MSG,
    })
    const kinds = mock.calls.map((c) => c.kind)
    assert.deepEqual(kinds, ["token", "group"])
    // sessionWebhook POST never happened
    assert.equal(
      mock.calls.find((c) => c.kind === "webhook"),
      undefined
    )
  } finally {
    mock.restore()
  }
})

test("outbound: unparseable sessionWebhookExpiredTime → still tries webhook", async () => {
  const mock = installFetchMock({
    webhook: { status: 200, body: { errcode: 0 } },
  })
  try {
    await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: groupEndpoint({ sessionWebhookExpiredTime: "garbage" }),
      message: SIMPLE_MSG,
    })
    assert.ok(mock.calls.some((c) => c.kind === "webhook"))
  } finally {
    mock.restore()
  }
})

test("outbound: OpenAPI success without processQueryKey → synthetic 'dingtalk-openapi:' id", async () => {
  const mock = installFetchMock({
    webhook: { status: 200, body: { errcode: 88001 } },
    group: {
      status: 200,
      body: {
        /* no processQueryKey */
      },
    },
  })
  try {
    const r = await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: groupEndpoint(),
      message: SIMPLE_MSG,
    })
    assert.ok(r.externalMessageId.startsWith("dingtalk-openapi:"))
  } finally {
    mock.restore()
  }
})

test("outbound: OpenAPI 5xx throws (caller maps to failure)", async () => {
  const mock = installFetchMock({
    webhook: { status: 200, body: { errcode: 88001 } },
    group: { status: 503, body: {} },
  })
  try {
    await assert.rejects(
      sendDingtalkMessage({
        account: ACCOUNT,
        endpoint: groupEndpoint(),
        message: SIMPLE_MSG,
      }),
      /groupMessages\/send failed/
    )
  } finally {
    mock.restore()
  }
})

test("outbound: group fallback prefers metadata.openConversationId over endpoint.externalId", async () => {
  const mock = installFetchMock({
    webhook: { status: 200, body: { errcode: 88001 } },
    group: { status: 200, body: { processQueryKey: "pqk-g" } },
  })
  try {
    await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: groupEndpoint({ openConversationId: "ocid-override" }),
      message: SIMPLE_MSG,
    })
    const groupCall = mock.calls.find((c) => c.kind === "group")!
    assert.equal(
      (groupCall.body as { openConversationId: string }).openConversationId,
      "ocid-override"
    )
  } finally {
    mock.restore()
  }
})

// ─────────── single-chat staffId branches (the tricky three) ───────────

test("outbound: direct + webhook succeeds + missing staffId → still succeeds (does NOT throw)", async () => {
  const mock = installFetchMock({
    webhook: { status: 200, body: { errcode: 0 } },
  })
  try {
    const r = await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: directEndpoint(/* no lastSenderStaffId */),
      message: SIMPLE_MSG,
    })
    assert.ok(r.externalMessageId.startsWith("dingtalk-session:"))
    const kinds = mock.calls.map((c) => c.kind)
    assert.deepEqual(kinds, ["token", "webhook"])
    assert.equal(
      mock.calls.find((c) => c.kind === "direct"),
      undefined
    )
  } finally {
    mock.restore()
  }
})

test("outbound: direct + webhook business-fail + missing staffId → throws BEFORE 2nd token / direct OpenAPI", async () => {
  const mock = installFetchMock({
    webhook: { status: 200, body: { errcode: 88001 } },
  })
  try {
    await assert.rejects(
      sendDingtalkMessage({
        account: ACCOUNT,
        endpoint: directEndpoint(),
        message: SIMPLE_MSG,
      }),
      /missing lastSenderStaffId/
    )
    // Token acquired once for the webhook attempt only.
    const tokenCalls = mock.calls.filter((c) => c.kind === "token")
    assert.equal(tokenCalls.length, 1)
    assert.equal(
      mock.calls.find((c) => c.kind === "direct"),
      undefined
    )
  } finally {
    mock.restore()
  }
})

test("outbound: direct + no webhook + missing staffId → throws, no token never acquired", async () => {
  const mock = installFetchMock({})
  try {
    await assert.rejects(
      sendDingtalkMessage({
        account: ACCOUNT,
        endpoint: directEndpoint({ sessionWebhook: undefined }),
        message: SIMPLE_MSG,
      }),
      /missing lastSenderStaffId/
    )
    assert.equal(
      mock.calls.find((c) => c.kind === "token"),
      undefined
    )
    assert.equal(
      mock.calls.find((c) => c.kind === "direct"),
      undefined
    )
  } finally {
    mock.restore()
  }
})

test("outbound: direct + webhook fails + staffId present → falls through to direct OpenAPI", async () => {
  const mock = installFetchMock({
    webhook: { status: 200, body: { errcode: 88001 } },
    direct: { status: 200, body: { processQueryKey: "pqk-direct" } },
  })
  try {
    const r = await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: directEndpoint({ lastSenderStaffId: "alice" }),
      message: SIMPLE_MSG,
    })
    assert.equal(r.externalMessageId, "pqk-direct")
    const directCall = mock.calls.find((c) => c.kind === "direct")!
    assert.deepEqual((directCall.body as { userIds: string[] }).userIds, [
      "alice",
    ])
  } finally {
    mock.restore()
  }
})

test("outbound: lazy token cache — same send never acquires token twice", async () => {
  const mock = installFetchMock({
    webhook: { status: 200, body: { errcode: 88001 } },
    group: { status: 200, body: { processQueryKey: "pqk-g" } },
  })
  try {
    await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: groupEndpoint(),
      message: SIMPLE_MSG,
    })
    const tokenCalls = mock.calls.filter((c) => c.kind === "token")
    assert.equal(tokenCalls.length, 1)
  } finally {
    mock.restore()
  }
})

test("outbound: degrade strips image parts to safe shape before render", async () => {
  const mock = installFetchMock({
    webhook: { status: 200, body: { errcode: 0 } },
  })
  try {
    const msgWithUnsupported = buildCanonicalMessage([
      { type: "text", text: "look:" },
      {
        type: "image",
        fileRef: { url: "https://example.com/x.png", mime: "image/png" },
      },
    ])
    await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: groupEndpoint(),
      message: msgWithUnsupported,
    })
    const webhookCall = mock.calls.find((c) => c.kind === "webhook")!
    const body = webhookCall.body as { markdown?: { text: string } }
    // After degrade, the image is rewritten to a "[图片]" placeholder.
    assert.match(body.markdown?.text ?? "", /\[图片\]/)
  } finally {
    mock.restore()
  }
})
