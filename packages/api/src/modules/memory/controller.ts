import { db } from "../../infrastructure/database/kysely.js"
import { z } from "zod"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import {
  CANONICAL_FILE_CATEGORIES,
  MEMORY_CATEGORIES,
  MEMORY_ITEM_STATES,
  MEMORY_RECALL_TYPES,
  MEMORY_STABILITIES,
} from "@synapse/shared/constants"
import { MEMORY_PERMISSIONS, SUBJECT_KIND } from "@synapse/shared"
import type { SubjectRef } from "@synapse/shared"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
import {
  authorizeAction,
  authorizePermission,
  getRequestAccessSubject,
  type AccessSubject,
} from "../access/service.js"
import {
  checkPermission,
  hasMemorySpaceOwnerImplicitPermissionForTuple,
} from "../access/evaluator.js"
import { buildRuntimePrincipalContext } from "../access/subject-resolution.js"
import {
  insertMemoryAccessGrant,
  listActiveMemoryAccessGrants,
  revokeMemoryAccessGrant,
} from "./access-grant-storage.js"
import {
  createMemory,
  deleteMemory,
  findExistingMemorySpace,
  moveMemoryToSpace,
  resolveOrCreateMemorySpace,
  getMemory,
  listMemories,
  MemoryError,
  presetToOwnerScope,
  recallMemories,
  runMemorySearch,
  updateMemory,
  validateMemorySpaceTuple,
  type CreateMemoryInput,
  type MemoryPreset,
  type UpdateMemoryInput,
} from "./service.js"

/**
 * D4 preset shim: legacy callers send a literal preset string. The controller
 * translates `{preset, actorId?, conversationId?, workspaceMemberId?}` into
 * the canonical `{owner, scope?, namespaceKey}` shape the service expects.
 */
const MEMORY_PRESETS = [
  "workspace_shared",
  "conversation_shared",
  "actor_private",
  "participant_private",
  "user_private",
] as const satisfies readonly MemoryPreset[]
const memoryPresetEnum = z.enum(MEMORY_PRESETS)
const memoryCategoryEnum = z.enum(MEMORY_CATEGORIES)
const memoryStateEnum = z.enum(MEMORY_ITEM_STATES)
const memoryStabilityEnum = z.enum(MEMORY_STABILITIES)

function accessSubjectToSubjectRef(subject: AccessSubject): SubjectRef | null {
  switch (subject.type) {
    case "actor":
      return { kind: SUBJECT_KIND.ACTOR, actorId: subject.id }
    case "workspace_member":
      return { kind: SUBJECT_KIND.WORKSPACE_MEMBER, memberId: subject.id }
    default:
      return null
  }
}

const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.uuid().optional(),
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    id: z.uuid().optional(),
    type: z.literal("file_ref"),
    sha256: z.string().length(64),
    path: z.string().min(1).optional(),
    mimeType: z.string(),
    name: z.string(),
    sizeBytes: z.number(),
    category: z.enum(CANONICAL_FILE_CATEGORIES),
  }),
])

// SubjectRef for owner: workspace_member | actor | remote_agent | workspace | conversation.
// user / external / system are intentionally not memory owners in this
// iteration — see `isMemoryOwnerSubjectKind` in shared for the rationale.
// Platform-wide user memory would require a separate schema (cross-tenant
// indexing + recall pipeline) and is out of scope here.
const ownerSubjectRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE),
    workspaceId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE_MEMBER),
    memberId: z.uuid(),
  }),
  z.object({ kind: z.literal(SUBJECT_KIND.ACTOR), actorId: z.uuid() }),
  z.object({
    kind: z.literal(SUBJECT_KIND.REMOTE_AGENT),
    remoteAgentId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.CONVERSATION),
    conversationId: z.uuid(),
  }),
])

const scopeSubjectRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE),
    workspaceId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.CONVERSATION),
    conversationId: z.uuid(),
  }),
])

