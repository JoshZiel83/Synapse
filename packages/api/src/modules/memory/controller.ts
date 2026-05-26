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
import { checkPermission } from "../access/evaluator.js"
import { buildRuntimePrincipalContext } from "../access/subject-resolution.js"
import {
  insertMemoryAccessGrant,
  listActiveMemoryAccessGrants,
  revokeMemoryAccessGrant,
} from "./access-grant-storage.js"
import {
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  MemoryError,
  presetToOwnerScope,
  recallMemories,
  runMemorySearch,
  updateMemory,
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
    id: z.string().uuid().optional(),
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    id: z.string().uuid().optional(),
    type: z.literal("file_ref"),
    fileId: z.string().uuid(),
    url: z.string(),
    mimeType: z.string(),
    originalName: z.string(),
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
    workspaceId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE_MEMBER),
    memberId: z.string().uuid(),
  }),
  z.object({ kind: z.literal(SUBJECT_KIND.ACTOR), actorId: z.string().uuid() }),
  z.object({
    kind: z.literal(SUBJECT_KIND.REMOTE_AGENT),
    remoteAgentId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.CONVERSATION),
    conversationId: z.string().uuid(),
  }),
])

const scopeSubjectRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE),
    workspaceId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.CONVERSATION),
    conversationId: z.string().uuid(),
  }),
])

const memoryPayloadBase = z.object({
  // Preset shim
  preset: memoryPresetEnum.optional(),
  presetActorId: z.string().uuid().optional(),
  presetConversationId: z.string().uuid().optional(),
  presetWorkspaceMemberId: z.string().uuid().optional(),
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
  sourceItemId: z.string().uuid().optional(),
  sourceToolCallId: z.string().uuid().optional(),
  sourceTurnId: z.string().uuid().optional(),
  supersedesMemoryId: z.string().uuid().optional(),
  metadata: z.record(z.any()).optional(),
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
  actorId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  workspaceMemberId: z.string().uuid().optional(),
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
  actorId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  workspaceMemberId: z.string().uuid().optional(),
  owners: z.array(ownerSubjectRefSchema).optional(),
  scopes: z.array(scopeSubjectRefSchema).optional(),
  namespaceKeys: z.array(z.string().max(255)).optional(),
  categories: z.array(memoryCategoryEnum).optional(),
  states: z.array(memoryStateEnum).optional(),
  statuses: z.array(memoryStateEnum).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  metadata: z.record(z.any()).optional(),
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
    workspaceId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE_MEMBER),
    memberId: z.string().uuid(),
  }),
  z.object({ kind: z.literal(SUBJECT_KIND.ACTOR), actorId: z.string().uuid() }),
  z.object({
    kind: z.literal(SUBJECT_KIND.REMOTE_AGENT),
    remoteAgentId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.CONVERSATION),
    conversationId: z.string().uuid(),
  }),
])

