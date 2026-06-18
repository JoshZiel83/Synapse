import test from "node:test"
import assert from "node:assert/strict"
import {
  WHATSAPP_UNOFFICIAL_CONNECTOR_CAPABILITY,
  WHATSAPP_UNOFFICIAL_MESSAGE_CAPABILITIES,
} from "./capabilities.js"

test("connector capability is long_connection-only, direct+group", () => {
  const c = WHATSAPP_UNOFFICIAL_CONNECTOR_CAPABILITY
  assert.equal(c.transportKind, "whatsapp_unofficial")
  assert.deepEqual(c.supportedConnectionModes, ["long_connection"])
  assert.deepEqual(c.supportedEndpointTypes, ["direct", "group"])
  assert.equal(c.supportsDirectMessages, true)
  assert.equal(c.supportsGroupMessages, true)
})

test("message capabilities are coherent (media + mention + reply on; edit/card/stream off)", () => {
  const m = WHATSAPP_UNOFFICIAL_MESSAGE_CAPABILITIES
  assert.equal(m.canEdit, false)
  assert.equal(m.canSendCard, false)
  assert.equal(m.canStream, false)
  assert.equal(m.supportsInteractionPrompt, false)
  assert.equal(m.canReact, true)
  assert.equal(m.canTyping, true)
  assert.equal(m.supportsGroup, true)
  assert.equal(m.supportsMention, true)
  assert.equal(m.supportsReply, true)
  assert.equal(m.supportsImage, true)
  assert.equal(m.supportsFile, true)
  assert.equal(m.supportsVoice, true)
  assert.equal(m.supportsVideo, true)
  assert.equal(m.directMentionPolicy, "attached_only")
  assert.ok(m.maxTextBytes > 0)
})
