// Content-addressed access-control repo queries for GET /api/v1/content/:sha256.
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
 *       the workspace subject + (ONLY) the CURRENT request conversation's
 *       subject when the user is an active participant of it. A grant with
 *       scope_subject_id NULL is always in scope; a scoped grant only applies
 *       when its scope is in this set. Crucially this mirrors the main runtime
 *       (subject-resolution.ts), which adds ONLY the active conversation — not
 *       every conversation the user is in — so a conversation-A-scoped grant is
 *       NOT usable from a request bound to conversation B.
 * Returns null sets when the user isn't a member of the workspace.
 */
async function resolveUserGrantContext(
  dbh: KyselyDb,
  workspaceId: string,
  userId: string,
  currentConversationId: string | null
): Promise<{ subjectIds: string[]; scopeIds: string[] } | null> {
  // The user's workspace_member row in THIS workspace (membership gate).
  const member = await dbh
    .selectFrom("workspaceMembers")
    .select("id")
    .where("workspaceId", "=", workspaceId)
    .where("userId", "=", userId)
    .limit(1)
    .executeTakeFirst()
  if (!member) return null

  const subjectIds: string[] = []
  const scopeIds: string[] = []

  // workspace_member subject.
  const wmSubject = await dbh
    .selectFrom("accessSubjects")
    .select("id")
    .where("kind", "=", "workspace_member")
    .where("workspaceMemberId", "=", member.id)
    .limit(1)
    .executeTakeFirst()
  if (wmSubject) subjectIds.push(wmSubject.id)

  // workspace subject (workspace-level grants + workspace scope).
  const wsSubject = await dbh
    .selectFrom("accessSubjects")
    .select("id")
    .where("kind", "=", "workspace")
    .where("workspaceId", "=", workspaceId)
    .limit(1)
    .executeTakeFirst()
  if (wsSubject) {
    subjectIds.push(wsSubject.id)
    scopeIds.push(wsSubject.id)
  }

  // ONLY the current request conversation's subject (when it belongs to this
  // workspace and the user is an active participant) is a valid scope — matching
  // the main runtime's "active conversation" rule. Without a ?conv= context, no
  // conversation scope is added (conversation-scoped grants don't apply).
  if (currentConversationId) {
    const convSubject = await dbh
      .selectFrom("conversationParticipants as cp")
      .innerJoin("conversations as c", "c.id", "cp.conversationId")
      .innerJoin("accessSubjects as cpsubj", "cpsubj.id", "cp.subjectId")
      .innerJoin("workspaceMembers as wm", "wm.id", "cpsubj.workspaceMemberId")
      .innerJoin("accessSubjects as convsubj", (join) =>
        join
          .onRef("convsubj.conversationId", "=", "c.id")
          .on("convsubj.kind", "=", "conversation")
      )
      .select("convsubj.id as id")
      .where("c.id", "=", currentConversationId)
      .where("c.workspaceId", "=", workspaceId)
      .where("wm.userId", "=", userId)
      .where("cp.state", "=", "active")
      .limit(1)
      .executeTakeFirst()
    if (convSubject) scopeIds.push(convSubject.id)
  }

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
  if (
    await hasReadableMemoryRef(dbh, sha256, userId, ctx.conversationId ?? null)
  ) {
    return true
  }

  // (c) file_space ACL: an active grant to the user (via their workspace_member
  // subject) for a space whose live snapshots' manifests contain the sha.
  if (
    await hasFileSpaceGrantReach(
      dbh,
      sha256,
      userId,
      ctx.fileSpaceId ?? null,
      ctx.conversationId ?? null
    )
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
    .selectFrom("conversationItemParts as cip")
    .innerJoin("conversationItems as ci", "ci.id", "cip.itemId")
    .innerJoin(
      "conversationParticipants as cp",
      "cp.conversationId",
      "ci.conversationId"
    )
    .innerJoin("accessSubjects as cpsubj", "cpsubj.id", "cp.subjectId")
    .innerJoin("workspaceMembers as wm", "wm.id", "cpsubj.workspaceMemberId")
    .select("cip.id")
    .where("cip.refSha256", "=", sha256)
    .where("wm.userId", "=", userId)
    .where("cp.state", "=", "active")
    .where("ci.scope", "=", "shared")
    .where("ci.surface", "=", "visible")
    .where((eb) =>
      eb.or([
        // No audience restriction on this item.
        eb.not(
          eb.exists(
            eb
              .selectFrom("conversationItemTargets as cit0")
              .select("cit0.itemId")
              .whereRef("cit0.itemId", "=", "ci.id")
          )
        ),
        // The caller's participant authored it.
        eb("ci.authorParticipantId", "=", eb.ref("cp.id")),
        // The caller's participant is an explicit target.
        eb.exists(
          eb
            .selectFrom("conversationItemTargets as cit")
            .select("cit.itemId")
            .whereRef("cit.itemId", "=", "ci.id")
            .whereRef("cit.targetParticipantId", "=", "cp.id")
        ),
      ])
    )
    .$if(Boolean(conversationId), (qb) =>
      qb.where("ci.conversationId", "=", conversationId as string)
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
    .selectFrom("toolResultParts as trp")
    .innerJoin("toolResults as tr", "tr.id", "trp.toolResultId")
    .innerJoin("toolCalls as tc", "tc.id", "tr.toolCallId")
    .innerJoin(
      "conversationParticipants as cp",
      "cp.conversationId",
      "tc.conversationId"
    )
    .innerJoin("accessSubjects as cpsubj", "cpsubj.id", "cp.subjectId")
    .innerJoin("workspaceMembers as wm", "wm.id", "cpsubj.workspaceMemberId")
    .select("trp.id")
    .where("trp.refSha256", "=", sha256)
    .where("wm.userId", "=", userId)
    .where("cp.state", "=", "active")
    .$if(Boolean(conversationId), (qb) =>
      qb.where("tc.conversationId", "=", conversationId as string)
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
  userId: string,
  currentConversationId: string | null
): Promise<boolean> {
  // Candidate memory parts referencing this sha, with their space + workspace +
  // owner + space scope + (for the grant path) the grant fields. Evaluate the
  // full ACL per candidate: owner-implicit (the space owner subject is one of
  // the user's grant subjects AND the space scope is NULL or in the user's
  // scope set) OR an active read/recall grant whose subject is one of the
  // user's grant subjects AND whose scope is NULL or in the user's scope set
  // (space-level or item-level for this item). Matches the memory evaluator
  // (loadOwnerImplicitSpaceIds + memoryGrantMatches), unlike a bare owner match.
  const memCandidates = await dbh
    .selectFrom("memoryItemParts as mip")
    .innerJoin("memoryItems as mi", "mi.id", "mip.memoryItemId")
    .innerJoin("memorySpaces as ms", "ms.id", "mi.memorySpaceId")
    .select([
      "mi.id as itemId",
      "ms.id as spaceId",
      "ms.workspaceId as workspaceId",
      "ms.ownerSubjectId as ownerSubjectId",
      "ms.scopeSubjectId as spaceScopeSubjectId",
    ])
    .where("mip.refSha256", "=", sha256)
    .execute()

  if (memCandidates.length > 0) {
    const ctxByWorkspace = new Map<
      string,
      { subjectIds: Set<string>; scopeIds: Set<string> } | null
    >()
    for (const cand of memCandidates) {
      let ctx = ctxByWorkspace.get(cand.workspaceId) as
        | { subjectIds: Set<string>; scopeIds: Set<string> }
        | null
        | undefined
      if (ctx === undefined) {
        const resolved = await resolveUserGrantContext(
          dbh,
          cand.workspaceId,
          userId,
          currentConversationId
        )
        ctx = resolved
          ? {
              subjectIds: new Set(resolved.subjectIds),
              scopeIds: new Set(resolved.scopeIds),
            }
          : null
        ctxByWorkspace.set(cand.workspaceId, ctx)
      }
      if (!ctx) continue
      // owner-implicit: the space owner is one of the user's grant subjects AND
      // the space's own scope is NULL or in the user's scope set (a scope=conv-A
      // space is NOT owner-readable from a conv-B request).
      if (
        ctx.subjectIds.has(cand.ownerSubjectId) &&
        (cand.spaceScopeSubjectId === null ||
          ctx.scopeIds.has(cand.spaceScopeSubjectId))
      ) {
        return true
      }
      // active read/recall grant honoring subject + scope.
      const grant = await dbh
        .selectFrom("memoryAccessGrants as g")
        .select(["g.scopeSubjectId"])
        .where("g.memorySpaceId", "=", cand.spaceId)
        .where("g.status", "=", "active")
        .where("g.subjectId", "in", Array.from(ctx.subjectIds))
        .where((geb) =>
          geb.or([
            geb("g.memoryItemId", "is", null),
            geb("g.memoryItemId", "=", cand.itemId),
          ])
        )
        .where(
          sql<boolean>`('read'::memory_permission = ANY(g.permissions) OR 'recall'::memory_permission = ANY(g.permissions))`
        )
        .execute()
      for (const g of grant) {
        if (g.scopeSubjectId === null || ctx.scopeIds.has(g.scopeSubjectId)) {
          return true
        }
      }
    }
  }

  // context-archive frames are conversation-scoped: readable by an active
  // workspace_member participant of the frame's conversation. When a ?conv=
  // context is supplied we ALSO require the archive's conversation to BE that
  // conversation — consistent with the rest of the resolver's "?conv= narrows
  // to the current conversation context" model, so a conversation-A archive ref
  // can't be authorized through a request bound to conversation B. Without
  // ?conv= we fall back to any-active-participant (e.g. a direct content link).
  const archiveRef = await dbh
    .selectFrom("contextArchiveFrameParts as cap")
    .innerJoin("contextArchiveFrames as caf", "caf.id", "cap.archiveFrameId")
    .innerJoin("contextArchivePoints as cpt", "cpt.id", "caf.archivePointId")
    .innerJoin(
      "conversationParticipants as cp",
      "cp.conversationId",
      "cpt.conversationId"
    )
    .innerJoin("accessSubjects as cpsubj", "cpsubj.id", "cp.subjectId")
    .innerJoin("workspaceMembers as wm", "wm.id", "cpsubj.workspaceMemberId")
    .select("cap.id")
    .where("cap.refSha256", "=", sha256)
    .where("wm.userId", "=", userId)
    .where("cp.state", "=", "active")
    .$if(Boolean(currentConversationId), (qb) =>
      qb.where("cpt.conversationId", "=", currentConversationId as string)
    )
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
  fileSpaceId: string | null,
  currentConversationId: string | null
): Promise<boolean> {
  // Candidate spaces: distinct file_spaces (+ workspace) the user holds an
  // active grant on. We resolve the user's grant subject/scope sets PER the
  // grant's workspace and apply the full permission+scope predicate.
  let grantsQ = dbh
    .selectFrom("fileAccessGrants as g")
    .innerJoin("fileSpaces as fs", "fs.id", "g.fileSpaceId")
    .select([
      "fs.id as spaceId",
      "fs.workspaceId as workspaceId",
      "fs.currentSnapshotId as currentSnapshotId",
      "g.subjectId as subjectId",
      "g.scopeSubjectId as scopeSubjectId",
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
    let ctx = ctxByWorkspace.get(row.workspaceId) as
      | { subjectIds: Set<string>; scopeIds: Set<string> }
      | null
      | undefined
    if (ctx === undefined) {
      const resolved = await resolveUserGrantContext(
        dbh,
        row.workspaceId,
        userId,
        currentConversationId
      )
      ctx = resolved
        ? {
            subjectIds: new Set(resolved.subjectIds),
            scopeIds: new Set(resolved.scopeIds),
          }
        : null
      ctxByWorkspace.set(row.workspaceId, ctx)
    }
    if (!ctx) continue
    if (!ctx.subjectIds.has(row.subjectId)) continue
    if (row.scopeSubjectId !== null && !ctx.scopeIds.has(row.scopeSubjectId)) {
      continue
    }
    authorizedSpaceIds.add(row.spaceId)
    spaceHeadSnapshot.set(row.spaceId, row.currentSnapshotId)
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
    .selectFrom("fileMounts as m")
    .select(["m.baseSnapshotId", "m.resultSnapshotId"])
    .where("m.fileSpaceId", "in", spaceIds)
    .where("m.status", "in", ["provisioning", "active", "committing"])
    .execute()
  for (const m of mountSnaps) {
    if (m.baseSnapshotId) snapshotIds.add(m.baseSnapshotId)
    if (m.resultSnapshotId) snapshotIds.add(m.resultSnapshotId)
  }
  if (snapshotIds.size === 0) return false

  // The blob is reachable if it is a manifest blob of one of these snapshots,
  // or appears as a file entry inside one of those manifests.
  const snaps = await dbh
    .selectFrom("fileSnapshots")
    .select(["id", "manifestSha256"])
    .where("id", "in", Array.from(snapshotIds))
    .execute()

  for (const snap of snaps) {
    if (snap.manifestSha256 === sha256) return true
  }
  for (const snap of snaps) {
    try {
      const bytes = await readCasBlob(snap.manifestSha256)
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
    .selectFrom("fileAssets as fa")
    .leftJoin("workspaces as w", "w.id", "fa.workspaceId")
    .leftJoin("workspaceMembers as wm", (join) =>
      join
        .onRef("wm.workspaceId", "=", "fa.workspaceId")
        .on("wm.userId", "=", userId)
    )
    .select("fa.id")
    .where("fa.contentSha256", "=", sha256)
    .where((eb) =>
      eb.or([
        // Library-global asset (no workspace) → readable by any authenticated.
        eb("fa.workspaceId", "is", null),
        // Workspace-scoped → owner or member of that workspace.
        eb("w.ownerId", "=", userId),
        eb("wm.userId", "is not", null),
      ])
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}