const memoryPayloadBase = z.object({
  // Preset shim
  preset: memoryPresetEnum.optional(),
  presetActorId: z.uuid().optional(),
  presetConversationId: z.uuid().optional(),
  presetWorkspaceMemberId: z.uuid().optional(),
  // Canonical
  owner: ownerSubjectRefSchema.optional(),
  scope: scopeSubjectRefSchema.optional(),
  namespaceKey: z.string().max(255).optional(),
  category: memoryCategoryEnum.optional(),
  state: memoryStateEnum.optional(),
  status: memoryStateEnum.optional(),
  stability: memoryStabilityEnum.optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  content: z.string().optional(),
  contentBlocks: z.array(contentBlockSchema).optional(),
  textDigest: z.string().optional(),
  searchText: z.string().optional(),
  sourceItemId: z.uuid().optional(),
  sourceToolCallId: z.uuid().optional(),
  sourceTurnId: z.uuid().optional(),
  supersedesMemoryId: z.uuid().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
})

const createMemorySchema = memoryPayloadBase
  .extend({
    category: memoryCategoryEnum,
  })
  .refine(
    (value) => !!value.content || !!value.contentBlocks || !!value.textDigest,
    {
      message: "content, contentBlocks, or textDigest is required",
    }
  )

const updateMemorySchema = memoryPayloadBase.partial()

const listMemoriesSchema = z.object({
  actorId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  workspaceMemberId: z.uuid().optional(),
  owner: ownerSubjectRefSchema.optional(),
  scope: scopeSubjectRefSchema.optional(),
  namespaceKey: z.string().max(255).optional(),
  category: memoryCategoryEnum.optional(),
  state: memoryStateEnum.optional(),
  status: memoryStateEnum.optional(),
  tags: z
    .union([
      z.string().transform((value) =>
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      ),
      z.array(z.string()),
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const searchMemoriesSchema = z.object({
  queryText: z.string().min(1),
  actorId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  workspaceMemberId: z.uuid().optional(),
  owners: z.array(ownerSubjectRefSchema).optional(),
  scopes: z.array(scopeSubjectRefSchema).optional(),
  namespaceKeys: z.array(z.string().max(255)).optional(),
  categories: z.array(memoryCategoryEnum).optional(),
  states: z.array(memoryStateEnum).optional(),
  statuses: z.array(memoryStateEnum).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
})

const recallMemoriesSchema = searchMemoriesSchema.extend({
  recallType: z.enum(
    MEMORY_RECALL_TYPES.filter((value) => value !== "manual_search") as [
      "bootstrap",
      "turn_recall",
    ]
  ),
  queryBlocks: z.array(contentBlockSchema).optional(),
})

const grantSubjectRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE),
    workspaceId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE_MEMBER),
    memberId: z.uuid(),
  }),
  z.object({ kind: z.literal(SUBJECT_KIND.ACTOR), actorId: z.uuid() }),
  z.object({
    kind: z.literal(SUBJECT_KIND.REMOTE_AGENT),
    remoteAgentId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.CONVERSATION),
    conversationId: z.uuid(),
  }),
])

const createMemoryGrantSchema = z.object({
  memoryItemId: z.uuid().nullish(),
  subject: grantSubjectRefSchema,
  scope: scopeSubjectRefSchema.optional(),
  permissions: z.array(z.enum(MEMORY_PERMISSIONS)).min(1),
  source: z.string().max(64).nullish(),
})

// P1 fix (post-D4 review): atomic move replaces the web UI's delete + create
// (which dropped item-level grants, indexing state, and the stable id).
// Caller supplies the target memory_space coordinates; the controller
// checks `delete` on the source and `write` on the target before the
// service swaps memory_space_id in a single transaction.
const moveMemorySchema = z.object({
  owner: ownerSubjectRefSchema,
  scope: scopeSubjectRefSchema.optional(),
  namespaceKey: z.string().max(255).optional(),
})

type CreateBody = z.infer<typeof createMemorySchema>
type UpdateBody = z.infer<typeof updateMemorySchema>

/**
 * Resolve a payload's owner/scope/namespaceKey from either the canonical
 * fields or the legacy preset shim. Throws MemoryError when the preset is
 * referenced but the required context is missing.
 */
