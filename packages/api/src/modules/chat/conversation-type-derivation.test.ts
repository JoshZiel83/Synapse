import test from "node:test"
import assert from "node:assert/strict"
import { withTestDb, withTestDbAndClient } from "../../test/helpers/db.js"
import {
  CONVERSATION_TYPE_MASK_PRESETS,
  maskAllowsConversationType,
} from "@synapse/shared"

type AnyDb = import("kysely").Kysely<any>

// These tests lock in the post-refactor conversation-type invariants that live
// purely in the schema / derivation layer (no boundary axis):
//   1. IM-ness is derived from a conversation_transport_bindings row.
//   2. The binding's conversation must share the binding's workspace (composite
//      FK conversation_transport_bindings(conversation_id, workspace_id) ->
//      conversations(id, workspace_id)).
//   3. The conversation-type capability mask gates direct/group x native/IM.

async function insertUser(db: AnyDb): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({
      email: `u-${Math.random().toString(36).slice(2, 10)}@example.test`,
      name: "test user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspace(db: AnyDb, ownerId: string): Promise<string> {
  const row = await db
    .insertInto("workspaces")
    .values({
      owner_id: ownerId,
      slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
      name: "test workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertConversation(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({ kind: "group", workspace_id: workspaceId, title: "c" })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertAccount(db: AnyDb, workspaceId: string): Promise<string> {
  const row = await db
    .insertInto("transport_accounts")
    .values({
      workspace_id: workspaceId,
      transport_kind: "qq",
      account_key: `acct-${Math.random().toString(36).slice(2, 8)}`,
      display_name: "acct",
      connection_mode: "webhook",
      owner_scope: "workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertEndpoint(
  db: AnyDb,
  transportAccountId: string
): Promise<string> {
  const row = await db
    .insertInto("transport_endpoints")
    .values({
      transport_account_id: transportAccountId,
      endpoint_type: "group",
      external_id: `ep-${Math.random().toString(36).slice(2, 8)}`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "transport binding presence derives IM-ness (EXISTS subquery used by all gate sites)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const nativeConv = await insertConversation(db, workspaceId)
      const imConv = await insertConversation(db, workspaceId)
      const accountId = await insertAccount(db, workspaceId)
      const endpointId = await insertEndpoint(db, accountId)
      await db
        .insertInto("conversation_transport_bindings")
        .values({
          workspace_id: workspaceId,
          conversation_id: imConv,
          transport_account_id: accountId,
          transport_endpoint_id: endpointId,
          outbound_enabled: true,
          inbound_actor_mode: "inherit_account",
        })
        .execute()

      // This is the exact derivation the gate sites use (policy.ts,
      // session/service.ts, chat/service.ts view queries, mcp-endpoint,
      // remote-agents/service.ts): is_im = EXISTS(binding for this conversation).
      const isIm = async (conversationId: string) => {
        const row = await db
          .selectFrom("conversations as c")
          .select((eb) =>
            eb
              .exists(
                eb
                  .selectFrom("conversation_transport_bindings as b")
                  .select("b.id")
                  .whereRef("b.conversation_id", "=", "c.id")
              )
              .as("is_im")
          )
          .where("c.id", "=", conversationId)
          .executeTakeFirstOrThrow()
        return Boolean(row.is_im)
      }

      assert.equal(await isIm(nativeConv), false)
      assert.equal(await isIm(imConv), true)
    })
  }
)

test(
  "conversation_transport_bindings composite FK rejects a cross-workspace binding",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userA = await insertUser(db)
      const wsA = await insertWorkspace(db, userA)
      const userB = await insertUser(db)
      const wsB = await insertWorkspace(db, userB)

      // Conversation in workspace A, account+endpoint in workspace A, but the
      // binding claims workspace B -> the (conversation_id, workspace_id)
      // composite FK to conversations(id, workspace_id) must reject it.
      const convA = await insertConversation(db, wsA)
      const accountB = await insertAccount(db, wsB)
      const endpointB = await insertEndpoint(db, accountB)

      await assert.rejects(
        db
          .insertInto("conversation_transport_bindings")
          .values({
            workspace_id: wsB,
            conversation_id: convA,
            transport_account_id: accountB,
            transport_endpoint_id: endpointB,
            outbound_enabled: true,
            inbound_actor_mode: "inherit_account",
          })
          .execute()
      )
    })
  }
)

test("conversation-type mask gates direct/group x native/IM (pure)", () => {
  // native conversation
  assert.equal(
    maskAllowsConversationType(
      CONVERSATION_TYPE_MASK_PRESETS.NATIVE_ONLY,
      "group",
      false
    ),
    true
  )
  assert.equal(
    maskAllowsConversationType(
      CONVERSATION_TYPE_MASK_PRESETS.NATIVE_ONLY,
      "group",
      true
    ),
    false
  )
  // IM conversation
  assert.equal(
    maskAllowsConversationType(
      CONVERSATION_TYPE_MASK_PRESETS.IM_ONLY,
      "direct",
      true
    ),
    true
  )
  assert.equal(
    maskAllowsConversationType(
      CONVERSATION_TYPE_MASK_PRESETS.IM_ONLY,
      "direct",
      false
    ),
    false
  )
})

// ---- helpers for the binding / address consistency invariants (F2/F3/F4) ----

async function insertAddress(
  db: AnyDb,
  workspaceId: string,
  transportAccountId: string,
  opts: { addressType?: string; workspaceMemberId?: string } = {}
): Promise<string> {
  const row = await db
    .insertInto("transport_addresses")
    .values({
      workspace_id: workspaceId,
      transport_account_id: transportAccountId,
      transport_kind: "qq",
      address_type: opts.addressType ?? "user",
      external_id: `ext-${Math.random().toString(36).slice(2, 8)}`,
      workspace_member_id: opts.workspaceMemberId ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function bindConversation(
  db: AnyDb,
  workspaceId: string,
  conversationId: string,
  accountId: string
): Promise<string> {
  const endpointId = await insertEndpoint(db, accountId)
  await db
    .insertInto("conversation_transport_bindings")
    .values({
      workspace_id: workspaceId,
      conversation_id: conversationId,
      transport_account_id: accountId,
      transport_endpoint_id: endpointId,
      outbound_enabled: true,
      inbound_actor_mode: "inherit_account",
    })
    .execute()
  return endpointId
}

async function addExternalParticipant(
  conversationId: string,
  transportAddressId: string,
  db: AnyDb
): Promise<string> {
  const { ensureConversationParticipant } = await import("./service.js")
  const member = (await ensureConversationParticipant({
    conversationId,
    participantType: "external",
    displayName: "Ext",
    transportAddressId,
    queryable: db as never,
  })) as { id: string }
  return member.id
}

// F4: transport_addresses composite FK rejects an account from another workspace.
test(
  "transport_addresses composite FK rejects a cross-workspace account",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const uA = await insertUser(db)
      const wsA = await insertWorkspace(db, uA)
      const uB = await insertUser(db)
      const wsB = await insertWorkspace(db, uB)
      const accountB = await insertAccount(db, wsB)
      // address claims workspace A but points at account B (workspace B)
      await assert.rejects(
        db
          .insertInto("transport_addresses")
          .values({
            workspace_id: wsA,
            transport_account_id: accountB,
            transport_kind: "qq",
            address_type: "user",
            external_id: "x",
          })
          .execute()
      )
    })
  }
)

// F2: re-binding a conversation to a different account is rejected by
// tg_binding_account_consistency while external participants from the old
// account remain.
test(
  "binding account replacement is rejected while external participants from the old account remain",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const conversationId = await insertConversation(db, workspaceId)
      const accountA = await insertAccount(db, workspaceId)
      await bindConversation(db, workspaceId, conversationId, accountA)
      const addrA = await insertAddress(db, workspaceId, accountA)
      await addExternalParticipant(conversationId, addrA, db)

      // A second account in the same workspace.
      const accountB = await insertAccount(db, workspaceId)
      await assert.rejects(
        db
          .updateTable("conversation_transport_bindings")
          .set({ transport_account_id: accountB })
          .where("conversation_id", "=", conversationId)
          .execute(),
        /cannot change transport_account/
      )
    })
  }
)

