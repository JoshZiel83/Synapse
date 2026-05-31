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

import { sql } from "kysely"
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
 * The grant-relevant subject id sets for a user in ONE workspace, mirroring
 * buildRuntimePrincipalContext (access/subject-resolution.ts) for a
 * workspace_member principal:
 *   - subjectIds:  ids that may appear as a grant's `subject_id` for this user —
 *       their workspace_member subject + the workspace subject (workspace-level
 *       grants apply to every member).
 *   - scopeIds:    ids valid as a grant's `scope_subject_id` for this user —
 *       the workspace subject + every conversation the user actively
 *       participates in. A grant with scope_subject_id NULL is always in scope;
 *       a scoped grant only applies when its scope is in this set.
 * Returns null sets when the user isn't a member of the workspace.
 */
async function resolveUserGrantContext(
  dbh: KyselyDb,
  workspaceId: string,
  userId: string
): Promise<{ subjectIds: string[]; scopeIds: string[] } | null> {
  // The user's workspace_member row in THIS workspace (membership gate).
  const member = await dbh
    .selectFrom("workspace_members")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("user_id", "=", userId)
    .limit(1)
    .executeTakeFirst()
  if (!member) return null

  const subjectIds: string[] = []
  const scopeIds: string[] = []

  // workspace_member subject.
  const wmSubject = await dbh
    .selectFrom("access_subjects")
    .select("id")
    .where("kind", "=", "workspace_member")
    .where("workspace_member_id", "=", member.id)
    .limit(1)
    .executeTakeFirst()
  if (wmSubject) subjectIds.push(wmSubject.id)

  // workspace subject (workspace-level grants + workspace scope).
  const wsSubject = await dbh
    .selectFrom("access_subjects")
    .select("id")
    .where("kind", "=", "workspace")
    .where("workspace_id", "=", workspaceId)
    .limit(1)
    .executeTakeFirst()
  if (wsSubject) {
    subjectIds.push(wsSubject.id)
    scopeIds.push(wsSubject.id)
  }

  // Conversation subjects for conversations in this workspace where the user is
  // an active participant (valid scopes for scoped grants).
  const convSubjects = await dbh
    .selectFrom("conversation_participants as cp")
    .innerJoin("conversations as c", "c.id", "cp.conversation_id")
    .innerJoin("access_subjects as cpsubj", "cpsubj.id", "cp.subject_id")
    .innerJoin("workspace_members as wm", "wm.id", "cpsubj.workspace_member_id")
    .innerJoin("access_subjects as convsubj", (join) =>
      join
        .onRef("convsubj.conversation_id", "=", "c.id")
        .on("convsubj.kind", "=", "conversation")
    )
    .select("convsubj.id as id")
    .where("c.workspace_id", "=", workspaceId)
    .where("wm.user_id", "=", userId)
    .where("cp.state", "=", "active")
    .execute()
  for (const c of convSubjects) scopeIds.push(c.id)

  return { subjectIds, scopeIds }
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

  // tool_result parts: reachable by any active workspace_member participant of
  // the conversation the producing tool call belongs to.
  //
  // SEMANTICS (explicit, reviewed): tool results are private/internal items (not
  // in the human timeline), BUT their file_ref outputs ARE surfaced to every
  // conversation participant via the actor-activity view (web-next
  // actor-activity-bubble renders block.sha256 via /content). So the read
  // audience here = the activity-view audience = active conversation
  // participants, by design. This deliberately does NOT widen to all workspace
  // members: the participant join (cp.state='active' + workspace_member subject)
  // restricts it to humans actually in the conversation. If a future change
  // hides specific tool results from some participants, this branch must gain
  // the same per-item audience filter as branch (a).
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
// memory_item_parts / context_archive_frame_parts the user can read.
//
// Memory honors the memory space ACL: a user may read a memory_item_part's bytes
// only if, for the part's owning space, their workspace_member subject is the
// space owner (owner-implicit) OR holds an active read/recall memory_access_grant
// (space-level OR item-level for that item). Workspace membership ALONE is NOT
// sufficient — an actor-private memory space requires an explicit grant, matching
// memory/service.ts's evaluator (a workspace member can't read another principal's
// private memory just by being in the workspace).
//
// context-archive frames are conversation-scoped: readable by an active
// workspace_member participant of the frame's conversation.
async function hasReadableMemoryRef(
  dbh: KyselyDb,
  sha256: string,
  userId: string
): Promise<boolean> {
  // Candidate memory parts referencing this sha, with their space + workspace +
  // owner + (for the grant path) the grant fields. Evaluate the full ACL per
  // candidate: owner-implicit (the space owner subject is one of the user's
  // grant subjects) OR an active read/recall grant whose subject is one of the
  // user's grant subjects AND whose scope is NULL or in the user's scope set
  // (space-level or item-level for this item). This matches the memory evaluator
  // (subjectIds + scopeIds + permissions), unlike a bare workspace_member match.
  const memCandidates = await dbh
    .selectFrom("memory_item_parts as mip")
    .innerJoin("memory_items as mi", "mi.id", "mip.memory_item_id")
    .innerJoin("memory_spaces as ms", "ms.id", "mi.memory_space_id")
    .select([
      "mi.id as item_id",
      "ms.id as space_id",
      "ms.workspace_id as workspace_id",
      "ms.owner_subject_id as owner_subject_id",
    ])
    .where("mip.ref_sha256", "=", sha256)
    .execute()

  if (memCandidates.length > 0) {
    const ctxByWorkspace = new Map<
      string,
      { subjectIds: Set<string>; scopeIds: Set<string> } | null
    >()
    for (const cand of memCandidates) {
      let ctx = ctxByWorkspace.get(cand.workspace_id) as
        | { subjectIds: Set<string>; scopeIds: Set<string> }
        | null
        | undefined
      if (ctx === undefined) {
        const resolved = await resolveUserGrantContext(
          dbh,
          cand.workspace_id,
          userId
        )
        ctx = resolved
          ? {
              subjectIds: new Set(resolved.subjectIds),
              scopeIds: new Set(resolved.scopeIds),
            }
          : null
        ctxByWorkspace.set(cand.workspace_id, ctx)
      }
      if (!ctx) continue
      // owner-implicit: the space owner is one of the user's grant subjects.
      if (ctx.subjectIds.has(cand.owner_subject_id)) return true
      // active read/recall grant honoring subject + scope.
      const grant = await dbh
        .selectFrom("memory_access_grants as g")
        .select(["g.scope_subject_id"])
        .where("g.memory_space_id", "=", cand.space_id)
        .where("g.status", "=", "active")
        .where("g.subject_id", "in", Array.from(ctx.subjectIds))
        .where((geb) =>
          geb.or([
            geb("g.memory_item_id", "is", null),
            geb("g.memory_item_id", "=", cand.item_id),
          ])
        )
        .where(
          sql<boolean>`('read'::memory_permission = ANY(g.permissions) OR 'recall'::memory_permission = ANY(g.permissions))`
        )
        .execute()
      for (const g of grant) {
        if (
          g.scope_subject_id === null ||
          ctx.scopeIds.has(g.scope_subject_id)
        ) {
          return true
        }
      }
    }
  }

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
// Active file_access_grant to the user for a file_space whose live snapshots'
// manifests contain the sha. The grant check is equivalent to the main
// permission model: the grant's subject_id must be one of the user's grant
// subjects (their workspace_member subject OR the workspace subject), its
// permissions must include 'read' or 'admin' (a write-only grant does NOT
// confer read), and its scope_subject_id must be NULL or one of the user's
// in-scope subjects (workspace or an active-participant conversation). "Live
// snapshots" = the space's current_snapshot_id ∪ any active mount's base/result
// snapshot — a small, bounded set, never the whole DAG.
async function hasFileSpaceGrantReach(
  dbh: KyselyDb,
  sha256: string,
  userId: string,
  fileSpaceId: string | null
): Promise<boolean> {
  // Candidate spaces: distinct file_spaces (+ workspace) the user holds an
  // active grant on. We resolve the user's grant subject/scope sets PER the
  // grant's workspace and apply the full permission+scope predicate.
  let grantsQ = dbh
    .selectFrom("file_access_grants as g")
    .innerJoin("file_spaces as fs", "fs.id", "g.file_space_id")
    .select([
      "fs.id as space_id",
      "fs.workspace_id as workspace_id",
      "fs.current_snapshot_id as current_snapshot_id",
      "g.subject_id as subject_id",
      "g.scope_subject_id as scope_subject_id",
    ])
    .where("g.status", "=", "active")
    .where(
      sql<boolean>`('read'::file_permission = ANY(g.permissions) OR 'admin'::file_permission = ANY(g.permissions))`
    )
  if (fileSpaceId) grantsQ = grantsQ.where("fs.id", "=", fileSpaceId)
  const grantRows = await grantsQ.execute()
  if (grantRows.length === 0) return false

  // Resolve the user's grant context once per workspace (cached).
  const ctxByWorkspace = new Map<
    string,
    { subjectIds: Set<string>; scopeIds: Set<string> } | null
  >()
  const authorizedSpaceIds = new Set<string>()
  const spaceHeadSnapshot = new Map<string, string | null>()
  for (const row of grantRows) {
    let ctx = ctxByWorkspace.get(row.workspace_id) as
      | { subjectIds: Set<string>; scopeIds: Set<string> }
      | null
      | undefined
    if (ctx === undefined) {
      const resolved = await resolveUserGrantContext(
        dbh,
        row.workspace_id,
        userId
      )
      ctx = resolved
        ? {
            subjectIds: new Set(resolved.subjectIds),
            scopeIds: new Set(resolved.scopeIds),
          }
        : null
      ctxByWorkspace.set(row.workspace_id, ctx)
    }
    if (!ctx) continue
    if (!ctx.subjectIds.has(row.subject_id)) continue
    if (
      row.scope_subject_id !== null &&
      !ctx.scopeIds.has(row.scope_subject_id)
    ) {
      continue
    }
    authorizedSpaceIds.add(row.space_id)
    spaceHeadSnapshot.set(row.space_id, row.current_snapshot_id)
  }
  if (authorizedSpaceIds.size === 0) return false

  const spaceIds = Array.from(authorizedSpaceIds)

  // Snapshots to inspect: each authorized space's current head ∪ active mounts'
  // base/result snapshots.
  const snapshotIds = new Set<string>()
  for (const head of spaceHeadSnapshot.values()) {
    if (head) snapshotIds.add(head)
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
// Entity asset (avatar/icon/logo/upload) by content. A workspace-scoped asset
// is readable by that workspace's members/owner; a library-global asset
// (workspace_id IS NULL — e.g. a shared catalog icon) is readable by any
// authenticated caller, matching how /files/:id serves it. LEFT join so a
// NULL-workspace row isn't dropped before the workspace_id-IS-NULL branch.
async function hasAssetInUserWorkspace(
  dbh: KyselyDb,
  sha256: string,
  userId: string
): Promise<boolean> {
  const row = await dbh
    .selectFrom("file_assets as fa")
    .leftJoin("workspaces as w", "w.id", "fa.workspace_id")
    .leftJoin("workspace_members as wm", (join) =>
      join
        .onRef("wm.workspace_id", "=", "fa.workspace_id")
        .on("wm.user_id", "=", userId)
    )
    .select("fa.id")
    .where("fa.content_sha256", "=", sha256)
    .where((eb) =>
      eb.or([
        // Library-global asset (no workspace) → readable by any authenticated.
        eb("fa.workspace_id", "is", null),
        // Workspace-scoped → owner or member of that workspace.
        eb("w.owner_id", "=", userId),
        eb("wm.user_id", "is not", null),
      ])
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}