function resolveOwnerScope(
  workspaceId: string,
  body: Pick<
    CreateBody | UpdateBody,
    | "owner"
    | "scope"
    | "preset"
    | "presetActorId"
    | "presetConversationId"
    | "presetWorkspaceMemberId"
  >
): { owner?: SubjectRef; scope?: SubjectRef } {
  if (body.owner) {
    return { owner: body.owner, scope: body.scope }
  }
  if (body.preset) {
    const translated = presetToOwnerScope(body.preset, {
      workspaceId,
      actorId: body.presetActorId,
      conversationId: body.presetConversationId,
      workspaceMemberId: body.presetWorkspaceMemberId,
    })
    if (!translated) {
      throw new MemoryError(
        `Memory preset '${body.preset}' requires actor/conversation/workspaceMember context`,
        400
      )
    }
    return translated
  }
  return {}
}

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof MemoryError) {
    return reply.status(error.statusCode).send({ error: error.message })
  }
  if (error instanceof z.ZodError) {
    return reply.status(400).send({
      error: "Validation failed",
      details: error.issues.map((item) => ({
        field: item.path.join("."),
        message: item.message,
      })),
    })
  }
  throw error
}

async function requireWorkspacePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  action: "workspace.view" | "workspace.manage_memories",
  errorMessage: string
) {
  const { workspaceId } = request.params as { workspaceId: string }
  return requireRequestAction(request, reply, action, workspaceId, errorMessage)
}

async function requireMemoryPermission(
  request: FastifyRequest,
  reply: FastifyReply,
  memoryId: string,
  permission: "read" | "edit" | "delete",
  errorMessage: string
) {
  // D4: derive the conversation context from the memory_space owner / scope
  // subject (conversation owner OR conversation scope). Used to enrich the
  // runtime context so a `subject=actor + scope=conversation` grant matches.
  const subject = getRequestAccessSubject(request)
  const { workspaceId } = request.params as { workspaceId: string }
  const principal = accessSubjectToSubjectRef(subject)
  let runtimeSubjectIds: readonly string[] | undefined
  let runtimeScopeSubjectIds: readonly string[] | undefined
  if (principal) {
    const query = (request.query ?? {}) as { conversationId?: string }
    let conversationId =
      typeof query.conversationId === "string" &&
      query.conversationId.length > 0
        ? query.conversationId
        : undefined
    if (!conversationId) {
      const spaceAnchor = await db
        .selectFrom("memoryItems as mi")
        .innerJoin("memorySpaces as ms", "ms.id", "mi.memorySpaceId")
        .innerJoin(
          "accessSubjects as owner_subj",
          "owner_subj.id",
          "ms.ownerSubjectId"
        )
        .leftJoin(
          "accessSubjects as scope_subj",
          "scope_subj.id",
          "ms.scopeSubjectId"
        )
        .select([
          "owner_subj.conversationId as ownerConv",
          "scope_subj.conversationId as scopeConv",
        ])
        .where("mi.id", "=", memoryId)
        .where("mi.workspaceId", "=", workspaceId)
        .limit(1)
        .executeTakeFirst()
      conversationId =
        spaceAnchor?.scopeConv ?? spaceAnchor?.ownerConv ?? undefined
    }
    try {
      const ctx = await buildRuntimePrincipalContext(db, {
        principal,
        workspaceId,
        conversationId,
      })
      runtimeSubjectIds = ctx.runtimeSubjectIds
      runtimeScopeSubjectIds = ctx.runtimeScopeSubjectIds
    } catch {
      // principal not in workspace
    }
  }
  const allowed = await authorizePermission(db, {
    subject,
    resourceType: "memory_item",
    resourceId: memoryId,
    permission,
    runtimeSubjectIds,
    runtimeScopeSubjectIds,
  })

  if (!allowed) {
    reply.status(403).send({ error: errorMessage })
    return false
  }

  return true
}

