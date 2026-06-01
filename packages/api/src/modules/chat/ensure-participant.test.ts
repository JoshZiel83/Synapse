import test from "node:test"
import assert from "node:assert/strict"
import { withTestDbAndClient } from "../../test/helpers/db.js"

type AnyDb = import("kysely").Kysely<any>

async function insertUser(db: AnyDb): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({
      email: `u-${Math.random().toString(36).slice(2, 10)}@example.test`,
      name: "test user",
      password_hash: "unused-hash",
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

async function insertWorkspaceMember(
  db: AnyDb,
  workspaceId: string,
  userId: string
): Promise<string> {
  const row = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: workspaceId,
      user_id: userId,
      trust_level: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertActor(db: AnyDb, workspaceId: string): Promise<string> {
  const row = await db
    .insertInto("actors")
    .values({
      workspace_id: workspaceId,
      name: "test actor",
      role: "assistant",
      title: "test",
      current_version: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

// A plain (non-IM) conversation: workspace-scoped, no transport binding.
async function insertConversation(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      workspace_id: workspaceId,
      title: "test conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

// An IM conversation = a normal conversation WITH a transport binding. The
// boundary axis is gone; "IM-ness" is derived purely from the presence of a
// conversation_transport_bindings row. The external-participant trigger also
// requires the participant's transport address to belong to the SAME account
// the conversation is bound to, so we return the binding account id so callers
// can mint addresses on it (see insertTransportAddress's transportAccountId).
async function insertTransportAccount(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const account = await db
    .insertInto("transport_accounts")
    .values({
      workspace_id: workspaceId,
      transport_kind: "qq",
      account_key: `acct-${Math.random().toString(36).slice(2, 8)}`,
      display_name: "Test account",
      connection_mode: "webhook",
      owner_scope: "workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return account.id as string
}

async function insertImConversation(
  db: AnyDb,
  workspaceId: string,
  opts: { transportAccountId?: string } = {}
): Promise<{ conversationId: string; transportAccountId: string }> {
  const transportAccountId =
    opts.transportAccountId ?? (await insertTransportAccount(db, workspaceId))
  const endpoint = await db
    .insertInto("transport_endpoints")
    .values({
      transport_account_id: transportAccountId,
      endpoint_type: "group",
      external_id: `ep-${Math.random().toString(36).slice(2, 8)}`,
      display_name: "Test endpoint",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const conv = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      workspace_id: workspaceId,
      title: "im conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  await db
    .insertInto("conversation_transport_bindings")
    .values({
      workspace_id: workspaceId,
      conversation_id: conv.id as string,
      transport_account_id: transportAccountId,
      transport_endpoint_id: endpoint.id as string,
      outbound_enabled: true,
      inbound_actor_mode: "inherit_account",
    })
    .execute()
  return {
    conversationId: conv.id as string,
    transportAccountId,
  }
}

test(
  "ensureConversationParticipant inserts then updates without writing dropped polymorphic columns",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const actorId = await insertActor(db, workspaceId)
      const conversationId = await insertConversation(db, workspaceId)

      const { ensureConversationParticipant } = await import("./service.js")

      const first = await ensureConversationParticipant({
        conversationId,
        participantType: "actor",
        actorId,
        roleKey: "member",
        displayName: "first display",
        queryable: db,
      })
      assert.ok(first)
      const firstId = (first as { id: string }).id
      assert.ok(firstId)

      // Hit the existing-participant UPDATE branch.
      const again = await ensureConversationParticipant({
        conversationId,
        participantType: "actor",
        actorId,
        roleKey: "owner",
        displayName: "second display",
        metadata: { rejoined: true },
        queryable: db,
      })
      assert.ok(again)
      const againId = (again as { id: string }).id
      assert.equal(againId, firstId)

      const row = await db
        .selectFrom("conversation_participants")
        .selectAll()
        .where("id", "=", firstId)
        .executeTakeFirstOrThrow()
      assert.equal(row.role_key, "owner")
      assert.equal(row.display_name, "second display")
      assert.equal(row.state, "active")
      assert.ok(row.subject_id)
    })
  }
)

test(
  "ensureConversationParticipant (workspace_member) idempotent re-call updates state without touching dropped columns",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const conversationId = await insertConversation(db, workspaceId)

      const { ensureConversationParticipant } = await import("./service.js")

      const first = await ensureConversationParticipant({
        conversationId,
        participantType: "workspace_member",
        workspaceMemberId: memberId,
        roleKey: "member",
        queryable: db,
      })
      const firstId = (first as { id: string }).id

      // Soft-leave the participant directly so we can verify the UPDATE
      // reactivates it (the COALESCE in the UPDATE keeps display_name etc).
      await db
        .updateTable("conversation_participants")
        .set({ state: "left" })
        .where("id", "=", firstId)
        .execute()

      const again = await ensureConversationParticipant({
        conversationId,
        participantType: "workspace_member",
        workspaceMemberId: memberId,
        queryable: db,
      })
      const againId = (again as { id: string }).id
      assert.equal(againId, firstId)

      const row = await db
        .selectFrom("conversation_participants")
        .selectAll()
        .where("id", "=", firstId)
        .executeTakeFirstOrThrow()
      assert.equal(row.state, "active")
      assert.equal(row.left_at, null)
    })
  }
)

// Creates a transport_address. By default it mints a fresh account in the given
// workspace; pass transportAccountId to attach the address to an existing
// account (e.g. an IM conversation's binding account, so the external-account
// trigger passes).
async function insertTransportAddress(
  db: AnyDb,
  workspaceId: string,
  opts: {
    workspaceMemberId?: string
    addressType?: string
    transportAccountId?: string
  } = {}
): Promise<string> {
  const accountId =
    opts.transportAccountId ?? (await insertTransportAccount(db, workspaceId))
  const addr = await db
    .insertInto("transport_addresses")
    .values({
      workspace_id: workspaceId,
      transport_account_id: accountId,
      transport_kind: "qq",
      address_type: opts.addressType ?? "user",
      external_id: `ext-${Math.random().toString(36).slice(2, 8)}`,
      workspace_member_id: opts.workspaceMemberId ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return addr.id as string
}

test(
  "external participant: same transport_address across two conversations reuses one subject; a different address gets its own",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      // Both conversations must be bound to the SAME account as the shared
      // address, otherwise the account-match trigger rejects the cross-conversation
      // reuse. Conv A also hosts the second (different-account) address.
      const sharedAccountId = await insertTransportAccount(db, workspaceId)
      const convA = (
        await insertImConversation(db, workspaceId, {
          transportAccountId: sharedAccountId,
        })
      ).conversationId
      const convB = (
        await insertImConversation(db, workspaceId, {
          transportAccountId: sharedAccountId,
        })
      ).conversationId
      const addr1 = await insertTransportAddress(db, workspaceId, {
        transportAccountId: sharedAccountId,
      })
      const addr2 = await insertTransportAddress(db, workspaceId, {
        transportAccountId: sharedAccountId,
      })

      const { ensureConversationParticipant } = await import("./service.js")

      const a1 = (await ensureConversationParticipant({
        conversationId: convA,
        participantType: "external",
        displayName: "Alice",
        transportAddressId: addr1,
        queryable: db,
      })) as { id: string; subjectId?: string }
      const b1 = (await ensureConversationParticipant({
        conversationId: convB,
        participantType: "external",
        displayName: "Alice elsewhere",
        transportAddressId: addr1,
        queryable: db,
      })) as { id: string }
      const a2 = (await ensureConversationParticipant({
        conversationId: convA,
        participantType: "external",
        displayName: "Bob",
        transportAddressId: addr2,
        queryable: db,
      })) as { id: string }

      const rows = await db
        .selectFrom("conversation_participants")
        .select(["id", "subject_id"])
        .where("id", "in", [a1.id, b1.id, a2.id])
        .execute()
      const byId = new Map(rows.map((r) => [r.id, r.subject_id]))
      // Same address in two conversations → same subject (cross-conversation identity).
      assert.equal(byId.get(a1.id), byId.get(b1.id))
      // Different address → different subject.
      assert.notEqual(byId.get(a1.id), byId.get(a2.id))

      // The reused subject is a real first-class external subject (workspace + address).
      const subj = await db
        .selectFrom("access_subjects")
        .select(["kind", "workspace_id", "transport_address_id"])
        .where("id", "=", byId.get(a1.id)!)
        .executeTakeFirstOrThrow()
      assert.equal(subj.kind, "external")
      assert.equal(subj.workspace_id, workspaceId)
      assert.equal(subj.transport_address_id, addr1)
    })
  }
)

test(
  "external participant: renaming display_name does not create a duplicate (dedup by subject, not name)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const { conversationId, transportAccountId } = await insertImConversation(
        db,
        workspaceId
      )
      const addr = await insertTransportAddress(db, workspaceId, {
        transportAccountId,
      })

      const { ensureConversationParticipant } = await import("./service.js")

      const first = (await ensureConversationParticipant({
        conversationId,
        participantType: "external",
        displayName: "Original Name",
        transportAddressId: addr,
        queryable: db,
      })) as { id: string }
      const renamed = (await ensureConversationParticipant({
        conversationId,
        participantType: "external",
        displayName: "Renamed",
        transportAddressId: addr,
        queryable: db,
      })) as { id: string }
      assert.equal(renamed.id, first.id)

      const count = await db
        .selectFrom("conversation_participants")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("conversation_id", "=", conversationId)
        .executeTakeFirstOrThrow()
      assert.equal(Number(count.n), 1)
    })
  }
)

