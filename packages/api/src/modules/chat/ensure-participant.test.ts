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

async function insertConversation(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      boundary: "internal",
      internal_workspace_id: workspaceId,
      title: "test conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "ensureConversationParticipant inserts then updates without writing dropped polymorphic columns",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
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
        queryable: client,
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
        queryable: client,
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
    await withTestDbAndClient(async ({ db, client }) => {
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
        queryable: client,
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
        queryable: client,
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

async function insertTransportAddress(
  db: AnyDb,
  workspaceId: string,
  opts: { workspaceMemberId?: string; addressType?: string } = {}
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
  const addr = await db
    .insertInto("transport_addresses")
    .values({
      workspace_id: workspaceId,
      transport_account_id: account.id as string,
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
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const convA = await insertExternalConversation(db)
      const convB = await insertExternalConversation(db)
      const addr1 = await insertTransportAddress(db, workspaceId)
      const addr2 = await insertTransportAddress(db, workspaceId)

      const { ensureConversationParticipant } = await import("./service.js")

      const a1 = (await ensureConversationParticipant({
        conversationId: convA,
        participantType: "external",
        displayName: "Alice",
        transportAddressId: addr1,
        queryable: client,
      })) as { id: string; subjectId?: string }
      const b1 = (await ensureConversationParticipant({
        conversationId: convB,
        participantType: "external",
        displayName: "Alice elsewhere",
        transportAddressId: addr1,
        queryable: client,
      })) as { id: string }
      const a2 = (await ensureConversationParticipant({
        conversationId: convA,
        participantType: "external",
        displayName: "Bob",
        transportAddressId: addr2,
        queryable: client,
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
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const conversationId = await insertExternalConversation(db)
      const addr = await insertTransportAddress(db, workspaceId)

      const { ensureConversationParticipant } = await import("./service.js")

      const first = (await ensureConversationParticipant({
        conversationId,
        participantType: "external",
        displayName: "Original Name",
        transportAddressId: addr,
        queryable: client,
      })) as { id: string }
      const renamed = (await ensureConversationParticipant({
        conversationId,
        participantType: "external",
        displayName: "Renamed",
        transportAddressId: addr,
        queryable: client,
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
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const conversationId = await insertExternalConversation(db)

      const { ensureConversationParticipant } = await import("./service.js")

      await assert.rejects(
        ensureConversationParticipant({
          conversationId,
          participantType: "external",
          displayName: "Anonymous",
          queryable: client,
        }),
        /external participant requires transportAddressId/
      )
    })
  }
)

async function insertExternalConversation(db: AnyDb): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      boundary: "external",
      title: "external conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "addConversationParticipants: external gating (P1) — internal rejects external; external conv validates address (workspace / type / unlinked)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const otherUserId = await insertUser(db)
      const otherWorkspaceId = await insertWorkspace(db, otherUserId)

      const { addConversationParticipants } = await import("./service.js")

      // (a) internal conversation rejects external participants entirely.
      const internalConv = await insertConversation(db, workspaceId)
      const addrOk = await insertTransportAddress(db, workspaceId)
      await assert.rejects(
        addConversationParticipants({
          workspaceId,
          conversationId: internalConv,
          externalParticipants: [
            { displayName: "X", transportAddressId: addrOk },
          ],
          queryable: client,
        }),
        /Internal conversations do not allow external participants/
      )

      const externalConv = await insertExternalConversation(db)

      // (b) address from another workspace is rejected.
      const foreignAddr = await insertTransportAddress(db, otherWorkspaceId)
      await assert.rejects(
        addConversationParticipants({
          workspaceId,
          conversationId: externalConv,
          externalParticipants: [
            { displayName: "Foreign", transportAddressId: foreignAddr },
          ],
          queryable: client,
        }),
        /transport address/i
      )

      // (c) linked (member-bound) address is rejected — must be added as member.
      const linkedAddr = await insertTransportAddress(db, workspaceId, {
        workspaceMemberId: memberId,
      })
      await assert.rejects(
        addConversationParticipants({
          workspaceId,
          conversationId: externalConv,
          externalParticipants: [
            { displayName: "Linked", transportAddressId: linkedAddr },
          ],
          queryable: client,
        }),
        /linked to a workspace member/
      )

      // (d) bot/system address type is rejected.
      const botAddr = await insertTransportAddress(db, workspaceId, {
        addressType: "bot",
      })
      await assert.rejects(
        addConversationParticipants({
          workspaceId,
          conversationId: externalConv,
          externalParticipants: [
            { displayName: "Bot", transportAddressId: botAddr },
          ],
          queryable: client,
        }),
        /not a user address/
      )

      // (e) happy path: unlinked user address in this workspace on external conv.
      await addConversationParticipants({
        workspaceId,
        conversationId: externalConv,
        externalParticipants: [
          { displayName: "Real External", transportAddressId: addrOk },
        ],
        queryable: client,
      })
      const parts = await db
        .selectFrom("conversation_participants as cp")
        .innerJoin("access_subjects as s", "s.id", "cp.subject_id")
        .select(["s.kind", "s.transport_address_id"])
        .where("cp.conversation_id", "=", externalConv)
        .execute()
      assert.equal(parts.length, 1)
      assert.equal(parts[0].kind, "external")
      assert.equal(parts[0].transport_address_id, addrOk)
    })
  }
)

test(
  "createConversationForWorkspaceMember: external gating (round-8 P2) — internal rejects external; external validates address",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const addrOk = await insertTransportAddress(db, workspaceId)
      const linkedAddr = await insertTransportAddress(db, workspaceId, {
        workspaceMemberId: memberId,
      })

      const { createConversationForWorkspaceMember } =
        await import("./service.js")

      // internal (default boundary) rejects external participants.
      await assert.rejects(
        createConversationForWorkspaceMember({
          workspaceId,
          creatorWorkspaceMemberId: memberId,
          kind: "group",
          externalParticipants: [
            { displayName: "X", transportAddressId: addrOk },
          ],
          queryable: client,
        }),
        /Internal conversations do not allow external participants/
      )

      // external boundary rejects a linked address.
      await assert.rejects(
        createConversationForWorkspaceMember({
          workspaceId,
          creatorWorkspaceMemberId: memberId,
          kind: "group",
          boundary: "external",
          externalParticipants: [
            { displayName: "Linked", transportAddressId: linkedAddr },
          ],
          queryable: client,
        }),
        /linked to a workspace member/
      )

      // external boundary with a valid unlinked user address succeeds.
      const convo = (await createConversationForWorkspaceMember({
        workspaceId,
        creatorWorkspaceMemberId: memberId,
        kind: "group",
        boundary: "external",
        externalParticipants: [
          { displayName: "Real", transportAddressId: addrOk },
        ],
        queryable: client,
      })) as { id: string }
      const parts = await db
        .selectFrom("conversation_participants as cp")
        .innerJoin("access_subjects as s", "s.id", "cp.subject_id")
        .select(["s.kind", "s.transport_address_id"])
        .where("cp.conversation_id", "=", convo.id)
        .where("s.kind", "=", "external")
        .execute()
      assert.equal(parts.length, 1)
      assert.equal(parts[0].transport_address_id, addrOk)
    })
  }
)

test(
  "external gating (round-9 P3): duplicate transportAddressId is a clean 400, not a DB constraint error",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const addr = await insertTransportAddress(db, workspaceId)

      const { createConversationForWorkspaceMember } =
        await import("./service.js")

      await assert.rejects(
        createConversationForWorkspaceMember({
          workspaceId,
          creatorWorkspaceMemberId: memberId,
          kind: "group",
          boundary: "external",
          externalParticipants: [
            { displayName: "Dup A", transportAddressId: addr },
            { displayName: "Dup B", transportAddressId: addr },
          ],
          queryable: client,
        }),
        /[Dd]uplicate external participant/
      )
    })
  }
)