// F3: conversation_participant_addresses can't attach an address whose account
// differs from the conversation's binding account (tg_participant_address_
// consistency) — this is the path the linked-member branch would otherwise use.
test(
  "participant address attachment is rejected when the address account != binding account",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberUser = await insertUser(db)
      const memberId = (
        await db
          .insertInto("workspace_members")
          .values({
            workspace_id: workspaceId,
            user_id: memberUser,
            trust_level: "member",
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id as string

      const conversationId = await insertConversation(db, workspaceId)
      const accountA = await insertAccount(db, workspaceId)
      await bindConversation(db, workspaceId, conversationId, accountA)

      // A workspace_member participant (does NOT go through the external
      // account-match trigger).
      const { ensureConversationParticipant } = await import("./service.js")
      const participant = (await ensureConversationParticipant({
        conversationId,
        participantType: "workspace_member",
        workspaceMemberId: memberId,
        queryable: db as never,
      })) as { id: string }

      // An address on a DIFFERENT account (same workspace).
      const accountB = await insertAccount(db, workspaceId)
      const addrB = await insertAddress(db, workspaceId, accountB)

      await assert.rejects(
        db
          .insertInto("conversation_participant_addresses")
          .values({
            conversation_participant_id: participant.id,
            transport_address_id: addrB,
            is_primary: true,
          })
          .execute(),
        /does not match conversation .* binding account/
      )
    })
  }
)

