/**
 * S15: typing event end-to-end via WebSocket — true cross-member case.
 *
 * Alice and Bob are both members of workspace W and participants of
 * conversation C. Alice connects WS + subscribes; Bob sends HTTP typing
 * (or inbound WS typing frame). Alice receives {type:"chat.typing"}
 * within 2s. Tests both transport paths so the fanout branch in
 * websocket/index.ts is exercised.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { WebSocket } from "ws"
import {
  createApiClient,
  registerTestUser,
  createTestWorkspace,
} from "./setup.ts"

const uuid = () =>
  ([8, 4, 4, 4, 12] as const)
    .map((len) => randomBytes(len / 2).toString("hex"))
    .join("-")

function wsUrl(): string {
  const explicit = process.env.STAGING_API_URL
  if (explicit && explicit.trim().length > 0) {
    return (
      explicit
        .replace(/^http/, "ws")
        .replace(/\/api\/v1\/?$/, "")
        .replace(/\/$/, "") + "/ws"
    )
  }
  const host = process.env.SYNAPSE_STAGING_HOST || "127.0.0.1"
  const port = process.env.NGINX_PORT
  if (!port) throw new Error("NGINX_PORT not set")
  return `ws://${host}:${port}/ws`
}

interface ConnectedSocket {
  ws: WebSocket
  received: Record<string, unknown>[]
}

async function connectAndAuth(
  token: string,
  workspaceId: string
): Promise<ConnectedSocket> {
  const ws = new WebSocket(wsUrl())
  const received: Record<string, unknown>[] = []
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve())
    ws.on("error", (err) => reject(err))
  })
  ws.on("message", (raw) => {
    try {
      received.push(JSON.parse(raw.toString()))
    } catch {
      // ignore non-JSON frames
    }
  })
  ws.send(JSON.stringify({ type: "auth", token, workspaceId }))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("auth timeout")), 5000)
    const check = () => {
      if (received.some((m) => m.type === "auth.ok")) {
        clearTimeout(timer)
        resolve()
        return
      }
      setTimeout(check, 50)
    }
    check()
  })
  return { ws, received }
}

async function waitForFrame(
  sock: ConnectedSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 3000
): Promise<Record<string, unknown> | null> {
  const start = Date.now()
  return new Promise((resolve) => {
    const check = () => {
      const hit = sock.received.find(predicate)
      if (hit) {
        resolve(hit)
        return
      }
      if (Date.now() - start > timeoutMs) {
        resolve(null)
        return
      }
      setTimeout(check, 50)
    }
    check()
  })
}

async function inviteAndJoin(
  ownerClient: ReturnType<typeof createApiClient>,
  workspaceId: string,
  inviteeClient: ReturnType<typeof createApiClient>
) {
  const invite = await ownerClient.json<{ token: string }>(
    `/workspaces/${workspaceId}/invites`,
    {
      method: "POST",
      json: { maxUses: 1 },
    }
  )
  await inviteeClient.json(`/invites/${invite.token}/redeem`, {
    method: "POST",
    json: {},
  })
}

test("HTTP typing broadcast reaches other-member WS subscribers", async () => {
  const base = createApiClient()
  const alice = await registerTestUser(base)
  const ws = await createTestWorkspace(alice.client)
  const bob = await registerTestUser(base)
  await inviteAndJoin(alice.client, ws.id, bob.client)

  // Build a group conversation that includes both alice + bob.
  const aliceBootstrap = await alice.client.json<{ workspaceMemberId: string }>(
    `/workspaces/${ws.id}/chat/bootstrap`
  )
  const bobBootstrap = await bob.client.json<{ workspaceMemberId: string }>(
    `/workspaces/${ws.id}/chat/bootstrap`
  )

  const created = await alice.client.json<{
    conversation: { conversationId: string }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "group",
      boundary: "internal",
      title: "typing-cross-member",
      workspaceMemberIds: [bobBootstrap.workspaceMemberId],
    },
  })
  const conversationId = created.conversation.conversationId

  // Alice connects + subscribes; Bob will be the typer.
  const aliceSock = await connectAndAuth(alice.sessionToken, ws.id)
  try {
    aliceSock.ws.send(
      JSON.stringify({
        type: "subscribe",
        topic: "conversation",
        conversationId,
        key: `conv:${conversationId}:alice`,
      })
    )
    await new Promise((r) => setTimeout(r, 200))

    // Bob (different workspace_member) POSTs typing via HTTP.
    await bob.client.json(
      `/workspaces/${ws.id}/chat/conversations/${conversationId}/typing`,
      { method: "POST", json: { state: "started" } }
    )

    const typingFrame = await waitForFrame(
      aliceSock,
      (m) => m.type === "chat.typing",
      3000
    )
    assert.ok(typingFrame, "alice must receive bob's typing")
    const payload = typingFrame!.payload as {
      conversationId: string
      fromWorkspaceMemberId: string
      state: string
    }
    assert.equal(payload.conversationId, conversationId)
    assert.equal(payload.fromWorkspaceMemberId, bobBootstrap.workspaceMemberId)
    assert.equal(payload.state, "started")
    void aliceBootstrap
  } finally {
    aliceSock.ws.close()
  }
})

test("WS inbound {type:'typing'} broadcasts to other-member subscribers", async () => {
  const base = createApiClient()
  const alice = await registerTestUser(base)
  const ws = await createTestWorkspace(alice.client)
  const bob = await registerTestUser(base)
  await inviteAndJoin(alice.client, ws.id, bob.client)

  const bobBootstrap = await bob.client.json<{ workspaceMemberId: string }>(
    `/workspaces/${ws.id}/chat/bootstrap`
  )
  const created = await alice.client.json<{
    conversation: { conversationId: string }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "group",
      boundary: "internal",
      title: "typing-inbound-ws",
      workspaceMemberIds: [bobBootstrap.workspaceMemberId],
    },
  })
  const conversationId = created.conversation.conversationId

  const aliceSock = await connectAndAuth(alice.sessionToken, ws.id)
  const bobSock = await connectAndAuth(bob.sessionToken, ws.id)
  try {
    aliceSock.ws.send(
      JSON.stringify({
        type: "subscribe",
        topic: "conversation",
        conversationId,
        key: `conv:${conversationId}:alice`,
      })
    )
    bobSock.ws.send(
      JSON.stringify({
        type: "subscribe",
        topic: "conversation",
        conversationId,
        key: `conv:${conversationId}:bob`,
      })
    )
    await new Promise((r) => setTimeout(r, 200))

    // Bob sends inbound WS typing.
    bobSock.ws.send(
      JSON.stringify({
        type: "typing",
        conversationId,
        state: "started",
      })
    )

    const typingFrame = await waitForFrame(
      aliceSock,
      (m) => m.type === "chat.typing",
      3000
    )
    assert.ok(typingFrame, "alice must receive bob's inbound-WS typing")

    // Bob should NOT receive their own typing back.
    const selfEcho = bobSock.received.find((m) => m.type === "chat.typing")
    assert.equal(selfEcho, undefined, "bob should not see self-echo")
  } finally {
    aliceSock.ws.close()
    bobSock.ws.close()
  }
})