test(
  "external participant without a transport identity is rejected (no throwaway)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const { conversationId } = await insertImConversation(db, workspaceId)

      const { ensureConversationParticipant } = await import("./service.js")

      await assert.rejects(
        ensureConversationParticipant({
          conversationId,
          participantType: "external",
          displayName: "Anonymous",
          queryable: db,
        }),
        /external participant requires transportAddressId/
      )
    })
  }
)

test(
  "external subject cannot join a non-IM conversation (no transport binding) — DB trigger",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      // A plain conversation with NO transport binding is not IM.
      const nonImConv = await insertConversation(db, workspaceId)
      const addr = await insertTransportAddress(db, workspaceId)

      const { ensureConversationParticipant } = await import("./service.js")

      await assert.rejects(
        ensureConversationParticipant({
          conversationId: nonImConv,
          participantType: "external",
          displayName: "Sneaky",
          transportAddressId: addr,
          queryable: db,
        }),
        /no transport binding|external participants are IM-only/i
      )
    })
  }
)

test(
  "external subject from a different transport account than the conversation's binding is rejected (account mismatch) — DB trigger",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      // IM conversation bound to account A; the address belongs to account B.
      const { conversationId } = await insertImConversation(db, workspaceId)
      const otherAccountId = await insertTransportAccount(db, workspaceId)
      const addrOnOtherAccount = await insertTransportAddress(db, workspaceId, {
        transportAccountId: otherAccountId,
      })

      const { ensureConversationParticipant } = await import("./service.js")

      await assert.rejects(
        ensureConversationParticipant({
          conversationId,
          participantType: "external",
          displayName: "Wrong account",
          transportAddressId: addrOnOtherAccount,
          queryable: db,
        }),
        /transport account .* does not match|binding account/i
      )
    })
  }
)

