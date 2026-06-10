/**
 * Service-level integration for the multi-client membership/list contract.
 *
 * Unlike the participant-projection unit tests (which use the rollback
 * withTestDb harness), these exercise the HIGH-LEVEL service functions, which
 * use the global `db` singleton bound to DATABASE_URL. They are skipped when
 * DATABASE_URL is unset so the default unit run (testcontainer harness) is
 * unaffected; CI / local runs that export DATABASE_URL (a throwaway DB with the
 * current schema bootstrapped) execute them.
 *
 * Covered:
 *  - a removed member's conversation disappears from getChatBootstrap (the
 *    soft-delete-aware active-participant list filter)
 *  - the removed member receives conversation.membership.updated{removed}
 *  - re-adding the member restores the conversation AND emits {active}
 *  - member_seq on the sync stream is contiguous
 */

import { test } from "node:test"
import assert from "node:assert/strict"

const HAS_DB = Boolean(process.env.DATABASE_URL)
const maybe = HAS_DB ? test : test.skip

function rid() {
  return Math.random().toString(36).slice(2, 10)
}

maybe(
  "removal hides the conversation from the removed member and emits membership.updated; re-add restores it",
  { timeout: 5 * 60_000 },
  async () => {
    const { db } = await import("../../infrastructure/database/kysely.js")
    const {
      createChatConversation,
      getChatBootstrap,
      getChatSync,
      removeChatConversationParticipant,
      addConversationParticipants,
    } = await import("./service.js")

    const u1 = (
      await db
        .insertInto("users")
        .values({ email: `a-${rid()}@e.test`, name: "A" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id as string
    const u2 = (
      await db
        .insertInto("users")
        .values({ email: `b-${rid()}@e.test`, name: "B" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id as string
    const ws = (
      await db
        .insertInto("workspaces")
        .values({ ownerId: u1, slug: `ws-${rid()}`, name: "W" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id as string
    const m2 = (
      await db
        .insertInto("workspaceMembers")
        .values({ workspaceId: ws, userId: u2, trustLevel: "member" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id as string
    await db
      .insertInto("workspaceMembers")
      .values({ workspaceId: ws, userId: u1, trustLevel: "member" })
      .returning("id")
      .executeTakeFirstOrThrow()

    const created = await createChatConversation({
      workspaceId: ws,
      userId: u1,
      clientRequestId: crypto.randomUUID(),
      kind: "group",
      title: "T",
      workspaceMemberIds: [m2],
    })
    const cid = created.conversation.conversationId

    const bootBefore = await getChatBootstrap({ workspaceId: ws, userId: u2 })
    assert.ok(
      bootBefore.conversations.some((c) => c.conversationId === cid),
      "removed-to-be member sees the conversation before removal"
    )

    const part = await db
      .selectFrom("conversationParticipants as cp")
      .innerJoin("accessSubjects as s", "s.id", "cp.subjectId")
      .select(["cp.id"])
      .where("cp.conversationId", "=", cid)
      .where("s.workspaceMemberId", "=", m2)
      .executeTakeFirstOrThrow()

    await removeChatConversationParticipant({
      workspaceId: ws,
      userId: u1,
      conversationId: cid,
      participantId: part.id as string,
    })

    const bootAfter = await getChatBootstrap({ workspaceId: ws, userId: u2 })
    assert.equal(
      bootAfter.conversations.some((c) => c.conversationId === cid),
      false,
      "conversation is gone from the removed member's bootstrap list"
    )

    const syncAfter = await getChatSync({
      workspaceId: ws,
      userId: u2,
      cursor: 0,
    })
    const membership = syncAfter.events.filter(
      (e) => e.eventType === "conversation.membership.updated"
    )
    assert.equal(membership.length, 1, "exactly one membership event")
    assert.equal(
      (membership[0]!.payload as { selfState: string }).selfState,
      "removed",
      "removed member is told selfState=removed"
    )

    // Re-add restores the conversation and emits {active}.
    await addConversationParticipants({
      workspaceId: ws,
      conversationId: cid,
      workspaceMemberIds: [m2],
    })
    const bootReadd = await getChatBootstrap({ workspaceId: ws, userId: u2 })
    assert.ok(
      bootReadd.conversations.some((c) => c.conversationId === cid),
      "conversation reappears after re-add"
    )
    const syncReadd = await getChatSync({
      workspaceId: ws,
      userId: u2,
      cursor: 0,
    })
    const selfStates = syncReadd.events
      .filter((e) => e.eventType === "conversation.membership.updated")
      .map((e) => (e.payload as { selfState: string }).selfState)
    assert.deepEqual(
      selfStates,
      ["removed", "active"],
      "re-add emits membership.updated{active} after the earlier {removed}"
    )

    // member_seq must be contiguous on the member's stream.
    const seqs = syncReadd.events.map((e) => e.memberSeq)
    assert.deepEqual(
      seqs,
      seqs.map((_, i) => i + 1),
      "member_seq contiguous 1..N on the sync stream"
    )
  }
)