// RF1: re-binding is also blocked by attached participant addresses (not just
// external participants) — e.g. a linked workspace_member's cpa row on account A.
test(
  "binding account replacement is rejected while participant addresses from the old account remain",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberUser = await insertUser(db)
      const memberId = (
        await db
          .insertInto("workspace_members")
          .values({
            workspace_id: workspaceId,
            user_id: memberUser,
            trust_level: "member",
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id as string
      const conversationId = await insertConversation(db, workspaceId)
      const accountA = await insertAccount(db, workspaceId)
      await bindConversation(db, workspaceId, conversationId, accountA)

      // A workspace_member participant with an account-A address attached (the
      // linked-member cpa path). No external participant involved.
      const addrA = await insertAddress(db, workspaceId, accountA)
      const participantId = (
        await db
          .insertInto("conversation_participants")
          .values({
            conversation_id: conversationId,
            subject_id:
              (
                await db
                  .insertInto("access_subjects")
                  .values({
                    kind: "workspace_member",
                    workspace_id: workspaceId,
                    workspace_member_id: memberId,
                  })
                  .onConflict((oc) => oc.doNothing())
                  .returning("id")
                  .executeTakeFirst()
              )?.id ??
              (
                await db
                  .selectFrom("access_subjects")
                  .select("id")
                  .where("workspace_member_id", "=", memberId)
                  .executeTakeFirstOrThrow()
              ).id,
            role_key: "member",
            state: "active",
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id as string
      await db
        .insertInto("conversation_participant_addresses")
        .values({
          conversation_participant_id: participantId,
          transport_address_id: addrA,
          is_primary: true,
        })
        .execute()

      const accountB = await insertAccount(db, workspaceId)
      await assert.rejects(
        db
          .updateTable("conversation_transport_bindings")
          .set({ transport_account_id: accountB })
          .where("conversation_id", "=", conversationId)
          .execute(),
        /participant addresses from another account/
      )
    })
  }
)

// RF2 (soft-delete cutover): conversation_transport_bindings is a persistent
// child — a naked hard delete is now forbidden by sd_reject_delete (the old
// tg_binding_delete_guard orphan-protection is subsumed; the binding is never
// hard-deleted in production). IM-artifact teardown happens by soft-deleting the
// conversation, not by deleting the binding row.
test(
  "standalone binding delete is rejected (soft-delete: hard delete forbidden)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const conversationId = await insertConversation(db, workspaceId)
      const accountA = await insertAccount(db, workspaceId)
      await bindConversation(db, workspaceId, conversationId, accountA)
      const addrA = await insertAddress(db, workspaceId, accountA)
      await addExternalParticipant(conversationId, addrA, db)

      await assert.rejects(
        db
          .deleteFrom("conversation_transport_bindings")
          .where("conversation_id", "=", conversationId)
          .execute(),
        /hard delete of conversation_transport_bindings is forbidden/
      )
    })
  }
)

// RF2 (soft-delete cutover): conversations are soft-deleted, never hard-deleted.
// A hard delete is rejected; soft delete flips deleted_at and the conversation
// disappears from conversations_live while child rows are preserved for audit.
test(
  "conversation hard delete is rejected; soft delete hides it from _live",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const conversationId = await insertConversation(db, workspaceId)
      const accountA = await insertAccount(db, workspaceId)
      await bindConversation(db, workspaceId, conversationId, accountA)
      const addrA = await insertAddress(db, workspaceId, accountA)
      await addExternalParticipant(conversationId, addrA, db)

      // Wrap the rejected delete in a savepoint so its abort doesn't poison the
      // outer test transaction.
      await client.query("SAVEPOINT sd_probe")
      await assert.rejects(
        db
          .deleteFrom("conversations")
          .where("id", "=", conversationId)
          .execute(),
        /hard delete of conversations is forbidden/
      )
      await client.query("ROLLBACK TO SAVEPOINT sd_probe")

      await db
        .updateTable("conversations")
        .set({ deleted_at: new Date() })
        .where("id", "=", conversationId)
        .execute()
      const live = await db
        .selectFrom("conversations_live")
        .select("id")
        .where("id", "=", conversationId)
        .executeTakeFirst()
      assert.equal(
        live,
        undefined,
        "soft-deleted conversation hidden from _live"
      )
      // binding row preserved (no cascade)
      const binding = await db
        .selectFrom("conversation_transport_bindings")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .executeTakeFirst()
      assert.ok(binding, "binding row preserved (no hard cascade)")
    })
  }
)

