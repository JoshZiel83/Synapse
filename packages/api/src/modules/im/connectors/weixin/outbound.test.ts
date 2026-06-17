import test from "node:test"
import assert from "node:assert/strict"
import { sendWeixinMessage } from "./outbound.js"

/**
 * Verifies the contextToken source-of-truth for Weixin outbound sends
 * after the refactor that removed the connector → IM service
 * back-reference. The connector now reads `contextToken` from the
 * worker-supplied `recipientAddressMetadata`, with `endpoint.metadata`
 * as fallback.
 *
 * We intercept `globalThis.fetch` so we can inspect the JSON body the
 * connector actually sends to the ilink endpoint and assert that
 * `msg.context_token` comes from the right source.
 */

interface CapturedRequest {
  url: string
  body: string
}

function withFetchStub(
  responseText: string,
  fn: (captured: CapturedRequest[]) => Promise<void>
) {
  return async () => {
    const captured: CapturedRequest[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: any, init?: any) => {
      captured.push({ url: String(url), body: String(init?.body ?? "") })
      return new Response(responseText, { status: 200 })
    }) as typeof fetch
    try {
      await fn(captured)
    } finally {
      globalThis.fetch = original
    }
  }
}

function baseAccount(): any {
  return {
    id: "acc-weixin-1",
    workspaceId: "ws-1",
    transportKind: "weixin",
    accountKey: "primary",
    credentials: { token: "tkn-xyz" },
    config: { baseUrl: "https://ilink.example/" },
  }
}

function endpoint(metadata: Record<string, unknown> = {}): any {
  return {
    endpointType: "direct",
    externalId: "user_peer_1",
    metadata,
  }
}

function textMessage(): any {
  return {
    schemaVersion: 1,
    parts: [{ type: "text", text: "hello" }],
    plainText: "hello",
  }
}

test(
  "contextToken comes from recipientAddressMetadata when provided",
  withFetchStub('{"msg_id":"server_msg_1"}', async (captured) => {
    const result = await sendWeixinMessage({
      account: baseAccount(),
      endpoint: endpoint({ contextToken: "ctx-from-endpoint" }),
      message: textMessage(),
      recipientAddressMetadata: { contextToken: "ctx-from-address-row" },
    })
    assert.equal(captured.length, 1)
    const body = JSON.parse(captured[0].body)
    assert.equal(
      body.msg.context_token,
      "ctx-from-address-row",
      "address-row metadata wins over endpoint metadata"
    )
    assert.equal(result.externalMessageId, "server_msg_1")
  })
)

test(
  "falls back to client_id when provider success response has no message id",
  withFetchStub('{"ret":0,"errcode":0}', async (captured) => {
    const result = await sendWeixinMessage({
      account: baseAccount(),
      endpoint: endpoint({ contextToken: "ctx-from-endpoint" }),
      message: textMessage(),
    })

    const body = JSON.parse(captured[0].body)
    assert.equal(result.externalMessageId, body.msg.client_id)
  })
)

test(
  "rejects malformed provider success response instead of falling back to client_id",
  withFetchStub("{not-json", async () => {
    await assert.rejects(
      sendWeixinMessage({
        account: baseAccount(),
        endpoint: endpoint({ contextToken: "ctx-from-endpoint" }),
        message: textMessage(),
      }),
      /invalid provider response/
    )
  })
)

test(
  "contextToken falls back to endpoint.metadata when recipientAddressMetadata is missing",
  withFetchStub('{"msg_id":"server_msg_2"}', async (captured) => {
    await sendWeixinMessage({
      account: baseAccount(),
      endpoint: endpoint({ contextToken: "ctx-from-endpoint" }),
      message: textMessage(),
      // recipientAddressMetadata intentionally omitted
    })
    const body = JSON.parse(captured[0].body)
    assert.equal(body.msg.context_token, "ctx-from-endpoint")
  })
)

test(
  "contextToken falls back to endpoint.metadata when recipientAddressMetadata.contextToken is missing",
  withFetchStub('{"msg_id":"server_msg_3"}', async (captured) => {
    await sendWeixinMessage({
      account: baseAccount(),
      endpoint: endpoint({ contextToken: "ctx-from-endpoint" }),
      message: textMessage(),
      recipientAddressMetadata: { otherField: "irrelevant" },
    })
    const body = JSON.parse(captured[0].body)
    assert.equal(body.msg.context_token, "ctx-from-endpoint")
  })
)

test(
  "throws when contextToken is missing from both sources",
  withFetchStub("", async (_captured) => {
    await assert.rejects(
      sendWeixinMessage({
        account: baseAccount(),
        endpoint: endpoint({}), // no contextToken
        message: textMessage(),
        // recipientAddressMetadata omitted
      }),
      /is missing contextToken/
    )
  })
)

test(
  "throws when both sources have empty/whitespace contextToken",
  withFetchStub("", async (_captured) => {
    await assert.rejects(
      sendWeixinMessage({
        account: baseAccount(),
        endpoint: endpoint({ contextToken: "   " }),
        message: textMessage(),
        recipientAddressMetadata: { contextToken: "" },
      }),
      /is missing contextToken/
    )
  })
)