test(
  "external gating (round-9 P2): a rejected non-transactional create leaves no orphan conversation",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)

      const before = await db
        .selectFrom("conversations")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .executeTakeFirstOrThrow()

      const { createConversationForWorkspaceMember } =
        await import("./service.js")

      // Pass the raw (non-transactional) client and an internal boundary with an
      // external participant → must reject BEFORE creating the conversation.
      await assert.rejects(
        createConversationForWorkspaceMember({
          workspaceId,
          creatorWorkspaceMemberId: memberId,
          kind: "group",
          externalParticipants: [
            { displayName: "X", transportAddressId: crypto.randomUUID() },
          ],
          queryable: client,
        }),
        /Internal conversations do not allow external participants/
      )

      const after = await db
        .selectFrom("conversations")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .executeTakeFirstOrThrow()
      assert.equal(Number(after.n), Number(before.n))
    })
  }
)

test(
  "round-10 P3a: ensureConversationParticipant cannot attach an external subject to an internal conversation (DB boundary trigger)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const internalConv = await insertConversation(db, workspaceId)
      const addr = await insertTransportAddress(db, workspaceId)

      const { ensureConversationParticipant } = await import("./service.js")

      await assert.rejects(
        ensureConversationParticipant({
          conversationId: internalConv,
          participantType: "external",
          displayName: "Sneaky",
          transportAddressId: addr,
          queryable: client,
        }),
        /external.*internal conversation|cannot join internal/i
      )
    })
  }
)

test(
  "round-10 P3a: ensureConversationParticipant rejects a bot/system or linked address as external (resolver guard)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const externalConv = await insertExternalConversation(db)
      const botAddr = await insertTransportAddress(db, workspaceId, {
        addressType: "bot",
      })
      const linkedAddr = await insertTransportAddress(db, workspaceId, {
        workspaceMemberId: memberId,
      })

      const { ensureConversationParticipant } = await import("./service.js")

      await assert.rejects(
        ensureConversationParticipant({
          conversationId: externalConv,
          participantType: "external",
          displayName: "Bot",
          transportAddressId: botAddr,
          queryable: client,
        }),
        /not a user address/
      )
      await assert.rejects(
        ensureConversationParticipant({
          conversationId: externalConv,
          participantType: "external",
          displayName: "Linked",
          transportAddressId: linkedAddr,
          queryable: client,
        }),
        /linked to a workspace member/
      )
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
    await withTestDbAndClient(async ({ db, client }) => {
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
          queryable: client,
        }),
        /remote agent/i
      )

      // sanity: a same-workspace agent is accepted.
      const localAgentId = await insertRemoteAgent(db, workspaceId)
      await addConversationParticipants({
        workspaceId,
        conversationId,
        remoteAgentIds: [localAgentId],
        queryable: client,
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
