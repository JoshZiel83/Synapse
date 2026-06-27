import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { CONTACT_HUB_KINDS } from "@synapse/shared"
import {
  ContactHubDetailResponseSchema,
  ContactHubResponseSchema,
  DirectConversationOpenResponseSchema,
  FriendsListResponseSchema,
  IdentitySearchResponseSchema,
  RelationshipProfileViewSchema,
  RelationshipScanResponseSchema,
  FriendRequestListResponseSchema,
  ActorAccessRequestListResponseSchema,
  RemoteAgentAccessRequestListResponseSchema,
  ResolveRequestResponseSchema,
  RelationshipScanInputSchema,
  OpenDirectConversationInputSchema,
  UpdateMemberRelationshipProfileInputSchema,
  UpdateActorRelationshipProfileInputSchema,
  IdentitySearchQuerySchema,
  RequestRelationshipBySearchInputSchema,
} from "@synapse/shared/schemas"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { appRoute } from "../../infrastructure/http/route.js"
import { requireRequestAction } from "../access/guards.js"
import {
  presentActorAccessRequest,
  presentContactHub,
  presentContactHubDetail,
  presentDirectConversationOpen,
  presentFriendRequest,
  presentRelationshipProfile,
  presentRemoteAgentAccessRequest,
  presentResolvedRelationshipRequest,
} from "./presenter.js"
import {
  getActorRelationshipProfile,
  getContactHub,
  getContactHubDetail,
  getMemberRelationshipProfile,
  getRemoteAgentRelationshipProfile,
  listActorAccessRequests,
  listFriendRequests,
  listFriends,
  listRemoteAgentAccessRequests,
  openDirectConversation,
  requestRelationshipByIdentityProfile,
  resolveActorAccessRequest,
  resolveFriendRequest,
  resolveRemoteAgentAccessRequest,
  scanRelationshipQr,
  searchRelationshipsByIdentity,
  updateActorRelationshipProfile,
  updateMemberRelationshipProfile,
  updateRemoteAgentRelationshipProfile,
} from "./service.js"

// App-facing request bodies / queries live in @synapse/shared (§5.1.1) so the
// API parser and the web/mobile clients share one definition.
const scanSchema = RelationshipScanInputSchema
const openDirectSchema = OpenDirectConversationInputSchema
const updateMemberProfileSchema = UpdateMemberRelationshipProfileInputSchema
const identitySearchQuerySchema = IdentitySearchQuerySchema
const requestRelationshipBySearchSchema = RequestRelationshipBySearchInputSchema
const updateActorProfileSchema = UpdateActorRelationshipProfileInputSchema
// Path-param (:kind) validation — not a body DTO, stays local.
const contactKindSchema = z.enum(CONTACT_HUB_KINDS)

function sendServiceError(reply: FastifyReply, error: unknown) {
  const message =
    error instanceof Error && error.message ? error.message : "Request failed"
  if (/not found/i.test(message)) {
    return reply.status(404).send({ error: message })
  }
  if (/not allowed|forbidden/i.test(message)) {
    return reply.status(403).send({ error: message })
  }
  return reply.status(400).send({ error: message })
}

