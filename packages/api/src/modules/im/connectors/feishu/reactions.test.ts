/**
 * Restart-recovery test for the Feishu reaction adapter.
 *
 * The hook layer (`integration/actor-status-hooks.ts`) loads the persisted
 * glyph → reaction_id map for an inbound message on startup, passes it to
 * `createStatusReactionAdapter` as `initialReactionIdsByEmoji`, and then
 * calls `removeReaction(glyph)` for each entry to clean up orphans.
 *
 * Before the seeding parameter existed, the adapter's internal id Map was
 * always empty on construction, so removeReaction silently no-op'd and the
 * orphan reactions stuck around forever. These tests pin down both halves
 * of the fix: the seed lands, and the seeded id is what gets passed to the
 * Feishu delete API.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { createFeishuReactionAdapter } from "./reactions.js"

interface DeleteCall {
  message_id: string
  reaction_id: string
}

interface CreateCall {
  message_id: string
  emoji_type: string
}

function makeFakeClient() {
  const deletes: DeleteCall[] = []
  const creates: CreateCall[] = []
  const client = {
    im: {
      messageReaction: {
        create: async ({
          path,
          data,
        }: {
          path: { message_id: string }
          data: { reaction_type: { emoji_type: string } }
        }) => {
          creates.push({
            message_id: path.message_id,
            emoji_type: data.reaction_type.emoji_type,
          })
          return { data: { reaction_id: `rid_${creates.length}` } }
        },
        delete: async ({
          path,
        }: {
          path: { message_id: string; reaction_id: string }
        }) => {
          deletes.push({
            message_id: path.message_id,
            reaction_id: path.reaction_id,
          })
          return { data: {} }
        },
      },
    },
  }
  return { client, deletes, creates }
}

test("removeReaction(glyph) is a no-op when no seed and no prior setReaction", async () => {
  const { client, deletes } = makeFakeClient()
  const adapter = createFeishuReactionAdapter({
    client: client as any,
    messageRef: { externalMessageId: "om_x", endpointExternalId: "oc_y" },
  })
  await adapter.removeReaction!("👀")
  assert.deepEqual(deletes, [], "no id known → no delete should fire")
})

test("removeReaction(glyph) calls delete with the seeded reaction_id", async () => {
  const { client, deletes } = makeFakeClient()
  const adapter = createFeishuReactionAdapter({
    client: client as any,
    messageRef: { externalMessageId: "om_x", endpointExternalId: "oc_y" },
    initialReactionIdsByEmoji: {
      "👀": "rid_eyes_from_prev_run",
      "🧠": "rid_brain_from_prev_run",
    },
  })
  await adapter.removeReaction!("👀")
  assert.deepEqual(deletes, [
    { message_id: "om_x", reaction_id: "rid_eyes_from_prev_run" },
  ])
  await adapter.removeReaction!("🧠")
  assert.deepEqual(deletes, [
    { message_id: "om_x", reaction_id: "rid_eyes_from_prev_run" },
    { message_id: "om_x", reaction_id: "rid_brain_from_prev_run" },
  ])
})

test("removing all seeded reactions notifies onReactionTracked down to empty", async () => {
  const { client } = makeFakeClient()
  const tracked: Array<Record<string, string>> = []
  const adapter = createFeishuReactionAdapter({
    client: client as any,
    messageRef: { externalMessageId: "om_x", endpointExternalId: "oc_y" },
    initialReactionIdsByEmoji: { "👀": "rid_a", "🧠": "rid_b" },
    onReactionTracked: ({ reactionIdsByEmoji }) => {
      tracked.push({ ...reactionIdsByEmoji })
    },
  })
  await adapter.removeReaction!("👀")
  await adapter.removeReaction!("🧠")
  // After both deletes, the persisted map must walk down to {} so the DB
  // row updates to reflect "no live reactions". The hook layer relies on
  // this — without it, every restart would try to re-delete forever.
  assert.equal(tracked.length, 2)
  assert.deepEqual(tracked[0], { "🧠": "rid_b" })
  assert.deepEqual(tracked[1], {})
})

test("removeReaction tolerates client errors and still drops the local id", async () => {
  const calls: string[] = []
  const adapter = createFeishuReactionAdapter({
    client: {
      im: {
        messageReaction: {
          create: async () => ({ data: { reaction_id: "x" } }),
          delete: async () => {
            calls.push("delete")
            throw new Error("network blip")
          },
        },
      },
    } as any,
    messageRef: { externalMessageId: "om_x", endpointExternalId: "oc_y" },
    initialReactionIdsByEmoji: { "👀": "rid_a" },
  })
  await adapter.removeReaction!("👀")
  // even though delete threw, removeReaction should not propagate; the id
  // is forgotten so we don't try the same dead id forever.
  await adapter.removeReaction!("👀")
  assert.equal(calls.length, 1, "second call has no id → no second delete")
})

test("setReaction after seed: previous emoji_id is from seed, gets deleted on switch", async () => {
  const { client, deletes, creates } = makeFakeClient()
  const adapter = createFeishuReactionAdapter({
    client: client as any,
    messageRef: { externalMessageId: "om_x", endpointExternalId: "oc_y" },
    // Pretend a prior process landed on 👀. The adapter doesn't know which
    // glyph was active (only the hook layer does), so setReaction("🧠")
    // here will create the new reaction but NOT delete the seeded 👀 —
    // that's the hook's removeReaction job. This documents the contract.
    initialReactionIdsByEmoji: { "👀": "rid_eyes_seed" },
  })
  await adapter.setReaction("🧠")
  assert.equal(creates.length, 1)
  assert.equal(creates[0].emoji_type, "THINKING")
  // No delete fired because activeEmoji starts null after construction,
  // not at "👀". The hook explicitly calls removeReaction for orphan
  // cleanup before any setReaction.
  assert.deepEqual(deletes, [])
})
