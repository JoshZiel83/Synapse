import type { FastifyInstance } from "fastify"
import { validateAutomationRuleCreatePayload } from "@synapse/shared/automation"
import {
  SUBJECT_KIND,
  actorRef,
  conversationRef,
  remoteAgentRef,
  workspaceMemberRef,
  workspaceRef,
  type CapabilityAccessTarget,
  type WorkspaceResourceGrantPermission,
} from "@synapse/shared"
import { IsoInstantStringSchema } from "@synapse/shared/schemas"
import {
  AutomationEventIngestInputSchema,
  AutomationEventIngestResultSchema,
  AutomationEventSourceAccessStateSchema,
  AutomationEventSourceCreateInputSchema,
  AutomationEventSourceListSchema,
  AutomationEventSourceListQuerySchema,
  AutomationEventSourceSchema,
  AutomationEventSourceUpdateInputSchema,
  AutomationExecutionListSchema,
  AutomationOccurrenceListSchema,
  AutomationRuleCreateInputSchema,
  AutomationRuleListSchema,
  AutomationRuleListQuerySchema,
  AutomationRuleSchema,
  AutomationRuleUpdateInputSchema,
  AutomationSuccessSchema,
  AutomationWebhookEndpointCreateInputSchema,
  AutomationWebhookEndpointCreateResultSchema,
  AutomationWebhookEndpointListSchema,
  ReplaceWorkspaceResourceGrantsInputSchema,
  WorkspaceResourceGrantListViewSchema,
  WorkspaceResourceGrantTargetSchema,
} from "@synapse/shared/schemas"
import { z } from "zod"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { appRoute, wireRoute } from "../../infrastructure/http/route.js"
import { requireRequestAction } from "../access/guards.js"
import {
  archiveAutomationEventSource,
  createAutomationEventSource,
  createAutomationRule,
  createAutomationWebhookEndpoint,
  deleteAutomationRule,
  getAutomationEventSource,
  getAutomationRule,
  ingestAutomationEvent,
  ingestIntegrationAutomationWebhookEvent,
  ingestAutomationWebhookEvent,
  listAutomationOccurrences,
  listAutomationEventSources,
  listAutomationEventSourceAccessState,
  listAutomationExecutions,
  listAutomationRules,
  listAutomationWebhookEndpoints,
  updateAutomationEventSource,
  updateAutomationRule,
} from "./service.js"
import {
  presentExecutionWithOccurrence,
  presentWebhookEndpoint,
} from "./presenter.js"
import { replaceWorkspaceResourceGrants } from "../workspace-resources/service.js"
import { presentGrant } from "../workspace-resources/presenter.js"
import { enqueueAutomationExecutionJobs } from "../../workers/queues.js"

// App-facing request bodies / queries live in @synapse/shared (§5.1.1) so the
// API parser and the web/mobile clients share one definition.
const sharedEventSourceListQuerySchema = AutomationEventSourceListQuerySchema
const sharedEventSourceCreateInputSchema =
  AutomationEventSourceCreateInputSchema
const sharedEventSourceUpdateInputSchema =
  AutomationEventSourceUpdateInputSchema
const sharedEventIngestInputSchema = AutomationEventIngestInputSchema
const sharedAutomationListQuerySchema = AutomationRuleListQuerySchema
const sharedAutomationCreateInputSchema = AutomationRuleCreateInputSchema
const sharedAutomationUpdateInputSchema = AutomationRuleUpdateInputSchema
const sharedWebhookEndpointCreateInputSchema =
  AutomationWebhookEndpointCreateInputSchema

// §4.1: the unified PUT-replace access API speaks the workspace-resources grant
// target shape (mirrors workspace-resources/controller.ts toCapabilityAccessTarget).
function grantTargetToCapabilityAccessTarget(
  input: z.infer<typeof WorkspaceResourceGrantTargetSchema>
): CapabilityAccessTarget {
  const subject =
    input.subject.kind === SUBJECT_KIND.WORKSPACE
      ? workspaceRef(input.subject.workspaceId)
      : input.subject.kind === SUBJECT_KIND.WORKSPACE_MEMBER
        ? workspaceMemberRef(input.subject.memberId)
        : input.subject.kind === SUBJECT_KIND.CONVERSATION
          ? conversationRef(input.subject.conversationId)
          : input.subject.kind === SUBJECT_KIND.ACTOR
            ? actorRef(input.subject.actorId)
            : remoteAgentRef(input.subject.remoteAgentId)
  const scope = input.scope
    ? conversationRef(input.scope.conversationId)
    : undefined
  return scope ? { subject, scope } : { subject }
}