const createMemoryGrantSchema = z.object({
  memoryItemId: z.string().uuid().nullish(),
  subject: grantSubjectRefSchema,
  scope: scopeSubjectRefSchema.optional(),
  permissions: z.array(z.enum(MEMORY_PERMISSIONS)).min(1),
  source: z.string().max(64).nullish(),
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
      details: error.errors.map((item) => ({
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
        .selectFrom("memory_items as mi")
        .innerJoin("memory_spaces as ms", "ms.id", "mi.memory_space_id")
        .innerJoin(
          "access_subjects as owner_subj",
          "owner_subj.id",
          "ms.owner_subject_id"
        )
        .leftJoin(
          "access_subjects as scope_subj",
          "scope_subj.id",
          "ms.scope_subject_id"
        )
        .select([
          "owner_subj.conversation_id as owner_conv",
          "scope_subj.conversation_id as scope_conv",
        ])
        .where("mi.id", "=", memoryId)
        .where("mi.workspace_id", "=", workspaceId)
        .limit(1)
        .executeTakeFirst()
      conversationId =
        spaceAnchor?.scope_conv ?? spaceAnchor?.owner_conv ?? undefined
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
 * D4: gate writes to a (owner, scope?) tuple via per-owner-kind policy.
 * The cases mirror the legacy preset semantics now that ownership is
 * subject-driven:
 *   - owner=workspace        -> workspace.manage_memories
 *   - owner=conversation     -> conversation.memory_edit (active participant)
 *   - owner=actor            -> actor.memory_edit
 *   - owner=remote_agent     -> ownership match OR workspace.manage_memories
 *   - owner=workspace_member -> self OR workspace.manage_memories
 */
async function requireMemorySpaceWritePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  owner: SubjectRef | undefined,
  scope: SubjectRef | undefined,
  errorMessage: string
) {
  if (!owner) {
    reply.status(400).send({ error: "owner is required" })
    return false
  }
  const workspaceMemberId = (request as any).workspaceMember?.id as
    | string
    | undefined
  const { workspaceId } = request.params as { workspaceId: string }
  const subject = getRequestAccessSubject(request)
  let allowed = false

  switch (owner.kind) {
    case SUBJECT_KIND.WORKSPACE:
      allowed = await authorizeAction(db, {
        subject,
        action: "workspace.manage_memories",
        resourceId: workspaceId,
      })
      break
    case SUBJECT_KIND.CONVERSATION:
      allowed = await authorizePermission(db, {
        subject,
        resourceType: "conversation",
        resourceId: owner.conversationId,
        permission: "memory_edit",
      })
      break
    case SUBJECT_KIND.ACTOR: {
      const actorAllowed = await authorizePermission(db, {
        subject,
        resourceType: "actor",
        resourceId: owner.actorId,
        permission: "memory_edit",
      })
      if (actorAllowed && scope?.kind === SUBJECT_KIND.CONVERSATION) {
        // For participant_private semantics: also require active conversation
        // membership / memory_edit on the conversation. The conversation
        // memory_edit check resolves to "is active participant" for actors.
        allowed = await authorizePermission(db, {
          subject,
          resourceType: "conversation",
          resourceId: scope.conversationId,
          permission: "memory_edit",
        })
      } else {
        allowed = actorAllowed
      }
      break
    }
    case SUBJECT_KIND.REMOTE_AGENT:
      allowed = await authorizeAction(db, {
        subject,
        action: "workspace.manage_memories",
        resourceId: workspaceId,
      })
      break
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      allowed = owner.memberId === workspaceMemberId
      if (!allowed) {
        allowed = await authorizeAction(db, {
          subject,
          action: "workspace.manage_memories",
          resourceId: workspaceId,
        })
      }
      break
    default:
      allowed = false
  }

  if (!allowed) {
    reply.status(403).send({ error: errorMessage })
    return false
  }

  return true
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
          "Not allowed to create a memory in this path"
        )
        if (!canWrite) return

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

        if (updateTouchesMemoryEdit(body)) {
          const allowed = await requireMemoryPermission(
            request,
            reply,
            memoryId,
            "edit",
            "Not allowed to edit this memory"
          )
          if (!allowed) return
        }

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
      .selectFrom("memory_spaces")
      .select(["id", "workspace_id"])
      .where("id", "=", spaceId)
      .limit(1)
      .executeTakeFirst()
    if (!row || row.workspace_id !== workspaceId) {
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
            .selectFrom("memory_items")
            .select(["id", "memory_space_id", "workspace_id"])
            .where("id", "=", body.memoryItemId)
            .limit(1)
            .executeTakeFirst()
          if (
            !itemRow ||
            itemRow.memory_space_id !== spaceId ||
            itemRow.workspace_id !== workspaceId
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
          .selectFrom("memory_access_grants")
          .select(["id", "memory_space_id", "workspace_id"])
          .where("id", "=", grantId)
          .limit(1)
          .executeTakeFirst()
        if (
          !grantRow ||
          grantRow.memory_space_id !== spaceId ||
          grantRow.workspace_id !== workspaceId
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