test(
  "ensureConversationParticipant rejects a linked (member-bound) address as external (resolver guard)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const { conversationId, transportAccountId } = await insertImConversation(
        db,
        workspaceId
      )
      const linkedAddr = await insertTransportAddress(db, workspaceId, {
        transportAccountId,
        workspaceMemberId: memberId,
      })

      const { ensureConversationParticipant } = await import("./service.js")

      await assert.rejects(
        ensureConversationParticipant({
          conversationId,
          participantType: "external",
          displayName: "Linked",
          transportAddressId: linkedAddr,
          queryable: db,
        }),
        /linked to a workspace member/
      )
    })
  }
)

test(
  "ensureConversationParticipant rejects a bot/system address as external (resolver guard)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const { conversationId, transportAccountId } = await insertImConversation(
        db,
        workspaceId
      )
      const botAddr = await insertTransportAddress(db, workspaceId, {
        transportAccountId,
        addressType: "bot",
      })

      const { ensureConversationParticipant } = await import("./service.js")

      await assert.rejects(
        ensureConversationParticipant({
          conversationId,
          participantType: "external",
          displayName: "Bot",
          transportAddressId: botAddr,
          queryable: db,
        }),
        /not a user address/
      )
    })
  }
)

test(
  "ensureConversationParticipant rejects an external address from another workspace (workspace mismatch)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const otherUserId = await insertUser(db)
      const otherWorkspaceId = await insertWorkspace(db, otherUserId)
      const { conversationId } = await insertImConversation(db, workspaceId)
      // Address (and its account) live in a DIFFERENT workspace than the conv.
      const foreignAddr = await insertTransportAddress(db, otherWorkspaceId)

      const { ensureConversationParticipant } = await import("./service.js")

      // The subject is minted in the address's (foreign) workspace, so the
      // participant trigger's unconditional workspace match rejects it. (The
      // account-match check would also reject; either way it must fail.)
      await assert.rejects(
        ensureConversationParticipant({
          conversationId,
          participantType: "external",
          displayName: "Foreign",
          transportAddressId: foreignAddr,
          queryable: db,
        }),
        /does not match conversation|binding account/i
      )
    })
  }
)