// RF4: a native (non-IM) conversation can never carry a participant address.
test(
  "participant address attachment is rejected on a native conversation (no binding)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberUser = await insertUser(db)
      const memberId = (
        await db
          .insertInto("workspace_members")
          .values({
            workspace_id: workspaceId,
            user_id: memberUser,
            trust_level: "member",
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id as string

      // Native conversation: NO transport binding.
      const conversationId = await insertConversation(db, workspaceId)
      const accountA = await insertAccount(db, workspaceId)
      const addrA = await insertAddress(db, workspaceId, accountA)

      const { ensureConversationParticipant } = await import("./service.js")
      const participant = (await ensureConversationParticipant({
        conversationId,
        participantType: "workspace_member",
        workspaceMemberId: memberId,
        queryable: db as never,
      })) as { id: string }

      await assert.rejects(
        db
          .insertInto("conversation_participant_addresses")
          .values({
            conversation_participant_id: participant.id,
            transport_address_id: addrA,
            is_primary: true,
          })
          .execute(),
        /has no transport binding/
      )
    })
  }
)

// RR1 (soft-delete cutover): a conversation referenced by a kind='conversation'
// access subject is soft-deleted, not hard-deleted. The subject row is an
// immutable identity-registry entry and is PRESERVED (no cascade) so historical
// scope grants / memory subjects keep resolving.
test(
  "conversation with a conversation-subject: hard delete rejected, subject preserved on soft delete",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const conversationId = await insertConversation(db, workspaceId)

      const { upsertAccessSubject } =
        await import("../access/subject-registry.js")
      const subjectId = await upsertAccessSubject(db as never, {
        kind: "conversation",
        conversationId,
      })
      assert.ok(subjectId)

      // Hard delete is forbidden (savepoint so the abort doesn't poison the tx).
      await client.query("SAVEPOINT sd_probe")
      await assert.rejects(
        db
          .deleteFrom("conversations")
          .where("id", "=", conversationId)
          .execute(),
        /hard delete of conversations is forbidden/
      )
      await client.query("ROLLBACK TO SAVEPOINT sd_probe")

      // Soft delete succeeds; the subject row is preserved (immutable registry).
      await db
        .updateTable("conversations")
        .set({ deleted_at: new Date() })
        .where("id", "=", conversationId)
        .execute()
      const subj = await db
        .selectFrom("access_subjects")
        .select("id")
        .where("id", "=", subjectId)
        .executeTakeFirst()
      assert.ok(subj, "conversation subject preserved (no cascade)")
    })
  }
)

// RR3: getConversationParticipant resolves an existing external participant by
// transportAddressId — the lookup that makes IM re-inbound idempotent (so
// activateConversationParticipant won't re-fire participant_joined).
test(
  "getConversationParticipant finds an existing external participant by transportAddressId",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const conversationId = await insertConversation(db, workspaceId)
      const accountA = await insertAccount(db, workspaceId)
      await bindConversation(db, workspaceId, conversationId, accountA)
      const addrA = await insertAddress(db, workspaceId, accountA)

      const created = await addExternalParticipant(conversationId, addrA, db)

      const { getConversationParticipant } = await import("./service.js")
      const found = await getConversationParticipant({
        conversationId,
        transportAddressId: addrA,
        queryable: db as never,
      })
      assert.ok(found, "existing external participant must be found by address")
      assert.equal(found!.id, created)

      // A different (unattached) address resolves to nothing.
      const addrOther = await insertAddress(db, workspaceId, accountA)
      const none = await getConversationParticipant({
        conversationId,
        transportAddressId: addrOther,
        queryable: db as never,
      })
      assert.equal(none, null)
    })
  }
)

// RR2: invite_actor's static surface mask is native-group-only (excludes IM
// groups) — an actor must not pull more actors into an IM-bridged group.
test("invite_actor mask is native group only (excludes im_group)", () => {
  const mask = CONVERSATION_TYPE_MASK_PRESETS.NATIVE_GROUP_ONLY
  assert.equal(maskAllowsConversationType(mask, "group", false), true)
  assert.equal(maskAllowsConversationType(mask, "group", true), false)
  assert.equal(maskAllowsConversationType(mask, "direct", false), false)
})
