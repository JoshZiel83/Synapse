import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_STATUS_EMOJIS } from "../../messaging/status-emojis.js"
import {
  TELEGRAM_ALLOWED_REACTIONS,
  createTelegramReactionAdapter,
  defaultStatusGlyphToTelegramReaction,
} from "./reactions.js"

/** Install a fetch stub that records Bot API calls and returns ok:true. */
function stubFetch(): {
  calls: Array<{ method: string; body: Record<string, unknown> }>
  restore: () => void
} {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? ""
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ method, body })
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = orig) }
}

const ACCOUNT = { credentials: { botToken: "123:ABC" } }
const MSG_REF = { externalMessageId: "77", endpointExternalId: "555" }

test("status glyph map: every StatusLevel glyph maps to an allowed reaction", () => {
  const map = defaultStatusGlyphToTelegramReaction()
  for (const glyph of Object.values(DEFAULT_STATUS_EMOJIS)) {
    const mapped = map[glyph]
    assert.ok(mapped, `glyph ${glyph} should map`)
    assert.ok(
      TELEGRAM_ALLOWED_REACTIONS.has(mapped),
      `${glyph} -> ${mapped} must be in the allowed set`
    )
  }
})

test("status glyph map: done => 👍, error => 🤬", () => {
  const map = defaultStatusGlyphToTelegramReaction()
  assert.equal(map[DEFAULT_STATUS_EMOJIS.done], "👍")
  assert.equal(map[DEFAULT_STATUS_EMOJIS.error], "🤬")
})

test("status glyph map: tool/coding => bare ✍ (U+270D, NO trailing VS16)", () => {
  const map = defaultStatusGlyphToTelegramReaction()
  // Real Telegram allowed set is the bare writing-hand U+270D. The VS16 form
  // "✍️" is REACTION_INVALID (400). Assert the exact codepoints, not just
  // string equality, so a re-introduced VS16 fails here.
  const WRITING_HAND = "✍" // bare, no ️
  assert.equal(map[DEFAULT_STATUS_EMOJIS.tool], WRITING_HAND)
  assert.equal(map[DEFAULT_STATUS_EMOJIS.coding], WRITING_HAND)
  assert.equal([...map[DEFAULT_STATUS_EMOJIS.tool]].length, 1)
  assert.equal(map[DEFAULT_STATUS_EMOJIS.tool].codePointAt(0), 0x270d)
  assert.equal(map[DEFAULT_STATUS_EMOJIS.coding].codePointAt(0), 0x270d)
  assert.ok(!map[DEFAULT_STATUS_EMOJIS.tool].includes("️"))
  assert.ok(!map[DEFAULT_STATUS_EMOJIS.coding].includes("️"))
})

test("allowed reaction set contains the bare ✍ and no VS16-bearing glyph", () => {
  assert.ok(TELEGRAM_ALLOWED_REACTIONS.has("✍"))
  assert.ok(!TELEGRAM_ALLOWED_REACTIONS.has("✍️"))
  for (const g of TELEGRAM_ALLOWED_REACTIONS) {
    assert.ok(!g.includes("️"), `${g} must carry no VS16`)
  }
})

test("setReaction: maps a status glyph and calls setMessageReaction", async () => {
  const f = stubFetch()
  try {
    const adapter = createTelegramReactionAdapter({
      account: ACCOUNT,
      messageRef: MSG_REF,
    })
    await adapter.setReaction(DEFAULT_STATUS_EMOJIS.done)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].method, "setMessageReaction")
    assert.deepEqual(f.calls[0].body.reaction, [{ type: "emoji", emoji: "👍" }])
    assert.equal(f.calls[0].body.chat_id, "555")
    assert.equal(f.calls[0].body.message_id, 77)
  } finally {
    f.restore()
  }
})

test("setReaction: out-of-set emoji is skipped (no call)", async () => {
  const f = stubFetch()
  try {
    const adapter = createTelegramReactionAdapter({
      account: ACCOUNT,
      messageRef: MSG_REF,
    })
    await adapter.setReaction("🦄") // not in allowed set, not a status glyph
    assert.equal(f.calls.length, 0)
  } finally {
    f.restore()
  }
})

test("clearReaction: sends empty array after an active reaction", async () => {
  const f = stubFetch()
  try {
    const adapter = createTelegramReactionAdapter({
      account: ACCOUNT,
      messageRef: MSG_REF,
    })
    await adapter.setReaction(DEFAULT_STATUS_EMOJIS.done)
    await adapter.clearReaction?.()
    assert.equal(f.calls.length, 2)
    assert.deepEqual(f.calls[1].body.reaction, [])
  } finally {
    f.restore()
  }
})

test("clearReaction: no-op when nothing active", async () => {
  const f = stubFetch()
  try {
    const adapter = createTelegramReactionAdapter({
      account: ACCOUNT,
      messageRef: MSG_REF,
    })
    await adapter.clearReaction?.()
    assert.equal(f.calls.length, 0)
  } finally {
    f.restore()
  }
})
