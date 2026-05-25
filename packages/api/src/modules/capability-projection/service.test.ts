// Unit test for capability-projection routing facade. Verifies the principal
// kind discriminator dispatches to the right legacy resolver and rejects
// unsupported principals.

import test from "node:test"
import assert from "node:assert/strict"
import { projectToolsForPrincipal } from "./service.js"

test("projectToolsForPrincipal rejects workspace_member principal in v3.0", async () => {
  await assert.rejects(
    () =>
      projectToolsForPrincipal({
        workspaceId: "00000000-0000-0000-0000-000000000001",
        principal: {
          kind: "workspace_member",
          workspaceId: "00000000-0000-0000-0000-000000000001",
          workspaceMemberId: "00000000-0000-0000-0000-000000000002",
        },
        consumer: "dashboard",
      }),
    /workspace_member principal is dashboard-only/
  )
})

test("projectToolsForPrincipal rejects chat-runtime principal without conversationId", async () => {
  await assert.rejects(
    () =>
      projectToolsForPrincipal({
        workspaceId: "00000000-0000-0000-0000-000000000001",
        principal: {
          kind: "actor",
          actorId: "00000000-0000-0000-0000-000000000003",
        },
        consumer: "chat_runtime",
      }),
    /conversationId is required/
  )
})

// Per Issue P (PR #22): pure-conversation principal is now supported — the
// legacy MCP-plugin resolver short-circuits to an empty surface and the
// device-tool projection handles the rest without requiring an actorId. The
// "actorId is required" assertion that used to live here was deleted along
// with the limitation it described.