const webhookIngressSchema = z.looseObject({
  payload: z.record(z.string(), z.unknown()).optional(),
  sourceSnapshot: z.record(z.string(), z.unknown()).optional(),
  dedupeKey: z.string().trim().min(1).max(255).optional(),
  occurredAt: IsoInstantStringSchema.optional(),
})

function extractWebhookSecret(headers: Record<string, unknown>) {
  const direct =
    typeof headers["x-synapse-automation-secret"] === "string"
      ? headers["x-synapse-automation-secret"]
      : typeof headers["x-synapse-webhook-secret"] === "string"
        ? headers["x-synapse-webhook-secret"]
        : ""
  if (direct) return direct

  const authorization =
    typeof headers.authorization === "string"
      ? headers.authorization.trim()
      : ""
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim()
  }
  return ""
}

async function enqueueAutomationExecutions(executionIds: string[]) {
  await enqueueAutomationExecutionJobs(executionIds)
}

export default async function automationController(app: FastifyInstance) {
  const protectedPreHandler = [authMiddleware, workspaceMiddleware]

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/automation-event-sources",
    {
      schema: AutomationEventSourceListSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.view",
        workspaceId,
        "Not allowed to view automation event sources in this workspace"
      )
      if (!allowed) return

      const query = sharedEventSourceListQuerySchema.parse(request.query || {})
      return listAutomationEventSources(workspaceId, {
        status: query.status,
        providerKind: query.providerKind,
        providerRef: query.providerRef,
        sourceKey: query.sourceKey,
      })
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/automation-event-sources",
    {
      schema: AutomationEventSourceSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.manage_devices",
        workspaceId,
        "Not allowed to manage automation event sources"
      )
      if (!allowed) return

      const body = sharedEventSourceCreateInputSchema.parse(request.body)
      const workspaceMemberId = (request as any).workspaceMember!.id as string
      const source = await createAutomationEventSource(
        workspaceId,
        { kind: "workspace_member", workspaceMemberId },
        body
      )
      reply.status(201)
      return source
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/automation-event-sources/:eventSourceId",
    {
      schema: AutomationEventSourceSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId, eventSourceId } = request.params as {
        workspaceId: string
        eventSourceId: string
      }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.view",
        workspaceId,
        "Not allowed to view this automation event source"
      )
      if (!allowed) return

      const source = await getAutomationEventSource(workspaceId, eventSourceId)
      if (!source) {
        reply.status(404).send({ error: "Automation event source not found" })
        return
      }
      return source
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/automation-event-sources/:eventSourceId/access",
    {
      schema: AutomationEventSourceAccessStateSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId, eventSourceId } = request.params as {
        workspaceId: string
        eventSourceId: string
      }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.manage_devices",
        workspaceId,
        "Not allowed to manage automation event source access"
      )
      if (!allowed) return

      return listAutomationEventSourceAccessState(workspaceId, eventSourceId)
    }
  )

  // §4.1: automation event-source access is now a `use`-permission grant set on
  // the source's workspace_resources root. The write API is a single atomic
  // PUT-replace mirroring `PUT /workspace-resources/:appId/grants`; the unified
  // `replaceWorkspaceResourceGrants` performs the manage gate (kind-admin / owner /
  // workspace-admin) and atomic revoke-then-reinsert.
  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/automation-event-sources/:eventSourceId/access",
    {
      schema: WorkspaceResourceGrantListViewSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId, eventSourceId } = request.params as {
        workspaceId: string
        eventSourceId: string
      }
      try {
        const body = ReplaceWorkspaceResourceGrantsInputSchema.parse(
          request.body || {}
        )
        const grants = await replaceWorkspaceResourceGrants({
          workspaceId,
          resourceId: eventSourceId,
          userId: (request as any).user.userId,
          grants: body.grants.map((grant) => ({
            target: grantTargetToCapabilityAccessTarget(grant.target),
            permissions:
              grant.permissions as WorkspaceResourceGrantPermission[],
            conversationTypeMaskOverride:
              grant.conversationTypeMaskOverride ?? null,
            reason: grant.reason,
          })),
        })
        return { grants: grants.map(presentGrant) }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Internal server error"
        if (/not found/i.test(message)) {
          reply.status(404).send({ error: message })
          return
        }
        if (/not allowed|permission|forbidden/i.test(message)) {
          reply.status(403).send({ error: message })
          return
        }
        if (/required|must be|invalid/i.test(message)) {
          reply.status(400).send({ error: message })
          return
        }
        reply.status(500).send({ error: message })
        return
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/automation-event-sources/:eventSourceId/occurrences",
    {
      schema: AutomationOccurrenceListSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId, eventSourceId } = request.params as {
        workspaceId: string
        eventSourceId: string
      }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.view",
        workspaceId,
        "Not allowed to view automation event source history"
      )
      if (!allowed) return

      return listAutomationOccurrences(workspaceId, {
        eventSourceId,
      })
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/automation-event-sources/:eventSourceId",
    {
      schema: AutomationEventSourceSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId, eventSourceId } = request.params as {
        workspaceId: string
        eventSourceId: string
      }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.manage_devices",
        workspaceId,
        "Not allowed to update this automation event source"
      )
      if (!allowed) return

      const body = sharedEventSourceUpdateInputSchema.parse(request.body)
      const workspaceMemberId = (request as any).workspaceMember!.id as string
      return updateAutomationEventSource(
        workspaceId,
        eventSourceId,
        { workspaceMemberId },
        body
      )
    }
  )

  appRoute(
    app,
    "DELETE",
    "/api/v1/workspaces/:workspaceId/automation-event-sources/:eventSourceId",
    {
      schema: AutomationSuccessSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId, eventSourceId } = request.params as {
        workspaceId: string
        eventSourceId: string
      }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.manage_devices",
        workspaceId,
        "Not allowed to archive this automation event source"
      )
      if (!allowed) return

      const workspaceMemberId = (request as any).workspaceMember!.id as string
      await archiveAutomationEventSource(workspaceId, eventSourceId, {
        workspaceMemberId,
      })
      return { success: true }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/automation-event-sources/:eventSourceId/events",
    {
      schema: AutomationEventIngestResultSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId, eventSourceId } = request.params as {
        workspaceId: string
        eventSourceId: string
      }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.manage_devices",
        workspaceId,
        "Not allowed to trigger this automation event source"
      )
      if (!allowed) return

      const body = sharedEventIngestInputSchema.parse(request.body)
      const result = await ingestAutomationEvent({
        workspaceId,
        eventSourceId,
        payload: body.payload,
        sourceSnapshot: body.sourceSnapshot,
        dedupeKey: body.dedupeKey,
        occurredAt: body.occurredAt,
      })
      await enqueueAutomationExecutions(
        result.executions.map((execution) => execution.id)
      )
      const value = {
        occurrence: result.occurrence,
        executions: result.executions,
      }
      reply.status(202)
      return value
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/automations",
    {
      schema: AutomationRuleListSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.view",
        workspaceId,
        "Not allowed to view automations in this workspace"
      )
      if (!allowed) return

      const query = sharedAutomationListQuerySchema.parse(request.query || {})
      return listAutomationRules(workspaceId, {
        status: query.status,
        category: query.category,
        conversationId: query.conversationId,
      })
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/automations",
    {
      schema: AutomationRuleSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.manage_conversations",
        workspaceId,
        "Not allowed to manage automations in this workspace"
      )
      if (!allowed) return

      const body = sharedAutomationCreateInputSchema.parse(request.body)
      const issues = validateAutomationRuleCreatePayload(body)
      if (issues.length > 0) {
        reply.status(400).send({
          error: issues[0]!.message,
          issues,
        })
        return
      }
      const workspaceMemberId = (request as any).workspaceMember!.id as string
      try {
        const automation = await createAutomationRule(
          workspaceId,
          { kind: "workspace_member", workspaceMemberId },
          body
        )
        reply.status(201)
        return automation
      } catch (error) {
        if (
          error instanceof Error &&
          (error as Error & { statusCode?: number }).statusCode === 400
        ) {
          reply.status(400).send({
            error: error.message,
            issues: (error as Error & { issues?: unknown }).issues || [],
          })
          return
        }
        throw error
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/automations/:automationId",
    {
      schema: AutomationRuleSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId, automationId } = request.params as {
        workspaceId: string
        automationId: string
      }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.view",
        workspaceId,
        "Not allowed to view this automation"
      )
      if (!allowed) return

      const automation = await getAutomationRule(workspaceId, automationId)
      if (!automation) {
        reply.status(404).send({ error: "Automation not found" })
        return
      }
      return automation
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/automations/:automationId",
    {
      schema: AutomationRuleSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId, automationId } = request.params as {
        workspaceId: string
        automationId: string
      }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.manage_conversations",
        workspaceId,
        "Not allowed to update this automation"
      )
      if (!allowed) return

      const body = sharedAutomationUpdateInputSchema.parse(request.body)
      const workspaceMemberId = (request as any).workspaceMember!.id as string
      try {
        const automation = await updateAutomationRule(
          workspaceId,
          automationId,
          { workspaceMemberId },
          body
        )
        return automation
      } catch (error) {
        if (
          error instanceof Error &&
          (error as Error & { statusCode?: number }).statusCode === 400
        ) {
          reply.status(400).send({
            error: error.message,
            issues: (error as Error & { issues?: unknown }).issues || [],
          })
          return
        }
        throw error
      }
    }
  )

  appRoute(
    app,
    "DELETE",
    "/api/v1/workspaces/:workspaceId/automations/:automationId",
    {
      schema: AutomationSuccessSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId, automationId } = request.params as {
        workspaceId: string
        automationId: string
      }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.manage_conversations",
        workspaceId,
        "Not allowed to delete this automation"
      )
      if (!allowed) return

      const workspaceMemberId = (request as any).workspaceMember!.id as string
      await deleteAutomationRule(workspaceId, automationId, {
        workspaceMemberId,
      })
      return { success: true }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/automations/:automationId/executions",
    {
      schema: AutomationExecutionListSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId, automationId } = request.params as {
        workspaceId: string
        automationId: string
      }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.view",
        workspaceId,
        "Not allowed to view automation executions"
      )
      if (!allowed) return

      const executions = await listAutomationExecutions(
        workspaceId,
        automationId
      )
      return executions.map(presentExecutionWithOccurrence)
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/automation-webhooks",
    {
      schema: AutomationWebhookEndpointListSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.manage_devices",
        workspaceId,
        "Not allowed to view automation webhooks"
      )
      if (!allowed) return

      const endpoints = await listAutomationWebhookEndpoints(workspaceId)
      return endpoints.map(presentWebhookEndpoint)
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/automation-webhooks",
    {
      schema: AutomationWebhookEndpointCreateResultSchema,
      options: { preHandler: protectedPreHandler },
    },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const allowed = await requireRequestAction(
        request as any,
        reply as any,
        "workspace.manage_devices",
        workspaceId,
        "Not allowed to manage automation webhooks"
      )
      if (!allowed) return

      const body = sharedWebhookEndpointCreateInputSchema.parse(request.body)
      const workspaceMemberId = (request as any).workspaceMember!.id as string
      const created = await createAutomationWebhookEndpoint(
        workspaceId,
        workspaceMemberId,
        body
      )
      reply.status(201)
      return created
    }
  )

  wireRoute(
    app,
    "POST",
    "/api/v1/automation-webhooks/:pathToken/sources/:sourceKey/events",
    {},
    async (request, reply) => {
      const { pathToken, sourceKey } = request.params as {
        pathToken: string
        sourceKey: string
      }
      const incomingBody =
        request.body &&
        typeof request.body === "object" &&
        !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {}
      const isEnvelope =
        "payload" in incomingBody ||
        "sourceSnapshot" in incomingBody ||
        "dedupeKey" in incomingBody ||
        "occurredAt" in incomingBody
      const body = webhookIngressSchema.parse(isEnvelope ? incomingBody : {})
      const secret =
        extractWebhookSecret(request.headers as Record<string, unknown>) ||
        undefined

      const result = await ingestAutomationWebhookEvent({
        pathToken,
        sourceKey,
        secret,
        headers: request.headers as Record<string, unknown>,
        rawBody: (request as any).rawBody as string | undefined,
        payload: isEnvelope ? body.payload : incomingBody,
        sourceSnapshot: isEnvelope ? body.sourceSnapshot : undefined,
        dedupeKey: isEnvelope ? body.dedupeKey : undefined,
        occurredAt: isEnvelope ? body.occurredAt : undefined,
      })
      if ((result as { ignored?: boolean }).ignored) {
        return reply.status(202).send({
          ignored: true,
          occurrence: null,
          executions: [],
        })
      }
      await enqueueAutomationExecutions(
        result.executions.map((execution) => execution.id)
      )
      return reply.status(202).send({
        occurrence: result.occurrence,
        executions: result.executions,
      })
    }
  )

  wireRoute(
    app,
    "POST",
    "/api/v1/automation-webhooks/:pathToken/events",
    {},
    async (request, reply) => {
      const { pathToken } = request.params as { pathToken: string }
      const payload =
        request.body &&
        typeof request.body === "object" &&
        !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {}

      const result = await ingestIntegrationAutomationWebhookEvent({
        pathToken,
        headers: request.headers as Record<string, unknown>,
        rawBody: (request as any).rawBody as string | undefined,
        payload,
      })
      if (result.ignored) {
        return reply.status(202).send({
          ignored: true,
          occurrences: [],
          executions: [],
        })
      }

      await enqueueAutomationExecutionJobs(
        result.executions.map((execution) => execution.id)
      )
      return reply.status(202).send({
        occurrences: result.occurrences,
        executions: result.executions,
      })
    }
  )
}
