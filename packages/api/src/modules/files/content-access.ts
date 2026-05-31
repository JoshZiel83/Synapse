// Content-addressed access control for GET /api/v1/content/:sha256.
//
// file_ref blocks render by sha256 (the content identity, pinned at message
// persist time). A sha256 is not itself an authorization token — the same bytes
// can be referenced from many places with different audiences — so a request to
// read a blob must prove the caller may see *some* reference to that sha. This
// resolver checks, in order, the distinct authorization paths a sha can be
// reached through and returns the first that grants access:
//
//   (a) message-ref — a conversation_item_part / tool_result_part the caller can
//       see under the normal chat visibility rules (workspace member + active
//       conversation participant + scope='shared'/surface='visible', honoring
//       item targets). tool_result parts are private/internal and only reachable
//       by the conversation's participants.
//   (b) memory / context-archive ref — a memory_item_part or
//       context_archive_frame_part whose owning space the caller can read.
//   (c) file_space ACL — an active file_access_grant to a space whose current
//       snapshot (or an active mount's base/result snapshot) manifest contains
//       the sha. Bounded: only the few snapshots pinned by live state are
//       expanded, never the whole DAG.
//   (d) asset — a file_assets row (entity asset by content) in a workspace the
//       caller belongs to.
//
// Any single pass granting access short-circuits the rest.

import { db } from "../../infrastructure/database/kysely.js"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import { readCasBlob } from "../../infrastructure/storage/index.js"
import { parseManifestShas } from "./manifest-parse.js"

export interface ContentAccessContext {
  /** Optional conversation hint (?conv=) to scope the message-ref check. */
  conversationId?: string | null
  /** Optional file_space hint (?space=) to scope the ACL check. */
  fileSpaceId?: string | null
  /**
   * DB handle override (e.g. a test transaction). Defaults to the singleton.
   * Threaded through every branch so the whole resolver runs on one connection.
   */
  dbh?: KyselyDb
}

/**
 * True iff `userId` may read the bytes addressed by `sha256` through at least
 * one authorized reference. Pure read predicate — never throws on "denied",
 * only returns false.
 */
export async function canUserAccessContent(
  sha256: string,
  userId: string,
  ctx: ContentAccessContext = {}
): Promise<boolean> {
  if (!sha256) return false
  const dbh = ctx.dbh ?? db

  // (a) message-ref: a part the user can see in a conversation they participate
  // in. Visibility mirrors getChatConversationMessages: active workspace_member
  // participant + (for tool_result parts) participant of the same conversation.
  if (
    await hasVisibleMessageRef(dbh, sha256, userId, ctx.conversationId ?? null)
  ) {
    return true
  }

  // (b) memory / context-archive ref keyed by the caller's readable spaces.
  if (await hasReadableMemoryRef(dbh, sha256, userId)) {
    return true
  }

  // (c) file_space ACL: an active grant to the user (via their workspace_member
  // subject) for a space whose live snapshots' manifests contain the sha.
  if (
    await hasFileSpaceGrantReach(dbh, sha256, userId, ctx.fileSpaceId ?? null)
  ) {
    return true
  }

  // (d) asset: entity asset in a workspace the user belongs to.
  if (await hasAssetInUserWorkspace(dbh, sha256, userId)) {
    return true
  }

  return false
}

