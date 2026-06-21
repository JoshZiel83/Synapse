import test from "node:test"
import assert from "node:assert/strict"
import { SUBJECT_KIND } from "@synapse/shared"
import { withTestDbAndClient } from "../../test/helpers/db.js"
import { upsertAccessSubjectOn } from "../access/subject-registry.js"

type AnyDb = import("kysely").Kysely<any>

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
      ownerId: ownerId,
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
    .insertInto("workspaceMembers")
    .values({
      workspaceId: workspaceId,
      userId: userId,
      trustLevel: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertActor(db: AnyDb, workspaceId: string): Promise<string> {
  const actorId = crypto.randomUUID()
  const createdBySubjectId = await upsertAccessSubjectOn(db, {
    kind: SUBJECT_KIND.PLATFORM,
  })
  await db
    .insertInto("workspaceResources")
    .values({
      id: actorId,
      workspaceId: workspaceId,
      kind: "actor",
      displayName: "test actor",
      createdBySubjectId,
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id: actorId,
      role: "assistant",
      title: "test",
      currentVersion: 1,
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
      workspaceId: workspaceId,
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
    .insertInto("transportAccounts")
    .values({
      workspaceId: workspaceId,
      transportKind: "qq",
      accountKey: `acct-${Math.random().toString(36).slice(2, 8)}`,
      displayName: "Test account",
      connectionMode: "webhook",
      ownerScope: "workspace",
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
    .insertInto("transportEndpoints")
    .values({
      transportAccountId: transportAccountId,
      endpointType: "group",
      externalId: `ep-${Math.random().toString(36).slice(2, 8)}`,
      displayName: "Test endpoint",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const conv = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      workspaceId: workspaceId,
      title: "im conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  await db
    .insertInto("conversationTransportBindings")
    .values({
      workspaceId: workspaceId,
      conversationId: conv.id as string,
      transportAccountId: transportAccountId,
      transportEndpointId: endpoint.id as string,
      outboundEnabled: true,
      inboundActorMode: "inherit_account",
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
        .selectFrom("conversationParticipants")
        .selectAll()
        .where("id", "=", firstId)
        .executeTakeFirstOrThrow()
      assert.equal(row.roleKey, "owner")
      assert.equal(row.displayName, "second display")
      assert.equal(row.state, "active")
      assert.ok(row.subjectId)
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
        .updateTable("conversationParticipants")
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
        .selectFrom("conversationParticipants")
        .selectAll()
        .where("id", "=", firstId)
        .executeTakeFirstOrThrow()
      assert.equal(row.state, "active")
      assert.equal(row.leftAt, null)
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
    .insertInto("transportAddresses")
    .values({
      workspaceId: workspaceId,
      transportAccountId: accountId,
      transportKind: "qq",
      addressType: opts.addressType ?? "user",
      externalId: `ext-${Math.random().toString(36).slice(2, 8)}`,
      workspaceMemberId: opts.workspaceMemberId ?? null,
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
        .selectFrom("conversationParticipants")
        .select(["id", "subjectId"])
        .where("id", "in", [a1.id, b1.id, a2.id])
        .execute()
      const byId = new Map(rows.map((r) => [r.id, r.subjectId]))
      // Same address in two conversations → same subject (cross-conversation identity).
      assert.equal(byId.get(a1.id), byId.get(b1.id))
      // Different address → different subject.
      assert.notEqual(byId.get(a1.id), byId.get(a2.id))

      // The reused subject is a real first-class external subject (workspace + address).
      const subj = await db
        .selectFrom("accessSubjects")
        .select(["kind", "workspaceId", "transportAddressId"])
        .where("id", "=", byId.get(a1.id)!)
        .executeTakeFirstOrThrow()
      assert.equal(subj.kind, "external")
      assert.equal(subj.workspaceId, workspaceId)
      assert.equal(subj.transportAddressId, addr1)
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
        .selectFrom("conversationParticipants")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("conversationId", "=", conversationId)
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
        .selectFrom("conversationParticipants as cp")
        .innerJoin("accessSubjects as s", "s.id", "cp.subjectId")
        .select(["s.kind", "s.transportAddressId", "s.workspaceId"])
        .where("cp.conversationId", "=", conversationId)
        .execute()
      assert.equal(parts.length, 1)
      assert.equal(parts[0].kind, "external")
      assert.equal(parts[0].transportAddressId, addrOk)
      assert.equal(parts[0].workspaceId, workspaceId)
    })
  }
)

async function insertRemoteAgent(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const remoteAgentId = crypto.randomUUID()
  const createdBySubjectId = await upsertAccessSubjectOn(db, {
    kind: SUBJECT_KIND.PLATFORM,
  })
  await db
    .insertInto("workspaceResources")
    .values({
      id: remoteAgentId,
      workspaceId: workspaceId,
      kind: "remote_agent",
      displayName: "Test agent",
      createdBySubjectId,
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("remoteAgents")
    .values({
      id: remoteAgentId,
      title: "Test agent",
      runtimeKind: "codex",
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
        .selectFrom("conversationParticipants as cp")
        .innerJoin("accessSubjects as s", "s.id", "cp.subjectId")
        .select("s.remoteAgentId")
        .where("cp.conversationId", "=", conversationId)
        .where("s.kind", "=", "remote_agent")
        .execute()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].remoteAgentId, localAgentId)
    })
  }
)