/**
 * D4: gate writes to a (owner, scope?) tuple via the evaluator's
 * memory_space.write check.
 *
 * Post-D4 round 3 review (P2): detect-then-check-then-create. Earlier
 * iterations pre-upserted the target memory_space row and then asked the
 * evaluator for `write` permission on the resolved id. That had two
 * side effects:
 *   1. Denied calls left an orphan empty memory_spaces row that any caller
 *      with workspace.view could fabricate by sending a 403-ed request.
 *   2. Cross-workspace owner/scope or other trigger-rejection cases
 *      bubbled as a 500 instead of a clean 400.
 * Now: validate the (workspace, owner, scope?) tuple (workspace alignment
 * and owner-kind allowlist) up-front; look up any existing space row by
 * tuple; run the auth check against the existing row OR — when no row
 * exists yet — against a synthetic owner-implicit-only evaluation. Only
 * the create transaction proceeds to actually INSERT the space row.
 *
 * Returns `{ ok: boolean }`. The caller does not need the resolved space
 * id because `createMemory` calls `resolveOrCreateMemorySpace` inside its
 * own transaction (idempotent via ON CONFLICT). An earlier version of
 * this helper returned the id, but no caller used it — that contract
 * drift was flagged in review and removed.
 */
async function requireMemorySpaceWritePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  owner: SubjectRef | undefined,
  scope: SubjectRef | undefined,
  namespaceKey: string | undefined,
  errorMessage: string
): Promise<{ ok: true } | { ok: false }> {
  if (!owner) {
    reply.status(400).send({ error: "owner is required" })
    return { ok: false }
  }
  const { workspaceId } = request.params as { workspaceId: string }
  const subject = getRequestAccessSubject(request)
  const principal = accessSubjectToSubjectRef(subject)
  if (!principal) {
    reply.status(403).send({ error: "Caller is not a workspace principal" })
    return { ok: false }
  }

  let runtimeSubjectIds: readonly string[] = []
  let runtimeScopeSubjectIds: readonly string[] = []
  try {
    const ctx = await buildRuntimePrincipalContext(db, {
      principal,
      workspaceId,
      conversationId:
        scope?.kind === SUBJECT_KIND.CONVERSATION
          ? scope.conversationId
          : owner.kind === SUBJECT_KIND.CONVERSATION
            ? owner.conversationId
            : null,
    })
    runtimeSubjectIds = ctx.runtimeSubjectIds
    runtimeScopeSubjectIds = ctx.runtimeScopeSubjectIds
  } catch {
    reply
      .status(403)
      .send({ error: "Caller does not belong to this workspace" })
    return { ok: false }
  }

  // Validate the tuple before any writes — workspace alignment + owner
  // kind allowlist. Throws MemoryError(400) on mismatch.
  let subjects: { ownerSubjectId: string; scopeSubjectId: string | null }
  try {
    subjects = await validateMemorySpaceTuple(workspaceId, owner, scope)
  } catch (error) {
    if (error instanceof MemoryError) {
      reply.status(error.statusCode).send({ error: error.message })
      return { ok: false }
    }
    throw error
  }

  const existing = await findExistingMemorySpace({
    workspaceId,
    ownerSubjectId: subjects.ownerSubjectId,
    scopeSubjectId: subjects.scopeSubjectId,
    namespaceKey,
  })

  let allowed = false
  if (existing) {
    allowed = await authorizePermission(db, {
      subject,
      resourceType: "memory_space",
      resourceId: existing.id,
      permission: "write",
      runtimeSubjectIds,
      runtimeScopeSubjectIds,
    })
  } else {
    // No existing row — there can't be any memory_access_grants for it
    // yet, so the owner-implicit evaluator is sufficient (and avoids
    // writing the placeholder space we'd otherwise leak on denial).
    allowed = await hasMemorySpaceOwnerImplicitPermissionForTuple(
      db,
      subject,
      {
        workspaceId,
        owner,
        scope,
        ownerSubjectId: subjects.ownerSubjectId,
        scopeSubjectId: subjects.scopeSubjectId,
      },
      "write",
      { runtimeSubjectIds, runtimeScopeSubjectIds }
    )
  }
  if (!allowed) {
    reply.status(403).send({ error: errorMessage })
    return { ok: false }
  }
  return { ok: true }
}