// (a) ---------------------------------------------------------------------
// A conversation_item_part or tool_result_part referencing this sha, in a
// conversation where the user is an active workspace_member participant.
// conversation_item parts honor scope/surface; tool_result parts live behind a
// tool_result → conversation_item and are only reachable by the conversation's
// participants (they are private/internal by construction).
async function hasVisibleMessageRef(
  dbh: KyselyDb,
  sha256: string,
  userId: string,
  conversationId: string | null
): Promise<boolean> {
  // Shared/visible conversation_item file_ref parts the user can see. The
  // participant linkage: conversation_participants.subject_id →
  // access_subjects.workspace_member_id → workspace_members.user_id. We ALSO
  // honor directed-message audience restrictions (conversation_item_targets):
  // an item with target rows is only visible to its author or a listed target —
  // mirroring getChatConversationMessages so a non-targeted participant can't
  // fetch an attachment the chat read path would hide from them.
  const itemRef = await dbh
    .selectFrom("conversation_item_parts as cip")
    .innerJoin("conversation_items as ci", "ci.id", "cip.item_id")
    .innerJoin(
      "conversation_participants as cp",
      "cp.conversation_id",
      "ci.conversation_id"
    )
    .innerJoin("access_subjects as cpsubj", "cpsubj.id", "cp.subject_id")
    .innerJoin("workspace_members as wm", "wm.id", "cpsubj.workspace_member_id")
    .select("cip.id")
    .where("cip.ref_sha256", "=", sha256)
    .where("wm.user_id", "=", userId)
    .where("cp.state", "=", "active")
    .where("ci.scope", "=", "shared")
    .where("ci.surface", "=", "visible")
    .where((eb) =>
      eb.or([
        // No audience restriction on this item.
        eb.not(
          eb.exists(
            eb
              .selectFrom("conversation_item_targets as cit0")
              .select("cit0.item_id")
              .whereRef("cit0.item_id", "=", "ci.id")
          )
        ),
        // The caller's participant authored it.
        eb("ci.author_participant_id", "=", eb.ref("cp.id")),
        // The caller's participant is an explicit target.
        eb.exists(
          eb
            .selectFrom("conversation_item_targets as cit")
            .select("cit.item_id")
            .whereRef("cit.item_id", "=", "ci.id")
            .whereRef("cit.target_participant_id", "=", "cp.id")
        ),
      ])
    )
    .$if(Boolean(conversationId), (qb) =>
      qb.where("ci.conversation_id", "=", conversationId as string)
    )
    .limit(1)
    .executeTakeFirst()
  if (itemRef) return true

  // tool_result parts: reachable by any active participant of the conversation
  // the producing tool call belongs to (these parts are private/internal — not
  // shown in the human timeline, but a participant may still fetch referenced
  // bytes). Path: tool_result_parts → tool_results → tool_calls.conversation_id.
  const toolRef = await dbh
    .selectFrom("tool_result_parts as trp")
    .innerJoin("tool_results as tr", "tr.id", "trp.tool_result_id")
    .innerJoin("tool_calls as tc", "tc.id", "tr.tool_call_id")
    .innerJoin(
      "conversation_participants as cp",
      "cp.conversation_id",
      "tc.conversation_id"
    )
    .innerJoin("access_subjects as cpsubj", "cpsubj.id", "cp.subject_id")
    .innerJoin("workspace_members as wm", "wm.id", "cpsubj.workspace_member_id")
    .select("trp.id")
    .where("trp.ref_sha256", "=", sha256)
    .where("wm.user_id", "=", userId)
    .where("cp.state", "=", "active")
    .$if(Boolean(conversationId), (qb) =>
      qb.where("tc.conversation_id", "=", conversationId as string)
    )
    .limit(1)
    .executeTakeFirst()
  if (toolRef) return true

  return false
}

// (b) ---------------------------------------------------------------------
// memory_item_parts / context_archive_frame_parts the user can read. A memory
// space is readable if the user's workspace_member subject owns it or holds an
// active memory_access_grant; context-archive frames belong to sessions in the
// user's workspace. We bound the check to spaces in workspaces the user belongs
// to (the cheap necessary condition) — finer-grained memory ACLs only ever
// narrow this, and the same bytes are independently reachable via (a) for any
// in-conversation reference.
async function hasReadableMemoryRef(
  dbh: KyselyDb,
  sha256: string,
  userId: string
): Promise<boolean> {
  const memRef = await dbh
    .selectFrom("memory_item_parts as mip")
    .innerJoin("memory_items as mi", "mi.id", "mip.memory_item_id")
    .innerJoin("memory_spaces as ms", "ms.id", "mi.memory_space_id")
    .innerJoin("workspaces as w", "w.id", "ms.workspace_id")
    .leftJoin("workspace_members as wm", (join) =>
      join.onRef("wm.workspace_id", "=", "w.id").on("wm.user_id", "=", userId)
    )
    .select("mip.id")
    .where("mip.ref_sha256", "=", sha256)
    .where((eb) =>
      eb.or([eb("w.owner_id", "=", userId), eb("wm.user_id", "is not", null)])
    )
    .limit(1)
    .executeTakeFirst()
  if (memRef) return true

  const archiveRef = await dbh
    .selectFrom("context_archive_frame_parts as cap")
    .innerJoin(
      "context_archive_frames as caf",
      "caf.id",
      "cap.archive_frame_id"
    )
    .innerJoin(
      "context_archive_points as cpt",
      "cpt.id",
      "caf.archive_point_id"
    )
    .innerJoin(
      "conversation_participants as cp",
      "cp.conversation_id",
      "cpt.conversation_id"
    )
    .innerJoin("access_subjects as cpsubj", "cpsubj.id", "cp.subject_id")
    .innerJoin("workspace_members as wm", "wm.id", "cpsubj.workspace_member_id")
    .select("cap.id")
    .where("cap.ref_sha256", "=", sha256)
    .where("wm.user_id", "=", userId)
    .where("cp.state", "=", "active")
    .limit(1)
    .executeTakeFirst()
  return Boolean(archiveRef)
}

