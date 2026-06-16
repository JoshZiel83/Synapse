import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { CONVERSATION_PARTICIPANT_STATE, SUBJECT_KIND } from "@synapse/shared"
import { withTestDbAndClient } from "../../test/helpers/db.js"
import { upsertAccessSubjectOn } from "../access/subject-registry.js"
import { activateConversationParticipant } from "./participant-activation.js"

type AnyDb = import("kysely").Kysely<any>
type ConversationParticipantState =
  (typeof CONVERSATION_PARTICIPANT_STATE)[keyof typeof CONVERSATION_PARTICIPANT_STATE]

async function seedWorkspaceParticipant(
  db: AnyDb,
  state: ConversationParticipantState = CONVERSATION_PARTICIPANT_STATE.REMOVED
) {
  const user = await db
    .insertInto("users")
    .values({
      email: `${randomUUID()}@participant-activation.test`,
      name: "reactivated user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const workspace = await db
    .insertInto("workspaces")
    .values({
      ownerId: user.id as string,
      slug: `pa-${randomUUID().slice(0, 8)}`,
      name: "participant activation workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspaceMembers")
    .values({
      workspaceId: workspace.id as string,
      userId: user.id as string,
      trustLevel: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const conversation = await db
    .insertInto("conversations")
    .values({
      workspaceId: workspace.id as string,
      kind: "group",
      title: "participant activation conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const subjectId = await upsertAccessSubjectOn(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: member.id as string,
  })
  const participant = await db
    .insertInto("conversationParticipants")
    .values({
      conversationId: conversation.id as string,
      subjectId,
      roleKey: "member",
      state,
      metadata: {},
    } as never)
    .returning("id")
    .executeTakeFirstOrThrow()

  return {
    workspaceId: workspace.id as string,
    workspaceMemberId: member.id as string,
    conversationId: conversation.id as string,
    participantId: participant.id as string,
  }
}

test(
  "activateConversationParticipant rolls back reactivation when join event insert fails",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const fixture = await seedWorkspaceParticipant(db as unknown as AnyDb)

      await client.query(`
        CREATE OR REPLACE FUNCTION fail_participant_activation_event_for_test()
        RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'participant joined event insert failed';
        END;
        $$ LANGUAGE plpgsql;
      `)
      await client.query(`
        CREATE TRIGGER fail_participant_activation_event_for_test
        BEFORE INSERT ON conversation_items
        FOR EACH ROW EXECUTE FUNCTION fail_participant_activation_event_for_test();
      `)

      try {
        await assert.rejects(async () => {
          await client.query("SAVEPOINT participant_activation_rollback")
          try {
            await activateConversationParticipant({
              workspaceId: fixture.workspaceId,
              conversationId: fixture.conversationId,
              participantType: "workspace_member",
              workspaceMemberId: fixture.workspaceMemberId,
              displayName: "reactivated user",
              queryable: db as unknown as AnyDb,
            })
            await client.query(
              "RELEASE SAVEPOINT participant_activation_rollback"
            )
          } catch (error) {
            await client.query(
              "ROLLBACK TO SAVEPOINT participant_activation_rollback"
            )
            throw error
          }
        }, /participant joined event insert failed/)
      } finally {
        await client.query(`
          DROP TRIGGER IF EXISTS fail_participant_activation_event_for_test
          ON conversation_items;
        `)
        await client.query(
          "DROP FUNCTION IF EXISTS fail_participant_activation_event_for_test();"
        )
      }

      const participant = await (db as unknown as AnyDb)
        .selectFrom("conversationParticipants")
        .select("state")
        .where("id", "=", fixture.participantId)
        .executeTakeFirstOrThrow()
      assert.equal(participant.state, CONVERSATION_PARTICIPANT_STATE.REMOVED)

      const items = await (db as unknown as AnyDb)
        .selectFrom("conversationItems")
        .select("id")
        .where("conversationId", "=", fixture.conversationId)
        .execute()
      assert.deepEqual(items, [])
    })
  }
)

test(
  "activateConversationParticipant does not re-emit join events for active participants",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const fixture = await seedWorkspaceParticipant(
        db as unknown as AnyDb,
        CONVERSATION_PARTICIPANT_STATE.ACTIVE
      )

      await client.query(`
        CREATE OR REPLACE FUNCTION fail_duplicate_participant_join_for_test()
        RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'duplicate participant joined event insert';
        END;
        $$ LANGUAGE plpgsql;
      `)
      await client.query(`
        CREATE TRIGGER fail_duplicate_participant_join_for_test
        BEFORE INSERT ON conversation_items
        FOR EACH ROW EXECUTE FUNCTION fail_duplicate_participant_join_for_test();
      `)

      let result: Awaited<ReturnType<typeof activateConversationParticipant>>
      try {
        await client.query("SAVEPOINT participant_activation_idempotent")
        try {
          result = await activateConversationParticipant({
            workspaceId: fixture.workspaceId,
            conversationId: fixture.conversationId,
            participantType: "workspace_member",
            workspaceMemberId: fixture.workspaceMemberId,
            displayName: "reactivated user",
            queryable: db as unknown as AnyDb,
          })
          await client.query(
            "RELEASE SAVEPOINT participant_activation_idempotent"
          )
        } catch (error) {
          await client.query(
            "ROLLBACK TO SAVEPOINT participant_activation_idempotent"
          )
          throw error
        }
      } finally {
        await client.query(`
          DROP TRIGGER IF EXISTS fail_duplicate_participant_join_for_test
          ON conversation_items;
        `)
        await client.query(
          "DROP FUNCTION IF EXISTS fail_duplicate_participant_join_for_test();"
        )
      }

      assert.equal(result!.activated, false)
      assert.equal(result!.created, false)
      assert.equal(result!.revived, false)
      assert.equal(result!.member?.id, fixture.participantId)

      const items = await (db as unknown as AnyDb)
        .selectFrom("conversationItems")
        .select("id")
        .where("conversationId", "=", fixture.conversationId)
        .execute()
      assert.deepEqual(items, [])
    })
  }
)