function updateTouchesMemoryEdit(body: UpdateBody) {
  return (
    body.category !== undefined ||
    body.state !== undefined ||
    body.status !== undefined ||
    body.importance !== undefined ||
    body.confidence !== undefined ||
    body.tags !== undefined ||
    body.content !== undefined ||
    body.contentBlocks !== undefined ||
    body.textDigest !== undefined ||
    body.searchText !== undefined ||
    body.sourceItemId !== undefined ||
    body.sourceToolCallId !== undefined ||
    body.sourceTurnId !== undefined ||
    body.supersedesMemoryId !== undefined ||
    body.metadata !== undefined
  )
}

function updateTouchesRetarget(body: UpdateBody) {
  return (
    body.owner !== undefined ||
    body.scope !== undefined ||
    body.namespaceKey !== undefined ||
    body.preset !== undefined
  )
}

export function registerMemoryRoutes(app: FastifyInstance) {
  const prefix = "/api/v1/workspaces/:workspaceId/memories"
  const preHandler = [authMiddleware, workspaceMiddleware]

  app.post(
    prefix,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.view",
          "Not allowed to view this workspace"
        )
        if (!allowed) return

        const { workspaceId } = request.params as { workspaceId: string }
        const body = createMemorySchema.parse(request.body)
        const { owner, scope } = resolveOwnerScope(workspaceId, body)
        if (!owner) {
          return reply
            .status(400)
            .send({ error: "owner or preset is required" })
        }
        const canWrite = await requireMemorySpaceWritePermission(
          request,
          reply,
          owner,
          scope,
          body.namespaceKey,
          "Not allowed to create a memory in this path"
        )
        if (!canWrite.ok) return

        const input: CreateMemoryInput = {
          owner,
          scope,
          namespaceKey: body.namespaceKey,
          category: body.category,
          state: body.state,
          status: body.status,
          stability: body.stability,
          importance: body.importance,
          confidence: body.confidence,
          tags: body.tags,
          content: body.content,
          contentBlocks: body.contentBlocks,
          textDigest: body.textDigest,
          searchText: body.searchText,
          sourceItemId: body.sourceItemId,
          sourceToolCallId: body.sourceToolCallId,
          sourceTurnId: body.sourceTurnId,
          supersedesMemoryId: body.supersedesMemoryId,
          metadata: body.metadata,
        }
        const memory = await createMemory(workspaceId, input)
        return reply.status(201).send({ memory })
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  app.get(
    prefix,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.view",
          "Not allowed to view this workspace"
        )
        if (!allowed) return

        const { workspaceId } = request.params as { workspaceId: string }
        const filters = listMemoriesSchema.parse(request.query)
        const memories = await listMemories(workspaceId, {
          ...filters,
          accessSubject: getRequestAccessSubject(request),
        })
        return reply.status(200).send({ memories })
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  app.get(
    `${prefix}/:memoryId`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.view",
          "Not allowed to view this workspace"
        )
        if (!allowed) return

        const { workspaceId, memoryId } = request.params as {
          workspaceId: string
          memoryId: string
        }
        const memory = await getMemory(workspaceId, memoryId)
        const readable = await requireMemoryPermission(
          request,
          reply,
          memoryId,
          "read",
          "Not allowed to read this memory"
        )
        if (!readable) return
        return reply.status(200).send({ memory })
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  app.put(
    `${prefix}/:memoryId`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { workspaceId, memoryId } = request.params as {
          workspaceId: string
          memoryId: string
        }
        const body = updateMemorySchema.parse(request.body)

        if (updateTouchesRetarget(body)) {
          // D4: cross-space moves go through delete + create. Refuse.
          return reply.status(400).send({
            error:
              "Memory move is not supported via PUT; delete and re-create instead",
          })
        }

        // P1 fix (post-D4 round 4 review): empty PUT must not pass through
        // un-authorized. The update schema is fully optional; an empty body
        // would skip both the retarget check above and the edit check below,
        // but `updateMemory` still loaded + returned the memory contents.
        // Net: any caller with workspace.view could read any memory by
        // sending PUT {}. Reject empty body up-front so the route always
        // requires a permission-checked path (edit for content changes,
        // the explicit no-op shape isn't supported).
        if (!updateTouchesMemoryEdit(body)) {
          return reply.status(400).send({
            error:
              "PUT body must include at least one editable field (category, state, importance, confidence, tags, content, contentBlocks, textDigest, metadata, …)",
          })
        }

        const allowed = await requireMemoryPermission(
          request,
          reply,
          memoryId,
          "edit",
          "Not allowed to edit this memory"
        )
        if (!allowed) return

        const memory = await updateMemory(
          workspaceId,
          memoryId,
          body as UpdateMemoryInput
        )
        return reply.status(200).send({ memory })
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  app.delete(
    `${prefix}/:memoryId`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { workspaceId, memoryId } = request.params as {
          workspaceId: string
          memoryId: string
        }
        const allowed = await requireMemoryPermission(
          request,
          reply,
          memoryId,
          "delete",
          "Not allowed to delete this memory"
        )
        if (!allowed) return

        await deleteMemory(workspaceId, memoryId)
        return reply.status(204).send()
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  // P1 fix (post-D4 review): atomic move endpoint. Caller needs `delete` on
  // the source space + `write` on the target space (same contract as the
  // documented "source delete + target write" pattern, just enforced
  // together inside one transaction so the stable id, item-level grants,
  // indexing state, and source_*_id relations all survive).
  app.post(
    `${prefix}/:memoryId/move`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { workspaceId, memoryId } = request.params as {
          workspaceId: string
          memoryId: string
        }
        const body = moveMemorySchema.parse(request.body)

        // P1 fix (post-D4 round 5 review): source `read` AND source
        // `delete` both required. The previous "delete is enough" rule
        // let workspace admins (who hold `manage_memories` and therefore
        // get `delete` on private spaces via the cleanup
        // adminManageOverride) move actor_private memory into
        // workspace_shared and read the contents from the response —
        // i.e., cleanup-delete became silent read. Requiring read on
        // the source closes that path: admin doesn't have read on
        // private spaces (curation is write-only too), so the move 403s
        // before any contents are touched.
        const sourceReadable = await requireMemoryPermission(
          request,
          reply,
          memoryId,
          "read",
          "Not allowed to move this memory (source read required)"
        )
        if (!sourceReadable) return
        // Source `delete` permission (requireMemoryPermission also resolves
        // the source space's conversation anchor for the runtime context).
        const sourceAllowed = await requireMemoryPermission(
          request,
          reply,
          memoryId,
          "delete",
          "Not allowed to move this memory out of its current space"
        )
        if (!sourceAllowed) return

        // Target write check is enforced inside `moveMemoryToSpace` after
        // the target space is upserted (so the evaluator runs against the
        // resolved space id). We build the runtime context here for the
        // service to consult; if the principal can't be coerced into a
        // RuntimePrincipalContext we fail closed.
        const subject = getRequestAccessSubject(request)
        const principal = accessSubjectToSubjectRef(subject)
        if (!principal) {
          reply
            .status(403)
            .send({ error: "Caller is not a workspace principal" })
          return
        }
        let runtimeSubjectIds: readonly string[] = []
        let runtimeScopeSubjectIds: readonly string[] = []
        try {
          const ctx = await buildRuntimePrincipalContext(db, {
            principal,
            workspaceId,
            // Surface the target conversation (if any) so write permission
            // on a conversation-owned/scoped target evaluates correctly.
            conversationId:
              body.scope?.kind === SUBJECT_KIND.CONVERSATION
                ? body.scope.conversationId
                : body.owner.kind === SUBJECT_KIND.CONVERSATION
                  ? body.owner.conversationId
                  : null,
          })
          runtimeSubjectIds = ctx.runtimeSubjectIds
          runtimeScopeSubjectIds = ctx.runtimeScopeSubjectIds
        } catch {
          reply.status(403).send({
            error: "Caller does not belong to this workspace",
          })
          return
        }

        const moved = await moveMemoryToSpace(
          workspaceId,
          memoryId,
          {
            owner: body.owner,
            scope: body.scope,
            namespaceKey: body.namespaceKey,
          },
          {
            accessSubject: subject,
            runtimeSubjectIds,
            runtimeScopeSubjectIds,
          }
        )

        // P1 fix (post-D4 round 5 review): re-check `read` on the moved
        // memory before returning contents. After the move the item
        // lives in the target space, where the principal may have only
        // `write` (admin curation path or workspace-admin manage_memories
        // on workspace-owned target) but not `read`. Without this gate
        // the move response leaks contents the caller can't otherwise
        // read. Build a fresh runtime context for the target's
        // conversation (if any) so conversation-scoped target read
        // evaluates correctly.
        let postMoveReadCtx = {
          runtimeSubjectIds: runtimeSubjectIds,
          runtimeScopeSubjectIds: runtimeScopeSubjectIds,
        }
        try {
          // The moved memory now belongs to the target space — recompute
          // the runtime context against the target's conversation
          // anchor (the request-time context may have been tuned for
          // the SOURCE conversation by requireMemoryPermission).
          const targetConversationId =
            body.scope?.kind === SUBJECT_KIND.CONVERSATION
              ? body.scope.conversationId
              : body.owner.kind === SUBJECT_KIND.CONVERSATION
                ? body.owner.conversationId
                : null
          const targetCtx = await buildRuntimePrincipalContext(db, {
            principal,
            workspaceId,
            conversationId: targetConversationId,
          })
          postMoveReadCtx = {
            runtimeSubjectIds: targetCtx.runtimeSubjectIds,
            runtimeScopeSubjectIds: targetCtx.runtimeScopeSubjectIds,
          }
        } catch {
          // keep the source-side context as a conservative fallback
        }
        const readAllowed = await authorizePermission(db, {
          subject,
          resourceType: "memory_item",
          resourceId: memoryId,
          permission: "read",
          runtimeSubjectIds: postMoveReadCtx.runtimeSubjectIds,
          runtimeScopeSubjectIds: postMoveReadCtx.runtimeScopeSubjectIds,
        })
        if (!readAllowed) {
          // Move succeeded but the principal can't read the destination
          // — surface success without leaking contents.
          return reply.status(200).send({
            id: moved.id,
            spaceId: moved.spaceId,
            moved: true,
          })
        }
        return reply.status(200).send(moved)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  app.post(
    `${prefix}/search`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.view",
          "Not allowed to view this workspace"
        )
        if (!allowed) return

        const { workspaceId } = request.params as { workspaceId: string }
        const body = searchMemoriesSchema.parse(request.body)
        const result = await runMemorySearch(workspaceId, {
          ...body,
          accessSubject: getRequestAccessSubject(request),
        })
        return reply.status(200).send(result)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  app.post(
    `${prefix}/recall`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.view",
          "Not allowed to view this workspace"
        )
        if (!allowed) return

        const { workspaceId } = request.params as { workspaceId: string }
        const body = recallMemoriesSchema.parse(request.body)
        const result = await recallMemories(workspaceId, {
          ...body,
          accessSubject: getRequestAccessSubject(request),
        })
        return reply.status(200).send(result)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  // Memory space grants (PR6, unchanged shape).
  async function assertSpaceBelongsToWorkspace(
    spaceId: string,
    workspaceId: string,
    reply: FastifyReply
  ): Promise<boolean> {
    const row = await db
      .selectFrom("memorySpaces")
      .select(["id", "workspaceId"])
      .where("id", "=", spaceId)
      .limit(1)
      .executeTakeFirst()
    if (!row || row.workspaceId !== workspaceId) {
      reply.status(404).send({ error: "memory space not found in workspace" })
      return false
    }
    return true
  }

  async function assertSpaceManageable(
    request: FastifyRequest,
    reply: FastifyReply,
    workspaceId: string,
    spaceId: string
  ): Promise<boolean> {
    const subject = getRequestAccessSubject(request)
    const principal = accessSubjectToSubjectRef(subject)
    const query = (request.query ?? {}) as { conversationId?: string }
    const conversationId =
      typeof query.conversationId === "string" &&
      query.conversationId.length > 0
        ? query.conversationId
        : undefined
    let runtimeSubjectIds: readonly string[] | undefined
    let runtimeScopeSubjectIds: readonly string[] | undefined
    if (principal) {
      try {
        const ctx = await buildRuntimePrincipalContext(db, {
          principal,
          workspaceId,
          conversationId,
        })
        runtimeSubjectIds = ctx.runtimeSubjectIds
        runtimeScopeSubjectIds = ctx.runtimeScopeSubjectIds
      } catch {
        // not in workspace
      }
    }
    const managePermitted = await checkPermission(db, {
      resourceType: "memory_space",
      resourceId: spaceId,
      permission: "manage",
      subject,
      runtimeSubjectIds,
      runtimeScopeSubjectIds,
    })
    if (!managePermitted) {
      reply.status(403).send({
        error: "Not allowed to manage grants on this memory space",
      })
      return false
    }
    return true
  }

  app.post(
    `${prefix}/spaces/:spaceId/grants`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.view",
          "Not allowed to view this workspace"
        )
        if (!allowed) return
        const { workspaceId, spaceId } = request.params as {
          workspaceId: string
          spaceId: string
        }
        if (!(await assertSpaceBelongsToWorkspace(spaceId, workspaceId, reply)))
          return
        if (
          !(await assertSpaceManageable(request, reply, workspaceId, spaceId))
        )
          return

        const body = createMemoryGrantSchema.parse(request.body)
        if (body.memoryItemId) {
          const itemRow = await db
            .selectFrom("memoryItems")
            .select(["id", "memorySpaceId", "workspaceId"])
            .where("id", "=", body.memoryItemId)
            .limit(1)
            .executeTakeFirst()
          if (
            !itemRow ||
            itemRow.memorySpaceId !== spaceId ||
            itemRow.workspaceId !== workspaceId
          ) {
            return reply
              .status(404)
              .send({ error: "memory item not found in space" })
          }
        }

        const grant = await insertMemoryAccessGrant(db, {
          workspaceId,
          memorySpaceId: spaceId,
          memoryItemId: body.memoryItemId ?? null,
          subject: body.subject,
          scope: body.scope,
          permissions: body.permissions,
          source: body.source ?? null,
          createdByWorkspaceMemberId:
            getRequestAccessSubject(request).type === "workspace_member"
              ? getRequestAccessSubject(request).id
              : null,
        })
        return reply.status(201).send({ grant })
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  app.get(
    `${prefix}/spaces/:spaceId/grants`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.view",
          "Not allowed to view this workspace"
        )
        if (!allowed) return
        const { workspaceId, spaceId } = request.params as {
          workspaceId: string
          spaceId: string
        }
        if (!(await assertSpaceBelongsToWorkspace(spaceId, workspaceId, reply)))
          return
        if (
          !(await assertSpaceManageable(request, reply, workspaceId, spaceId))
        )
          return
        const grants = await listActiveMemoryAccessGrants(db, spaceId)
        return reply.status(200).send({ grants })
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  app.delete(
    `${prefix}/spaces/:spaceId/grants/:grantId`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.view",
          "Not allowed to view this workspace"
        )
        if (!allowed) return
        const { workspaceId, spaceId, grantId } = request.params as {
          workspaceId: string
          spaceId: string
          grantId: string
        }
        if (!(await assertSpaceBelongsToWorkspace(spaceId, workspaceId, reply)))
          return
        if (
          !(await assertSpaceManageable(request, reply, workspaceId, spaceId))
        )
          return
        const grantRow = await db
          .selectFrom("memoryAccessGrants")
          .select(["id", "memorySpaceId", "workspaceId"])
          .where("id", "=", grantId)
          .limit(1)
          .executeTakeFirst()
        if (
          !grantRow ||
          grantRow.memorySpaceId !== spaceId ||
          grantRow.workspaceId !== workspaceId
        ) {
          return reply.status(404).send({ error: "grant not found in space" })
        }
        const revoked = await revokeMemoryAccessGrant(db, grantId)
        return reply.status(200).send({ revoked })
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )
}