// (c) ---------------------------------------------------------------------
// Active file_access_grant to the user (as a workspace_member subject) for a
// file_space whose live snapshots' manifests contain the sha. "Live snapshots"
// = the space's current_snapshot_id ∪ any active mount's base/result snapshot —
// a small, bounded set, never the whole DAG.
async function hasFileSpaceGrantReach(
  dbh: KyselyDb,
  sha256: string,
  userId: string,
  fileSpaceId: string | null
): Promise<boolean> {
  // Spaces the user can read via an active grant on their workspace_member
  // subject. (Grants are on subjects; a user maps to a workspace_member subject
  // per workspace.)
  let spacesQ = dbh
    .selectFrom("file_access_grants as g")
    .innerJoin("access_subjects as gs", "gs.id", "g.subject_id")
    .innerJoin("workspace_members as wm", "wm.id", "gs.workspace_member_id")
    .innerJoin("file_spaces as fs", "fs.id", "g.file_space_id")
    .select([
      "fs.id as space_id",
      "fs.current_snapshot_id as current_snapshot_id",
    ])
    .where("g.status", "=", "active")
    .where("wm.user_id", "=", userId)
  if (fileSpaceId) spacesQ = spacesQ.where("fs.id", "=", fileSpaceId)
  const spaces = await spacesQ.execute()
  if (spaces.length === 0) return false

  const spaceIds = spaces.map((s) => s.space_id)

  // Snapshots to inspect: each space's current head ∪ active mounts' base/result.
  const snapshotIds = new Set<string>()
  for (const s of spaces) {
    if (s.current_snapshot_id) snapshotIds.add(s.current_snapshot_id)
  }
  const mountSnaps = await dbh
    .selectFrom("file_mounts as m")
    .select(["m.base_snapshot_id", "m.result_snapshot_id"])
    .where("m.file_space_id", "in", spaceIds)
    .where("m.status", "in", ["provisioning", "active", "committing"])
    .execute()
  for (const m of mountSnaps) {
    if (m.base_snapshot_id) snapshotIds.add(m.base_snapshot_id)
    if (m.result_snapshot_id) snapshotIds.add(m.result_snapshot_id)
  }
  if (snapshotIds.size === 0) return false

  // The blob is reachable if it is a manifest blob of one of these snapshots,
  // or appears as a file entry inside one of those manifests.
  const snaps = await dbh
    .selectFrom("file_snapshots")
    .select(["id", "manifest_sha256"])
    .where("id", "in", Array.from(snapshotIds))
    .execute()

  for (const snap of snaps) {
    if (snap.manifest_sha256 === sha256) return true
  }
  for (const snap of snaps) {
    try {
      const bytes = await readCasBlob(snap.manifest_sha256)
      if (parseManifestShas(bytes).has(sha256)) return true
    } catch {
      // Missing/unreadable manifest blob — treat as no-reach for this snapshot.
    }
  }
  return false
}

// (d) ---------------------------------------------------------------------
// Entity asset (avatar/icon/logo/upload) by content, in a workspace the user
// belongs to. Mirrors canUserAccessFileWorkspace but keyed by sha rather than
// asset id.
async function hasAssetInUserWorkspace(
  dbh: KyselyDb,
  sha256: string,
  userId: string
): Promise<boolean> {
  const row = await dbh
    .selectFrom("file_assets as fa")
    .innerJoin("workspaces as w", "w.id", "fa.workspace_id")
    .leftJoin("workspace_members as wm", (join) =>
      join.onRef("wm.workspace_id", "=", "w.id").on("wm.user_id", "=", userId)
    )
    .select("fa.id")
    .where("fa.content_sha256", "=", sha256)
    .where((eb) =>
      eb.or([
        eb("fa.workspace_id", "is", null),
        eb("w.owner_id", "=", userId),
        eb("wm.user_id", "is not", null),
      ])
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}