export default async function relationshipController(app: FastifyInstance) {
  app.addHook("onRequest", authMiddleware)
  app.addHook("onRequest", workspaceMiddleware)

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/me/relationship-profile",
    { schema: RelationshipProfileViewSchema },
    async (request) => {
      const params = request.params as { workspaceId: string }
      const userId = (request as any).user!.userId
      return presentRelationshipProfile(
        await getMemberRelationshipProfile({
          workspaceId: params.workspaceId,
          userId,
        })
      )
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/me/relationship-profile",
    { schema: RelationshipProfileViewSchema },
    async (request) => {
      const params = request.params as { workspaceId: string }
      const userId = (request as any).user!.userId
      const body = updateMemberProfileSchema.parse(request.body)
      return presentRelationshipProfile(
        await updateMemberRelationshipProfile({
          workspaceId: params.workspaceId,
          userId,
          approvalMode: body.approvalMode,
          identityId: body.identityId,
          identitySearchEnabled: body.identitySearchEnabled,
        })
      )
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/actors/:actorId/relationship-profile",
    { schema: RelationshipProfileViewSchema },
    async (request, reply) => {
      const params = request.params as { workspaceId: string; actorId: string }
      const allowed = await requireRequestAction(
        request,
        reply,
        "actor.grant",
        params.actorId,
        "Not allowed to manage this actor relationship profile"
      )
      if (!allowed) return
      const userId = (request as any).user!.userId
      try {
        return presentRelationshipProfile(
          await getActorRelationshipProfile({
            workspaceId: params.workspaceId,
            actorId: params.actorId,
            userId,
          })
        )
      } catch (error) {
        sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/actors/:actorId/relationship-profile",
    { schema: RelationshipProfileViewSchema },
    async (request, reply) => {
      const params = request.params as { workspaceId: string; actorId: string }
      const allowed = await requireRequestAction(
        request,
        reply,
        "actor.grant",
        params.actorId,
        "Not allowed to manage this actor relationship profile"
      )
      if (!allowed) return
      const userId = (request as any).user!.userId
      const body = updateActorProfileSchema.parse(request.body)
      try {
        return presentRelationshipProfile(
          await updateActorRelationshipProfile({
            workspaceId: params.workspaceId,
            actorId: params.actorId,
            userId,
            approvalMode: body.approvalMode,
            identityId: body.identityId,
            identitySearchEnabled: body.identitySearchEnabled,
            isPublicShared: body.isPublicShared,
          })
        )
      } catch (error) {
        sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/remote-agents/:remoteAgentId/relationship-profile",
    { schema: RelationshipProfileViewSchema },
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string
        remoteAgentId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "remote_agent.grant",
        params.remoteAgentId,
        "Not allowed to manage this remote agent relationship profile"
      )
      if (!allowed) return
      const userId = (request as any).user!.userId
      try {
        return presentRelationshipProfile(
          await getRemoteAgentRelationshipProfile({
            workspaceId: params.workspaceId,
            remoteAgentId: params.remoteAgentId,
            userId,
          })
        )
      } catch (error) {
        sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/remote-agents/:remoteAgentId/relationship-profile",
    { schema: RelationshipProfileViewSchema },
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string
        remoteAgentId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "remote_agent.grant",
        params.remoteAgentId,
        "Not allowed to manage this remote agent relationship profile"
      )
      if (!allowed) return
      const userId = (request as any).user!.userId
      const body = updateActorProfileSchema.parse(request.body)
      try {
        return presentRelationshipProfile(
          await updateRemoteAgentRelationshipProfile({
            workspaceId: params.workspaceId,
            remoteAgentId: params.remoteAgentId,
            userId,
            approvalMode: body.approvalMode,
            identityId: body.identityId,
            identitySearchEnabled: body.identitySearchEnabled,
            isPublicShared: body.isPublicShared,
          })
        )
      } catch (error) {
        sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/relationship-qr/scan",
    { schema: RelationshipScanResponseSchema },
    async (request, reply) => {
      const params = request.params as { workspaceId: string }
      const userId = (request as any).user!.userId
      const body = scanSchema.parse(request.body)
      try {
        return await scanRelationshipQr({
          workspaceId: params.workspaceId,
          userId,
          token: body.token,
        })
      } catch (error) {
        sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/identity-search",
    { schema: IdentitySearchResponseSchema },
    async (request) => {
      const params = request.params as { workspaceId: string }
      const userId = (request as any).user!.userId
      const query = identitySearchQuerySchema.parse(request.query)
      return searchRelationshipsByIdentity({
        workspaceId: params.workspaceId,
        userId,
        query: query.q || "",
      })
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/identity-search/request",
    { schema: RelationshipScanResponseSchema },
    async (request, reply) => {
      const params = request.params as { workspaceId: string }
      const userId = (request as any).user!.userId
      const body = requestRelationshipBySearchSchema.parse(request.body)
      try {
        return await requestRelationshipByIdentityProfile({
          workspaceId: params.workspaceId,
          userId,
          profileId: body.profileId,
        })
      } catch (error) {
        sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/friends",
    { schema: FriendsListResponseSchema },
    async (request) => {
      const params = request.params as { workspaceId: string }
      const userId = (request as any).user!.userId
      return listFriends({
        workspaceId: params.workspaceId,
        userId,
      })
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/friend-requests",
    { schema: FriendRequestListResponseSchema },
    async (request) => {
      const params = request.params as { workspaceId: string }
      const userId = (request as any).user!.userId
      const requests = await listFriendRequests({
        workspaceId: params.workspaceId,
        userId,
      })
      return {
        incoming: requests.incoming.map(presentFriendRequest),
        outgoing: requests.outgoing.map(presentFriendRequest),
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/friend-requests/:requestId/approve",
    { schema: ResolveRequestResponseSchema },
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string
        requestId: string
      }
      const userId = (request as any).user!.userId
      try {
        return presentResolvedRelationshipRequest(
          await resolveFriendRequest({
            workspaceId: params.workspaceId,
            userId,
            requestId: params.requestId,
            decision: "approve",
          })
        )
      } catch (error) {
        sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/friend-requests/:requestId/reject",
    { schema: ResolveRequestResponseSchema },
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string
        requestId: string
      }
      const userId = (request as any).user!.userId
      try {
        return presentResolvedRelationshipRequest(
          await resolveFriendRequest({
            workspaceId: params.workspaceId,
            userId,
            requestId: params.requestId,
            decision: "reject",
          })
        )
      } catch (error) {
        sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/actor-access-requests",
    { schema: ActorAccessRequestListResponseSchema },
    async (request) => {
      const params = request.params as { workspaceId: string }
      const userId = (request as any).user!.userId
      const requests = await listActorAccessRequests({
        workspaceId: params.workspaceId,
        userId,
      })
      return {
        incoming: requests.incoming.map(presentActorAccessRequest),
        outgoing: requests.outgoing.map(presentActorAccessRequest),
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/remote-agent-access-requests",
    { schema: RemoteAgentAccessRequestListResponseSchema },
    async (request) => {
      const params = request.params as { workspaceId: string }
      const userId = (request as any).user!.userId
      const requests = await listRemoteAgentAccessRequests({
        workspaceId: params.workspaceId,
        userId,
      })
      return {
        incoming: requests.incoming.map(presentRemoteAgentAccessRequest),
        outgoing: requests.outgoing.map(presentRemoteAgentAccessRequest),
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/actor-access-requests/:requestId/approve",
    { schema: ResolveRequestResponseSchema },
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string
        requestId: string
      }
      const userId = (request as any).user!.userId
      try {
        return presentResolvedRelationshipRequest(
          await resolveActorAccessRequest({
            workspaceId: params.workspaceId,
            userId,
            requestId: params.requestId,
            decision: "approve",
          })
        )
      } catch (error) {
        sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/actor-access-requests/:requestId/reject",
    { schema: ResolveRequestResponseSchema },
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string
        requestId: string
      }
      const userId = (request as any).user!.userId
      try {
        return presentResolvedRelationshipRequest(
          await resolveActorAccessRequest({
            workspaceId: params.workspaceId,
            userId,
            requestId: params.requestId,
            decision: "reject",
          })
        )
      } catch (error) {
        sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/remote-agent-access-requests/:requestId/approve",
    { schema: ResolveRequestResponseSchema },
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string
        requestId: string
      }
      const userId = (request as any).user!.userId
      try {
        return presentResolvedRelationshipRequest(
          await resolveRemoteAgentAccessRequest({
            workspaceId: params.workspaceId,
            userId,
            requestId: params.requestId,
            decision: "approve",
          })
        )
      } catch (error) {
        sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/remote-agent-access-requests/:requestId/reject",
    { schema: ResolveRequestResponseSchema },
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string
        requestId: string
      }
      const userId = (request as any).user!.userId
      try {
        return presentResolvedRelationshipRequest(
          await resolveRemoteAgentAccessRequest({
            workspaceId: params.workspaceId,
            userId,
            requestId: params.requestId,
            decision: "reject",
          })
        )
      } catch (error) {
        sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/contact-hub",
    { schema: ContactHubResponseSchema },
    async (request) => {
      const params = request.params as { workspaceId: string }
      const userId = (request as any).user!.userId
      return presentContactHub(
        await getContactHub({
          workspaceId: params.workspaceId,
          userId,
        })
      )
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/contact-hub/:kind/:contactId",
    { schema: ContactHubDetailResponseSchema },
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string
        kind: string
        contactId: string
      }
      const userId = (request as any).user!.userId
      const kind = contactKindSchema.parse(params.kind)
      try {
        return presentContactHubDetail(
          await getContactHubDetail({
            workspaceId: params.workspaceId,
            userId,
            contactKind: kind,
            contactId: params.contactId,
          })
        )
      } catch (error) {
        sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/chat/direct-conversations/open",
    { schema: DirectConversationOpenResponseSchema },
    async (request, reply) => {
      const params = request.params as { workspaceId: string }
      const userId = (request as any).user!.userId
      const body = openDirectSchema.parse(request.body)
      try {
        return presentDirectConversationOpen(
          await openDirectConversation({
            workspaceId: params.workspaceId,
            userId,
            contactKind: body.contactKind,
            contactId: body.contactId,
          })
        )
      } catch (error) {
        sendServiceError(reply, error)
      }
    }
  )
}