test(
  "external participant happy path: unlinked user address on the binding account joins an IM conversation",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const { conversationId, transportAccountId } = await insertImConversation(
        db,
        workspaceId
      )
      const addrOk = await insertTransportAddress(db, workspaceId, {
        transportAccountId,
      })

      const { ensureConversationParticipant } = await import("./service.js")

      const participant = (await ensureConversationParticipant({
        conversationId,
        participantType: "external",
        displayName: "Real External",
        transportAddressId: addrOk,
        queryable: db,
      })) as { id: string }
      assert.ok(participant.id)

      const parts = await db
        .selectFrom("conversation_participants as cp")
        .innerJoin("access_subjects as s", "s.id", "cp.subject_id")
        .select(["s.kind", "s.transport_address_id", "s.workspace_id"])
        .where("cp.conversation_id", "=", conversationId)
        .execute()
      assert.equal(parts.length, 1)
      assert.equal(parts[0].kind, "external")
      assert.equal(parts[0].transport_address_id, addrOk)
      assert.equal(parts[0].workspace_id, workspaceId)
    })
  }
)

async function insertRemoteAgent(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("remote_agents")
    .values({
      workspace_id: workspaceId,
      name: `agent-${Math.random().toString(36).slice(2, 8)}`,
      title: "Test agent",
      runtime_kind: "codex",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "round-11 P1: addConversationParticipants rejects a remote agent from another workspace (no cross-workspace leak)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const otherUserId = await insertUser(db)
      const otherWorkspaceId = await insertWorkspace(db, otherUserId)
      const foreignAgentId = await insertRemoteAgent(db, otherWorkspaceId)
      const conversationId = await insertConversation(db, workspaceId)

      const { addConversationParticipants } = await import("./service.js")

      await assert.rejects(
        addConversationParticipants({
          workspaceId,
          conversationId,
          remoteAgentIds: [foreignAgentId],
          queryable: db,
        }),
        /remote agent/i
      )

      // sanity: a same-workspace agent is accepted.
      const localAgentId = await insertRemoteAgent(db, workspaceId)
      await addConversationParticipants({
        workspaceId,
        conversationId,
        remoteAgentIds: [localAgentId],
        queryable: db,
      })
      const rows = await db
        .selectFrom("conversation_participants as cp")
        .innerJoin("access_subjects as s", "s.id", "cp.subject_id")
        .select("s.remote_agent_id")
        .where("cp.conversation_id", "=", conversationId)
        .where("s.kind", "=", "remote_agent")
        .execute()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].remote_agent_id, localAgentId)
    })
  }
)
