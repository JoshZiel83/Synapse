import { FILE_ORIGIN_SYSTEMS } from "@synapse/shared/constants"
import type {
  DeviceCapabilitySummaryView,
  DeviceDetailView,
  DevicePairingTicketView,
  DeviceServiceSummaryView,
  DeviceSummaryView,
} from "./device-views"
import type {
  ActorPackageInstallResult,
  ActorRuntimeTurnActivityDetail,
  CapabilityAccessTarget,
  AttachmentTarget,
  AuthResponse,
  ActorPackageRecord,
  AutomationEventSource,
  AutomationExecution,
  AutomationOccurrence,
  AutomationRule,
  AutomationRuleCreatePayload,
  AutomationRuleUpdatePayload,
  CanonicalContentBlock,
  ChatBootstrapResponse,
  ChatClientInstanceCreateInput,
  ChatClientInstanceRegistrationResponse,
  ChatClientInstanceTouchInput,
  ChatConversationCreateInput,
  ChatConversationCreateResponse,
  ChatConversationMessagesPage,
  ChatConversationMessagesQuery,
  ChatConversationReadWatermarkInput,
  ChatConversationReadWatermarkResponse,
  ChatConversationSendMessageInput,
  ChatConversationSendMessageResponse,
  ChatTaskResolveInput,
  ChatTaskResolveResponse,
  ChatSyncResponse,
  CurrentUserWeixinBindingSummary,
  InstalledSkill,
  TaskSummary,
  ContactHubDetailResponse,
  ContactHubEntryView,
  ContactHubKind,
  ContactHubResponse,
  ContactTargetType,
  DirectConversationOpenResponse,
  IdentitySearchMatchView,
  IdentitySearchResponse,
  RelationshipProfileView,
  RelationshipScanResponse,
  RemoteAgentAccessPolicy,
  RemoteAgentAccessRequestListResponse,
  RemoteAgentBindingView,
  RemoteAgentGroupTaskGrantView,
  RemoteAgentLifecycleState,
  RemoteAgentMachineDetailView,
  RemoteAgentMachinePairingSessionView,
  RemoteAgentMachineTrustStatus,
  RemoteAgentMachineView,
  RemoteAgentRuntimeCapabilityView,
  RemoteAgentRuntimeCatalogEntryView,
  RemoteAgentRuntimeCatalogStatus,
  RemoteAgentRuntimeKind,
  RemoteAgentRuntimeSummaryView,
  RemoteAgentView,
  ActorAccessRequestListResponse,
  FriendRequestListResponse,
  TransportAccountSummary,
  TransportConnectorCapability,
  TransportExternalUserSummary,
  TransportSessionSummary,
  WeixinQrLoginSessionSummary,
  DingtalkDeviceFlowStartResponse,
  DingtalkDeviceFlowPollResponse,
  WorkspaceChiefActorPreference,
  SkillMarketplaceEntry,
  WorkspaceCapabilityConversationTypePoliciesView,
} from "@synapse/shared"
import {
  normalizeConversationCatalogEntry,
  type ConversationCatalogEntry,
} from "@synapse/shared"
import {
  isChatTaskResolveConflictResponse,
  type ChatTaskResolvePayload,
  type FileRecordView,
} from "@synapse/shared/types"

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api/v1"

export type {
  ActorAccessRequestListResponse,
  ChatTaskResolveInput,
  ChatTaskResolvePayload,
  ChatTaskResolveResponse,
  ContactHubDetailResponse,
  ContactHubEntryView,
  ContactHubResponse,
  ContactTargetType,
  DirectConversationOpenResponse,
  FriendRequestListResponse,
  IdentitySearchMatchView,
  IdentitySearchResponse,
  RelationshipProfileView,
  RelationshipScanResponse,
  RemoteAgentAccessPolicy,
  RemoteAgentAccessRequestListResponse,
  RemoteAgentBindingView,
  RemoteAgentGroupTaskGrantView,
  RemoteAgentLifecycleState,
  RemoteAgentMachineDetailView,
  RemoteAgentMachinePairingSessionView,
  RemoteAgentMachineTrustStatus,
  RemoteAgentMachineView,
  RemoteAgentRuntimeCapabilityView,
  RemoteAgentRuntimeCatalogEntryView,
  RemoteAgentRuntimeKind,
  RemoteAgentRuntimeSummaryView,
  RemoteAgentView,
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export interface AuthMutationOptions {
  /**
   * Maps to Better Auth's `rememberMe`. A "temporary" login (rememberMe:false)
   * yields a session-scoped cookie. Defaults to a persistent login.
   */
  temporary?: boolean
}

export interface WorkspaceListResponse {
  data: Array<{
    id: string
    name: string
    slug: string
    isTrusted?: boolean
    currentWorkspaceMemberId?: string
    trustLevel?: string
  }>
}

export type ContactHubEntryKind = ContactHubKind
export type RemoteAgentRuntimeStatus = RemoteAgentRuntimeCatalogStatus

class ApiClient {
  private async fetch(path: string, options: RequestInit = {}) {
    const body = options.body
    const isFormData =
      typeof FormData !== "undefined" && body instanceof FormData
    const headers = new Headers(options.headers as HeadersInit | undefined)
    if (!isFormData && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json")
    }

    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: "include",
    })

    if (res.status === 204) return null

    const data = await res.json().catch(() => null)
    if (!res.ok) {
      // Prefer structured error fields in priority order. Endpoints that
      // return `{message, code, details, allowed, ...}` (e.g. devices /
      // runtime-authorization endpoints) used to be flattened to a
      // generic "API error" because only `data.error` was checked.
      const candidate =
        (data && typeof data.message === "string" && data.message) ||
        (data && typeof data.error === "string" && data.error) ||
        (data &&
          typeof data.error === "object" &&
          data.error &&
          typeof data.error.message === "string" &&
          data.error.message) ||
        `API error (HTTP ${res.status})`
      const code =
        (data && typeof data.code === "string" && data.code) ||
        (data &&
          typeof data.error === "object" &&
          data.error &&
          typeof data.error.code === "string" &&
          data.error.code) ||
        undefined
      throw new ApiError(candidate, res.status, code, data)
    }

    return data
  }

  // Auth — Better Auth native endpoints (mounted under /api/v1/auth).
  // On the web the session is delivered as an httpOnly cookie; the response
  // body carries the user. We normalize to { user } so the auth store keeps a
  // stable shape.
  async register(
    email: string,
    password: string,
    name: string,
    _options: AuthMutationOptions = {}
  ): Promise<AuthResponse> {
    const res = await this.fetch("/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    })
    return { user: res.user, session: res.session ?? { id: "" } }
  }
  async login(
    email: string,
    password: string,
    options: AuthMutationOptions = {}
  ): Promise<AuthResponse> {
    const res = await this.fetch("/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        rememberMe: options.temporary ? false : true,
      }),
    })
    return { user: res.user, session: res.session ?? { id: "" } }
  }
  logout() {
    return this.fetch("/auth/sign-out", { method: "POST" })
  }
  logoutAll() {
    return this.fetch("/auth/revoke-sessions", { method: "POST" })
  }
  listSessions() {
    return this.fetch("/auth/list-sessions")
  }
  revokeSession(token: string) {
    return this.fetch("/auth/revoke-session", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
  }
  // Cross-device QR login (Better Auth deviceAuthorization plugin). The desktop
  // requests a device code, renders verification_uri_complete as a QR, polls
  // for the token, then exchanges it for the session cookie via the bridge.
  requestDeviceCode(): Promise<{
    device_code: string
    user_code: string
    verification_uri: string
    verification_uri_complete: string
    expires_in: number
    interval: number
  }> {
    return this.fetch("/auth/device/code", {
      method: "POST",
      body: JSON.stringify({ client_id: "synapse-web" }),
    })
  }
  async pollDeviceToken(
    deviceCode: string
  ): Promise<{ access_token?: string; error?: string }> {
    // RFC 8628: the device token endpoint returns HTTP 400 with an OAuth error
    // body for the normal-flow states (authorization_pending / slow_down) as
    // well as terminal ones (access_denied / expired_token / invalid_grant).
    // Our fetch wrapper throws on any non-2xx, so unwrap ONLY those known
    // 400-status device errors and surface them as a value. Anything else
    // (500/502, proxy failure, a non-device error) re-throws so the poller
    // shows a real failure instead of masking it as "expired".
    try {
      return await this.fetch("/auth/device/token", {
        method: "POST",
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: "synapse-web",
        }),
      })
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        const details = err.details as { error?: string } | undefined
        const oauthError = details?.error
        const KNOWN_DEVICE_ERRORS = new Set([
          "authorization_pending",
          "slow_down",
          "expired_token",
          "access_denied",
          "invalid_grant",
        ])
        if (oauthError && KNOWN_DEVICE_ERRORS.has(oauthError)) {
          return { error: oauthError }
        }
      }
      throw err
    }
  }
  exchangeDeviceSession(accessToken: string) {
    return this.fetch("/auth/device/session-cookie", {
      method: "POST",
      body: JSON.stringify({ access_token: accessToken }),
    })
  }
  // Start a generic-OAuth (e.g. Feishu) sign-in. Better Auth returns a
  // redirect URL the browser should navigate to (disableRedirect lets us drive
  // the navigation ourselves rather than relying on the client redirect plugin).
  // errorCallbackURL is where Better Auth redirects on failure (?error=...);
  // pass it so popup/redirect flows land on a page we control instead of
  // Better Auth's default ${baseURL}/error (which 404s here).
  async startOAuth(
    providerId: string,
    callbackURL: string,
    opts: { errorCallbackURL?: string } = {}
  ): Promise<{ url: string }> {
    const res = await this.fetch("/auth/sign-in/oauth2", {
      method: "POST",
      body: JSON.stringify({
        providerId,
        callbackURL,
        ...(opts.errorCallbackURL
          ? { errorCallbackURL: opts.errorCallbackURL }
          : {}),
        disableRedirect: true,
      }),
    })
    return { url: res.url }
  }
  getMe() {
    return this.fetch("/auth/me")
  }
  updateMe(data: { name?: string; avatarFileId?: string | null }) {
    return this.fetch("/auth/me", { method: "PUT", body: JSON.stringify(data) })
  }

  // Workspaces
  getWorkspaces(): Promise<WorkspaceListResponse> {
    return this.fetch("/workspaces")
  }
  createWorkspace(name: string, description?: string) {
    return this.fetch("/workspaces", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    })
  }
  getWorkspace(id: string) {
    return this.fetch(`/workspaces/${id}`)
  }
  getWorkspaceMembers(wsId: string) {
    return this.fetch(`/workspaces/${wsId}/members`)
  }
  getWorkspaceNavigation(wsId: string) {
    return this.fetch(`/workspaces/${wsId}/navigation`)
  }
  getWorkspaceChiefActorPreference(
    wsId: string
  ): Promise<WorkspaceChiefActorPreference> {
    return this.fetch(`/workspaces/${wsId}/preferences/chief-actor`)
  }
  updateWorkspaceChiefActorPreference(
    wsId: string,
    data: { chiefActorId: string | null }
  ): Promise<WorkspaceChiefActorPreference> {
    return this.fetch(`/workspaces/${wsId}/preferences/chief-actor`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  getWorkspaceAccess(wsId: string) {
    return this.fetch(`/workspaces/${wsId}/access`)
  }
  getWorkspaceCapabilityConversationTypePolicies(
    wsId: string
  ): Promise<WorkspaceCapabilityConversationTypePoliciesView> {
    return this.fetch(
      `/workspaces/${wsId}/capability-conversation-type-policies`
    )
  }
  updateWorkspaceCapabilityConversationTypePolicies(
    wsId: string,
    data: {
      policies: Partial<
        Record<
          "plugin_installation" | "installed_skill" | "device_capability",
          number
        >
      >
    }
  ): Promise<WorkspaceCapabilityConversationTypePoliciesView> {
    return this.fetch(
      `/workspaces/${wsId}/capability-conversation-type-policies`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
  }
  grantWorkspaceAccess(
    wsId: string,
    data: {
      workspaceMemberId: string
      accessKey:
        | "model_admin"
        | "actor_admin"
        | "skill_admin"
        | "plugin_admin"
        | "memory_admin"
        | "device_admin"
        | "conversation_admin"
    }
  ) {
    return this.fetch(`/workspaces/${wsId}/access`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  revokeWorkspaceAccess(
    wsId: string,
    workspaceMemberId: string,
    accessKey:
      | "model_admin"
      | "actor_admin"
      | "skill_admin"
      | "plugin_admin"
      | "memory_admin"
      | "device_admin"
      | "conversation_admin"
  ) {
    return this.fetch(
      `/workspaces/${wsId}/access/${accessKey}/members/${workspaceMemberId}/revoke`,
      { method: "POST", body: "{}" }
    )
  }

  // Platform Access
  getPlatformNavigation() {
    return this.fetch("/platform/navigation")
  }
  getPlatformAccess() {
    return this.fetch("/platform/access")
  }
  grantPlatformAccess(data: {
    userId: string
    accessKey:
      | "super_admin"
      | "workspace_admin"
      | "model_admin"
      | "support"
      | "auditor"
  }) {
    return this.fetch("/platform/access", {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  revokePlatformAccess(
    userId: string,
    accessKey:
      | "super_admin"
      | "workspace_admin"
      | "model_admin"
      | "support"
      | "auditor"
  ) {
    return this.fetch(`/platform/access/${accessKey}/users/${userId}/revoke`, {
      method: "POST",
      body: "{}",
    })
  }

  // Skills Marketplace
  getSkillMarketplace(options?: {
    search?: string
    tags?: string[]
    workspaceId?: string
  }): Promise<{ skills: SkillMarketplaceEntry[] }> {
    const params = new URLSearchParams()
    if (options?.search) params.set("search", options.search)
    if (options?.tags?.length) params.set("tags", options.tags.join(","))
    if (options?.workspaceId) params.set("workspaceId", options.workspaceId)
    const qs = params.toString()
    return this.fetch(`/skills/marketplace${qs ? "?" + qs : ""}`)
  }
  getSkillMarketplaceItem(
    skillId: string,
    workspaceId?: string
  ): Promise<{ skill: SkillMarketplaceEntry }> {
    const params = new URLSearchParams()
    if (workspaceId) params.set("workspaceId", workspaceId)
    const qs = params.toString()
    return this.fetch(`/skills/marketplace/${skillId}${qs ? "?" + qs : ""}`)
  }
  publishMarketplaceSkill(data: {
    skillId?: string
    slug: string
    name: string
    description?: CanonicalContentBlock
    iconFileId?: string | null
    tags?: string[]
    version: string
    changelog?: string
    defaultConversationTypeMask?: number
    isActive?: boolean
    metadata?: Record<string, unknown>
    attachmentFiles?: Array<{
      path: string
      contentBlocks: CanonicalContentBlock[]
      mediaType?: string
    }>
  }): Promise<{ skill: SkillMarketplaceEntry }> {
    return this.fetch("/skills/marketplace", {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  importMarketplaceSkill(
    data:
      | {
          sourceType: "github"
          repoUrl: string
          path: string
          ref?: string
        }
      | {
          sourceType: "clawhub"
          ownerId?: string
          slug: string
          version?: string
        }
  ): Promise<{ skill: SkillMarketplaceEntry }> {
    return this.fetch("/skills/marketplace/import", {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  refreshMarketplaceSkill(
    skillId: string
  ): Promise<{ skill: SkillMarketplaceEntry }> {
    return this.fetch(`/skills/marketplace/${skillId}/refresh`, {
      method: "POST",
      body: "{}",
    })
  }
  createWorkspaceSkill(
    wsId: string,
    data: {
      name: string
      description?: CanonicalContentBlock
      iconFileId?: string
      tags?: string[]
      attachmentFiles?: Array<{
        path: string
        contentBlocks: CanonicalContentBlock[]
        mediaType?: string
      }>
      accessTarget: CapabilityAccessTarget
    }
  ): Promise<{ skill: InstalledSkill }> {
    return this.fetch(`/workspaces/${wsId}/skills/custom`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }

  // Skills
  getInstalledSkills(
    wsId: string,
    params?: string
  ): Promise<{ skills: InstalledSkill[] }> {
    return this.fetch(`/workspaces/${wsId}/skills${params ? "?" + params : ""}`)
  }
  getInstalledSkill(
    wsId: string,
    installedSkillId: string
  ): Promise<{ skill: InstalledSkill }> {
    return this.fetch(`/workspaces/${wsId}/skills/${installedSkillId}`)
  }
  installSkill(
    wsId: string,
    data: {
      marketSkillId: string
      accessTarget: CapabilityAccessTarget
    }
  ): Promise<{ skill: InstalledSkill }> {
    return this.fetch(`/workspaces/${wsId}/skills`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updateInstalledSkill(
    wsId: string,
    installedSkillId: string,
    data: {
      name?: string
      description?: CanonicalContentBlock
      iconFileId?: string | null
      tags?: string[]
      isEnabled?: boolean
      conversationTypeMaskOverride?: number | null
      attachmentFiles?: Array<{
        path: string
        contentBlocks: CanonicalContentBlock[]
        mediaType?: string
      }>
    }
  ): Promise<{ skill: InstalledSkill }> {
    return this.fetch(`/workspaces/${wsId}/skills/${installedSkillId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  upgradeInstalledSkill(
    wsId: string,
    installedSkillId: string
  ): Promise<{ skill: InstalledSkill }> {
    return this.fetch(
      `/workspaces/${wsId}/skills/${installedSkillId}/upgrade`,
      {
        method: "POST",
        body: "{}",
      }
    )
  }
  uninstallInstalledSkill(wsId: string, installedSkillId: string) {
    return this.fetch(`/workspaces/${wsId}/skills/${installedSkillId}`, {
      method: "DELETE",
    })
  }
  getInstalledSkillAccess(wsId: string, installedSkillId: string) {
    return this.fetch(`/workspaces/${wsId}/skills/${installedSkillId}/access`)
  }
  grantInstalledSkillAccess(
    wsId: string,
    installedSkillId: string,
    data: {
      accessTarget?: CapabilityAccessTarget
      conversationTypeMaskOverride?: number | null
      permissions?: string[]
      reason?: string
    }
  ) {
    return this.fetch(`/workspaces/${wsId}/skills/${installedSkillId}/access`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updateInstalledSkillAccessGrant(
    wsId: string,
    installedSkillId: string,
    grantId: string,
    data: {
      conversationTypeMaskOverride?: number | null
    }
  ) {
    return this.fetch(
      `/workspaces/${wsId}/skills/${installedSkillId}/access/${grantId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
  }
  revokeInstalledSkillAccess(
    wsId: string,
    installedSkillId: string,
    grantId: string
  ) {
    return this.fetch(
      `/workspaces/${wsId}/skills/${installedSkillId}/access/${grantId}`,
      {
        method: "DELETE",
      }
    )
  }

  // Workspace Invites
  getInviteInfo(token: string) {
    return this.fetch(`/invites/${token}`)
  }
  redeemInvite(token: string) {
    return this.fetch(`/invites/${token}/redeem`, {
      method: "POST",
      body: "{}",
    })
  }
  createInvite(
    wsId: string,
    data: { trustLevel?: string; maxUses?: number; expiresAt?: string }
  ) {
    return this.fetch(`/workspaces/${wsId}/invites`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  listInvites(wsId: string) {
    return this.fetch(`/workspaces/${wsId}/invites`)
  }
  revokeInvite(wsId: string, inviteId: string) {
    return this.fetch(`/workspaces/${wsId}/invites/${inviteId}`, {
      method: "DELETE",
    })
  }

  // Actors
  getActors(wsId: string) {
    return this.fetch(`/workspaces/${wsId}/actors`)
  }
  getActor(wsId: string, actorId: string) {
    return this.fetch(`/workspaces/${wsId}/actors/${actorId}`)
  }
  getActorVersions(wsId: string, actorId: string) {
    return this.fetch(`/workspaces/${wsId}/actors/${actorId}/versions`)
  }
  getActorPackages(
    wsId: string,
    search?: string
  ): Promise<ActorPackageRecord[]> {
    const params = search ? `?search=${encodeURIComponent(search)}` : ""
    return this.fetch(`/workspaces/${wsId}/actors/packages${params}`)
  }
  getActorPackage(
    wsId: string,
    packageId: string
  ): Promise<ActorPackageRecord> {
    return this.fetch(`/workspaces/${wsId}/actors/packages/${packageId}`)
  }
  installActorPackage(
    wsId: string,
    packageId: string,
    data?: {
      name?: string
      title?: string
      parentId?: string | null
      syncMode?: "notify" | "manual_merge"
    }
  ): Promise<ActorPackageInstallResult> {
    return this.fetch(
      `/workspaces/${wsId}/actors/packages/${packageId}/install`,
      {
        method: "POST",
        body: JSON.stringify(data || {}),
      }
    )
  }
  getOrgTree(wsId: string) {
    return this.fetch(`/workspaces/${wsId}/actors/tree`)
  }
  createActor(wsId: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/actors`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updateActor(wsId: string, actorId: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/actors/${actorId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }

  // Memories
  getMemories(wsId: string, params?: string) {
    return this.fetch(
      `/workspaces/${wsId}/memories${params ? "?" + params : ""}`
    )
  }
  getMemory(wsId: string, id: string) {
    return this.fetch(`/workspaces/${wsId}/memories/${id}`)
  }
  createMemory(wsId: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/memories`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updateMemory(wsId: string, id: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/memories/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  deleteMemory(wsId: string, id: string) {
    return this.fetch(`/workspaces/${wsId}/memories/${id}`, {
      method: "DELETE",
    })
  }
  moveMemory(wsId: string, id: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/memories/${id}/move`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }

  // Audit
  getAuditLogs(wsId: string, params?: string) {
    return this.fetch(
      `/workspaces/${wsId}/audit-logs${params ? "?" + params : ""}`
    )
  }

  // Model Groups - Workspace
  getModelGroups(wsId: string) {
    return this.fetch(`/workspaces/${wsId}/model-groups`)
  }
  createModelGroup(wsId: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/model-groups`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  getModelGroup(wsId: string, groupId: string) {
    return this.fetch(`/workspaces/${wsId}/model-groups/${groupId}`)
  }
  updateModelGroup(wsId: string, groupId: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/model-groups/${groupId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  deleteModelGroup(wsId: string, groupId: string) {
    return this.fetch(`/workspaces/${wsId}/model-groups/${groupId}`, {
      method: "DELETE",
    })
  }
  getModelGroupGrants(wsId: string, groupId: string) {
    return this.fetch(`/workspaces/${wsId}/model-groups/${groupId}/grants`)
  }
  issueModelGroupGrant(wsId: string, groupId: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/model-groups/${groupId}/grants`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  revokeModelGroupGrant(wsId: string, groupId: string, grantId: string) {
    return this.fetch(
      `/workspaces/${wsId}/model-groups/${groupId}/grants/${grantId}/revoke`,
      { method: "POST", body: "{}" }
    )
  }
  addModelItem(wsId: string, groupId: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/model-groups/${groupId}/items`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updateModelItem(wsId: string, groupId: string, itemId: string, data: any) {
    return this.fetch(
      `/workspaces/${wsId}/model-groups/${groupId}/items/${itemId}`,
      { method: "PUT", body: JSON.stringify(data) }
    )
  }
  deleteModelItem(wsId: string, groupId: string, itemId: string) {
    return this.fetch(
      `/workspaces/${wsId}/model-groups/${groupId}/items/${itemId}`,
      { method: "DELETE" }
    )
  }
  getItemVersions(wsId: string, groupId: string, itemId: string) {
    return this.fetch(
      `/workspaces/${wsId}/model-groups/${groupId}/items/${itemId}/versions`
    )
  }

  // Model Groups - Platform
  getPlatformModelGroups() {
    return this.fetch("/platform/model-groups")
  }
  createPlatformModelGroup(data: any) {
    return this.fetch("/platform/model-groups", {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  getPlatformModelGroup(groupId: string) {
    return this.fetch(`/platform/model-groups/${groupId}`)
  }
  updatePlatformModelGroup(groupId: string, data: any) {
    return this.fetch(`/platform/model-groups/${groupId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  deletePlatformModelGroup(groupId: string) {
    return this.fetch(`/platform/model-groups/${groupId}`, { method: "DELETE" })
  }
  getPlatformModelGroupGrants(groupId: string) {
    return this.fetch(`/platform/model-groups/${groupId}/grants`)
  }
  issuePlatformModelGroupGrant(groupId: string, data: any) {
    return this.fetch(`/platform/model-groups/${groupId}/grants`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  revokePlatformModelGroupGrant(groupId: string, grantId: string) {
    return this.fetch(
      `/platform/model-groups/${groupId}/grants/${grantId}/revoke`,
      { method: "POST", body: "{}" }
    )
  }
  addPlatformModelItem(groupId: string, data: any) {
    return this.fetch(`/platform/model-groups/${groupId}/items`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updatePlatformModelItem(groupId: string, itemId: string, data: any) {
    return this.fetch(`/platform/model-groups/${groupId}/items/${itemId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  deletePlatformModelItem(groupId: string, itemId: string) {
    return this.fetch(`/platform/model-groups/${groupId}/items/${itemId}`, {
      method: "DELETE",
    })
  }
  getPlatformItemVersions(groupId: string, itemId: string) {
    return this.fetch(
      `/platform/model-groups/${groupId}/items/${itemId}/versions`
    )
  }

  // Model Groups - Workspace Member
  getWorkspaceMemberModelGroups(wsId: string) {
    return this.fetch(`/workspaces/${wsId}/me/model-groups`)
  }
  createWorkspaceMemberModelGroup(wsId: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/me/model-groups`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  getWorkspaceMemberModelGroup(wsId: string, groupId: string) {
    return this.fetch(`/workspaces/${wsId}/me/model-groups/${groupId}`)
  }
  updateWorkspaceMemberModelGroup(wsId: string, groupId: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/me/model-groups/${groupId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  deleteWorkspaceMemberModelGroup(wsId: string, groupId: string) {
    return this.fetch(`/workspaces/${wsId}/me/model-groups/${groupId}`, {
      method: "DELETE",
    })
  }
  getWorkspaceMemberModelGroupGrants(wsId: string, groupId: string) {
    return this.fetch(`/workspaces/${wsId}/me/model-groups/${groupId}/grants`)
  }
  issueWorkspaceMemberModelGroupGrant(
    wsId: string,
    groupId: string,
    data: any
  ) {
    return this.fetch(`/workspaces/${wsId}/me/model-groups/${groupId}/grants`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  revokeWorkspaceMemberModelGroupGrant(
    wsId: string,
    groupId: string,
    grantId: string
  ) {
    return this.fetch(
      `/workspaces/${wsId}/me/model-groups/${groupId}/grants/${grantId}/revoke`,
      {
        method: "POST",
        body: "{}",
      }
    )
  }
  addWorkspaceMemberModelItem(wsId: string, groupId: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/me/model-groups/${groupId}/items`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updateWorkspaceMemberModelItem(
    wsId: string,
    groupId: string,
    itemId: string,
    data: any
  ) {
    return this.fetch(
      `/workspaces/${wsId}/me/model-groups/${groupId}/items/${itemId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
  }
  deleteWorkspaceMemberModelItem(
    wsId: string,
    groupId: string,
    itemId: string
  ) {
    return this.fetch(
      `/workspaces/${wsId}/me/model-groups/${groupId}/items/${itemId}`,
      {
        method: "DELETE",
      }
    )
  }
  getWorkspaceMemberItemVersions(
    wsId: string,
    groupId: string,
    itemId: string
  ) {
    return this.fetch(
      `/workspaces/${wsId}/me/model-groups/${groupId}/items/${itemId}/versions`
    )
  }

  // Actor Model Group Assignment
  getActorModelGroups(wsId: string, actorId: string) {
    return this.fetch(`/workspaces/${wsId}/actors/${actorId}/model-groups`)
  }
  getVisibleActorModelGroups(wsId: string, actorId: string) {
    return this.fetch(
      `/workspaces/${wsId}/actors/${actorId}/model-groups/visible`
    )
  }
  setActorModelGroups(
    wsId: string,
    actorId: string,
    groups: { groupId: string; priority: number }[]
  ) {
    return this.fetch(`/workspaces/${wsId}/actors/${actorId}/model-groups`, {
      method: "PUT",
      body: JSON.stringify({ groups }),
    })
  }

  getMyRelationshipProfile(wsId: string): Promise<RelationshipProfileView> {
    return this.fetch(`/workspaces/${wsId}/me/relationship-profile`)
  }
  updateMyRelationshipProfile(
    wsId: string,
    input: {
      approvalMode: "auto" | "manual"
      identityId?: string
      identitySearchEnabled?: boolean
    }
  ): Promise<RelationshipProfileView> {
    return this.fetch(`/workspaces/${wsId}/me/relationship-profile`, {
      method: "PUT",
      body: JSON.stringify(input),
    })
  }
  getActorRelationshipProfile(
    wsId: string,
    actorId: string
  ): Promise<RelationshipProfileView> {
    return this.fetch(
      `/workspaces/${wsId}/actors/${actorId}/relationship-profile`
    )
  }
  updateActorRelationshipProfile(
    wsId: string,
    actorId: string,
    input: {
      approvalMode: "auto" | "manual"
      identityId?: string
      identitySearchEnabled?: boolean
      accessPolicy?: "workspace_open" | "approval_required"
      isPublicShared?: boolean
    }
  ): Promise<RelationshipProfileView> {
    return this.fetch(
      `/workspaces/${wsId}/actors/${actorId}/relationship-profile`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      }
    )
  }
  getRemoteAgentRelationshipProfile(
    wsId: string,
    remoteAgentId: string
  ): Promise<RelationshipProfileView> {
    return this.fetch(
      `/workspaces/${wsId}/remote-agents/${remoteAgentId}/relationship-profile`
    )
  }
  updateRemoteAgentRelationshipProfile(
    wsId: string,
    remoteAgentId: string,
    input: {
      approvalMode: "auto" | "manual"
      identityId?: string
      identitySearchEnabled?: boolean
      accessPolicy?: "workspace_open" | "approval_required"
      isPublicShared?: boolean
    }
  ): Promise<RelationshipProfileView> {
    return this.fetch(
      `/workspaces/${wsId}/remote-agents/${remoteAgentId}/relationship-profile`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      }
    )
  }
  scanRelationshipQr(
    wsId: string,
    token: string
  ): Promise<RelationshipScanResponse> {
    return this.fetch(`/workspaces/${wsId}/relationship-qr/scan`, {
      method: "POST",
      body: JSON.stringify({ token }),
    })
  }
  searchIdentity(wsId: string, query: string): Promise<IdentitySearchResponse> {
    const params = new URLSearchParams()
    if (query.trim()) {
      params.set("q", query.trim())
    }
    return this.fetch(
      `/workspaces/${wsId}/identity-search${
        params.size > 0 ? `?${params.toString()}` : ""
      }`
    )
  }
  requestRelationshipByIdentityProfile(
    wsId: string,
    profileId: string
  ): Promise<RelationshipScanResponse> {
    return this.fetch(`/workspaces/${wsId}/identity-search/request`, {
      method: "POST",
      body: JSON.stringify({ profileId }),
    })
  }
  getContactHub(wsId: string): Promise<ContactHubResponse> {
    return this.fetch(`/workspaces/${wsId}/contact-hub`)
  }
  getContactHubDetail(
    wsId: string,
    contactKind: ContactHubEntryKind,
    contactId: string
  ): Promise<ContactHubDetailResponse> {
    return this.fetch(
      `/workspaces/${wsId}/contact-hub/${contactKind}/${contactId}`
    )
  }
  getFriendRequests(wsId: string): Promise<FriendRequestListResponse> {
    return this.fetch(`/workspaces/${wsId}/friend-requests`)
  }
  approveFriendRequest(wsId: string, requestId: string) {
    return this.fetch(
      `/workspaces/${wsId}/friend-requests/${requestId}/approve`,
      {
        method: "POST",
        body: "{}",
      }
    )
  }
  rejectFriendRequest(wsId: string, requestId: string) {
    return this.fetch(
      `/workspaces/${wsId}/friend-requests/${requestId}/reject`,
      {
        method: "POST",
        body: "{}",
      }
    )
  }
  getActorAccessRequests(
    wsId: string
  ): Promise<ActorAccessRequestListResponse> {
    return this.fetch(`/workspaces/${wsId}/actor-access-requests`)
  }
  getRemoteAgentAccessRequests(
    wsId: string
  ): Promise<RemoteAgentAccessRequestListResponse> {
    return this.fetch(`/workspaces/${wsId}/remote-agent-access-requests`)
  }
  approveActorAccessRequest(wsId: string, requestId: string) {
    return this.fetch(
      `/workspaces/${wsId}/actor-access-requests/${requestId}/approve`,
      {
        method: "POST",
        body: "{}",
      }
    )
  }
  rejectActorAccessRequest(wsId: string, requestId: string) {
    return this.fetch(
      `/workspaces/${wsId}/actor-access-requests/${requestId}/reject`,
      {
        method: "POST",
        body: "{}",
      }
    )
  }
  approveRemoteAgentAccessRequest(wsId: string, requestId: string) {
    return this.fetch(
      `/workspaces/${wsId}/remote-agent-access-requests/${requestId}/approve`,
      {
        method: "POST",
        body: "{}",
      }
    )
  }
  rejectRemoteAgentAccessRequest(wsId: string, requestId: string) {
    return this.fetch(
      `/workspaces/${wsId}/remote-agent-access-requests/${requestId}/reject`,
      {
        method: "POST",
        body: "{}",
      }
    )
  }
  openDirectConversation(
    wsId: string,
    input: {
      contactKind: ContactHubEntryKind
      contactId: string
    }
  ): Promise<DirectConversationOpenResponse> {
    return this.fetch(`/workspaces/${wsId}/chat/direct-conversations/open`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  getRemoteAgents(wsId: string): Promise<{ remoteAgents: RemoteAgentView[] }> {
    return this.fetch(`/workspaces/${wsId}/remote-agents`)
  }
  getRemoteAgent(
    wsId: string,
    remoteAgentId: string
  ): Promise<{ remoteAgent: RemoteAgentView }> {
    return this.fetch(`/workspaces/${wsId}/remote-agents/${remoteAgentId}`)
  }
  createRemoteAgent(
    wsId: string,
    input: {
      name: string
      title: string
      description?: string
      runtimeKind: RemoteAgentRuntimeKind
      avatarFileId?: string
      avatarEmoji?: string
      accessPolicy?: RemoteAgentAccessPolicy
      isPublicShared?: boolean
      metadata?: Record<string, unknown>
    }
  ): Promise<{ remoteAgent: RemoteAgentView }> {
    return this.fetch(`/workspaces/${wsId}/remote-agents`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  }
  updateRemoteAgent(
    wsId: string,
    remoteAgentId: string,
    input: {
      name?: string
      title?: string
      description?: string | null
      avatarFileId?: string | null
      avatarEmoji?: string | null
      accessPolicy?: RemoteAgentAccessPolicy
      isPublicShared?: boolean
      isActive?: boolean
      metadata?: Record<string, unknown>
    }
  ): Promise<{ remoteAgent: RemoteAgentView }> {
    return this.fetch(`/workspaces/${wsId}/remote-agents/${remoteAgentId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  }
  deleteRemoteAgent(
    wsId: string,
    remoteAgentId: string
  ): Promise<{ deleted: boolean }> {
    return this.fetch(`/workspaces/${wsId}/remote-agents/${remoteAgentId}`, {
      method: "DELETE",
    })
  }
  bindRemoteAgent(
    wsId: string,
    remoteAgentId: string,
    input: {
      machineId: string
      runtimeKind: RemoteAgentRuntimeKind
      runtimePath?: string
      localRootPath?: string
    }
  ): Promise<{ remoteAgent: RemoteAgentView }> {
    return this.fetch(
      `/workspaces/${wsId}/remote-agents/${remoteAgentId}/bind`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    )
  }
  createRemoteAgentMachinePairingSession(
    wsId: string,
    input: {
      title?: string
      description?: string
    }
  ): Promise<RemoteAgentMachinePairingSessionView> {
    return this.fetch(
      `/workspaces/${wsId}/remote-agent-machines/pairing-sessions`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    )
  }
  getRemoteAgentMachines(
    wsId: string
  ): Promise<{ machines: RemoteAgentMachineView[] }> {
    return this.fetch(`/workspaces/${wsId}/remote-agent-machines`)
  }
  getRemoteAgentMachine(
    wsId: string,
    machineId: string
  ): Promise<RemoteAgentMachineDetailView> {
    return this.fetch(`/workspaces/${wsId}/remote-agent-machines/${machineId}`)
  }
  getRemoteAgentGroupTaskGrants(
    wsId: string,
    remoteAgentId: string
  ): Promise<{ grants: RemoteAgentGroupTaskGrantView[] }> {
    return this.fetch(
      `/workspaces/${wsId}/remote-agents/${remoteAgentId}/group-task-grants`
    )
  }
  updateRemoteAgentGroupTaskGrants(
    wsId: string,
    remoteAgentId: string,
    input: {
      workspaceMemberIds: string[]
    }
  ): Promise<{ grants: RemoteAgentGroupTaskGrantView[] }> {
    return this.fetch(
      `/workspaces/${wsId}/remote-agents/${remoteAgentId}/group-task-grants`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      }
    )
  }

  // Actor lanes
  retryConversationMessage(
    workspaceId: string,
    threadId: string,
    itemId: string
  ) {
    return this.fetch(
      `/workspaces/${workspaceId}/chat/conversations/${threadId}/messages/${itemId}/retry`,
      {
        method: "POST",
      }
    )
  }

  getChatBootstrap(workspaceId: string): Promise<ChatBootstrapResponse> {
    return this.fetch(`/workspaces/${workspaceId}/chat/bootstrap`)
  }

  async loadConversationCatalog(
    workspaceId: string
  ): Promise<ConversationCatalogEntry[]> {
    const bootstrap = await this.getChatBootstrap(workspaceId)
    return bootstrap.conversations.map(normalizeConversationCatalogEntry)
  }

  getChatSync(
    workspaceId: string,
    input?: { cursor?: number; limit?: number }
  ): Promise<ChatSyncResponse> {
    const params = new URLSearchParams()
    if (typeof input?.cursor === "number") {
      params.set("cursor", String(input.cursor))
    }
    if (typeof input?.limit === "number") {
      params.set("limit", String(input.limit))
    }
    const query = params.toString()

    return this.fetch(
      `/workspaces/${workspaceId}/chat/sync${query ? `?${query}` : ""}`
    )
  }

  createChatClientInstance(
    workspaceId: string,
    input?: ChatClientInstanceCreateInput
  ): Promise<ChatClientInstanceRegistrationResponse> {
    return this.fetch(`/workspaces/${workspaceId}/chat/client-instances`, {
      method: "POST",
      body: JSON.stringify({
        platform: input?.platform,
        deviceLabel: input?.deviceLabel,
        metadata: input?.metadata,
      }),
    })
  }

  touchChatClientInstance(
    workspaceId: string,
    clientInstanceId: string,
    input?: ChatClientInstanceTouchInput
  ): Promise<ChatClientInstanceRegistrationResponse> {
    return this.fetch(
      `/workspaces/${workspaceId}/chat/client-instances/${clientInstanceId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          platform: input?.platform,
          deviceLabel: input?.deviceLabel,
          metadata: input?.metadata,
        }),
      }
    )
  }

  createChatConversation(
    workspaceId: string,
    input: ChatConversationCreateInput
  ): Promise<ChatConversationCreateResponse> {
    return this.fetch(`/workspaces/${workspaceId}/chat/conversations`, {
      method: "POST",
      body: JSON.stringify({
        clientRequestId: input.clientRequestId,
        kind: input.kind,
        title: input.title,
        workspaceMemberIds: input.workspaceMemberIds ?? [],
        actorIds: input.actorIds ?? [],
        remoteAgentIds: input.remoteAgentIds ?? [],
        metadata: input.metadata,
      }),
    })
  }

  getChatConversationMessages(
    workspaceId: string,
    conversationId: string,
    input: ChatConversationMessagesQuery
  ): Promise<ChatConversationMessagesPage> {
    const params = new URLSearchParams()
    if (typeof input.afterSequence === "number") {
      params.set("afterSequence", String(input.afterSequence))
    }
    if (typeof input.beforeSequence === "number") {
      params.set("beforeSequence", String(input.beforeSequence))
    }
    if (typeof input.limit === "number") {
      params.set("limit", String(input.limit))
    }
    params.set("clientInstanceId", input.clientInstanceId)
    const query = params.toString()

    return this.fetch(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/messages${query ? `?${query}` : ""}`
    )
  }

  getChatConversationRuntimeTurnDetail(
    workspaceId: string,
    conversationId: string,
    actorId: string,
    turnId: string
  ): Promise<ActorRuntimeTurnActivityDetail> {
    return this.fetch(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/actors/${actorId}/runtime-turns/${turnId}`
    )
  }

  sendChatConversationMessage(
    workspaceId: string,
    conversationId: string,
    input: ChatConversationSendMessageInput
  ): Promise<ChatConversationSendMessageResponse> {
    return this.fetch(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: input.clientMessageId,
          contentBlocks: input.contentBlocks,
          replyToItemId: input.replyToItemId,
          clientInstanceId: input.clientInstanceId,
          metadata: input.metadata,
        }),
      }
    )
  }

  updateChatConversationReadWatermark(
    workspaceId: string,
    conversationId: string,
    input: ChatConversationReadWatermarkInput
  ): Promise<ChatConversationReadWatermarkResponse> {
    return this.fetch(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/read-watermark`,
      {
        method: "POST",
        body: JSON.stringify({
          readUpToSequence: input.readUpToSequence,
          lastVisibleSequence: input.lastVisibleSequence,
          clientInstanceId: input.clientInstanceId,
        }),
      }
    )
  }

  sendChatTypingState(
    workspaceId: string,
    conversationId: string,
    state: "started" | "stopped"
  ) {
    return this.fetch(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/typing`,
      { method: "POST", body: JSON.stringify({ state }) }
    )
  }

  registerChatPushToken(
    workspaceId: string,
    input: {
      platform: "ios" | "android" | "web"
      token: string
      deviceLabel?: string
      metadata?: Record<string, unknown>
    }
  ) {
    return this.fetch(`/workspaces/${workspaceId}/chat/push-tokens`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  listChatPushTokens(workspaceId: string) {
    return this.fetch(`/workspaces/${workspaceId}/chat/push-tokens`)
  }

  deleteChatPushToken(workspaceId: string, tokenId: string) {
    return this.fetch(
      `/workspaces/${workspaceId}/chat/push-tokens/${tokenId}`,
      { method: "DELETE" }
    )
  }

  resolveChatTask(
    workspaceId: string,
    threadId: string,
    taskId: string,
    data: ChatTaskResolveInput
  ): Promise<ChatTaskResolveResponse> {
    return this.fetch(
      `/workspaces/${workspaceId}/chat/conversations/${threadId}/tasks/${taskId}/respond`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    ).catch((error) => {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        isChatTaskResolveConflictResponse(error.details)
      ) {
        return error.details
      }
      throw error
    })
  }
  getTransportConnectors(
    wsId: string
  ): Promise<{ connectors: TransportConnectorCapability[] }> {
    return this.fetch(`/workspaces/${wsId}/im/connectors`)
  }
  getTransportAccounts(
    wsId: string
  ): Promise<{ accounts: TransportAccountSummary[] }> {
    return this.fetch(`/workspaces/${wsId}/im/accounts`)
  }
  getTransportSessions(
    wsId: string
  ): Promise<{ sessions: TransportSessionSummary[] }> {
    return this.fetch(`/workspaces/${wsId}/im/sessions`)
  }
  getTransportExternalUsers(
    wsId: string,
    transportAccountId?: string
  ): Promise<{ externalUsers: TransportExternalUserSummary[] }> {
    const params = new URLSearchParams()
    if (transportAccountId) params.set("transportAccountId", transportAccountId)
    return this.fetch(
      `/workspaces/${wsId}/im/external-users${params.size ? `?${params.toString()}` : ""}`
    )
  }
  createFeishuTransportAccount(
    wsId: string,
    data: Record<string, unknown>
  ): Promise<{ account: TransportAccountSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/accounts/feishu`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updateFeishuTransportAccount(
    wsId: string,
    accountId: string,
    data: Record<string, unknown>
  ): Promise<{ account: TransportAccountSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/accounts/feishu/${accountId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  createWecomTransportAccount(
    wsId: string,
    data: Record<string, unknown>
  ): Promise<{ account: TransportAccountSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/accounts/wecom`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updateWecomTransportAccount(
    wsId: string,
    accountId: string,
    data: Record<string, unknown>
  ): Promise<{ account: TransportAccountSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/accounts/wecom/${accountId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  createQqTransportAccount(
    wsId: string,
    data: Record<string, unknown>
  ): Promise<{ account: TransportAccountSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/accounts/qq`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updateQqTransportAccount(
    wsId: string,
    accountId: string,
    data: Record<string, unknown>
  ): Promise<{ account: TransportAccountSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/accounts/qq/${accountId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  startWeixinQrTransportSession(
    wsId: string,
    data: Record<string, unknown>
  ): Promise<{ session: WeixinQrLoginSessionSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/accounts/weixin/qr`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  getWeixinQrTransportSession(
    wsId: string,
    sessionId: string
  ): Promise<{ session: WeixinQrLoginSessionSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/accounts/weixin/qr/${sessionId}`)
  }
  startDingtalkDeviceFlow(
    wsId: string,
    data: Record<string, unknown>
  ): Promise<DingtalkDeviceFlowStartResponse> {
    return this.fetch(
      `/workspaces/${wsId}/im/accounts/dingtalk/device-registration/start`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
  }
  pollDingtalkDeviceFlow(
    wsId: string,
    sessionId: string
  ): Promise<DingtalkDeviceFlowPollResponse> {
    return this.fetch(
      `/workspaces/${wsId}/im/accounts/dingtalk/device-registration/${sessionId}`
    )
  }
  cancelDingtalkDeviceFlow(wsId: string, sessionId: string): Promise<void> {
    return this.fetch(
      `/workspaces/${wsId}/im/accounts/dingtalk/device-registration/${sessionId}`,
      { method: "DELETE" }
    )
  }
  createDingtalkAccountManual(
    wsId: string,
    data: Record<string, unknown>
  ): Promise<{ account: TransportAccountSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/accounts/dingtalk/manual`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  getCurrentUserWeixinBinding(
    wsId: string
  ): Promise<{ binding: CurrentUserWeixinBindingSummary | null }> {
    return this.fetch(`/workspaces/${wsId}/im/me/weixin-binding`)
  }
  getCurrentUserWeixinBindingCandidates(
    wsId: string
  ): Promise<{ data: Array<Record<string, unknown>> }> {
    return this.fetch(`/workspaces/${wsId}/im/me/weixin-binding/candidates`)
  }
  startCurrentUserWeixinBindingQr(
    wsId: string
  ): Promise<{ session: WeixinQrLoginSessionSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/me/weixin-binding/qr`, {
      method: "POST",
      body: "{}",
    })
  }
  getCurrentUserWeixinBindingQr(
    wsId: string,
    sessionId: string
  ): Promise<{ session: WeixinQrLoginSessionSummary }> {
    return this.fetch(
      `/workspaces/${wsId}/im/me/weixin-binding/qr/${sessionId}`
    )
  }
  linkCurrentUserWeixinBinding(
    wsId: string
  ): Promise<{ binding: CurrentUserWeixinBindingSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/me/weixin-binding/link`, {
      method: "POST",
      body: "{}",
    })
  }
  setCurrentUserWeixinBindingAutoLink(
    wsId: string,
    workspaceMemberId: string | null
  ): Promise<{ binding: CurrentUserWeixinBindingSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/me/weixin-binding/auto-link`, {
      method: "PUT",
      body: JSON.stringify({ workspaceMemberId }),
    })
  }
  createTransportAccount(
    wsId: string,
    data: Record<string, unknown>
  ): Promise<{ account: TransportAccountSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/accounts`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updateTransportAccount(
    wsId: string,
    accountId: string,
    data: Record<string, unknown>
  ): Promise<{ account: TransportAccountSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/accounts/${accountId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  updateTransportSessionSettings(
    wsId: string,
    sessionId: string,
    data: Record<string, unknown>
  ): Promise<{ session: TransportSessionSummary | null }> {
    return this.fetch(`/workspaces/${wsId}/im/sessions/${sessionId}/settings`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  setTransportExternalUserWorkspaceMember(
    wsId: string,
    addressId: string,
    workspaceMemberId: string | null
  ): Promise<{ externalUser: TransportExternalUserSummary }> {
    return this.fetch(
      `/workspaces/${wsId}/im/external-users/${addressId}/workspace-member`,
      {
        method: "PUT",
        body: JSON.stringify({ workspaceMemberId }),
      }
    )
  }
  // MCP Marketplace
  getMarketplace(params?: string) {
    return this.fetch(`/mcp/marketplace${params ? "?" + params : ""}`)
  }
  getMarketplacePlugin(pluginId: string) {
    return this.fetch(`/mcp/marketplace/${pluginId}`)
  }
  getPluginCategories() {
    return this.fetch("/mcp/categories")
  }
  getMcpOrganizations() {
    return this.fetch("/mcp/organizations")
  }
  getMcpOrganization(orgId: string) {
    return this.fetch(`/mcp/organizations/${orgId}`)
  }

  // MCP Unified Installations
  getInstallations(wsId: string, params?: string) {
    return this.fetch(
      `/workspaces/${wsId}/mcp/installations${params ? "?" + params : ""}`
    )
  }
  getInstallation(wsId: string, installId: string) {
    return this.fetch(`/workspaces/${wsId}/mcp/installations/${installId}`)
  }
  installPlugin(
    wsId: string,
    data: {
      pluginId: string
      attachmentTarget: AttachmentTarget
      lifecycleScope?:
        | "turn"
        | "session"
        | "workspace"
        | "conversation"
        | "actor"
      configData?: Record<string, unknown>
      authSessionIds?: Record<string, string>
    }
  ) {
    return this.fetch(`/workspaces/${wsId}/mcp/installations`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updateInstallation(wsId: string, installId: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/mcp/installations/${installId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  uninstallPlugin(wsId: string, installId: string) {
    return this.fetch(`/workspaces/${wsId}/mcp/installations/${installId}`, {
      method: "DELETE",
    })
  }
  startPluginAuth(
    wsId: string,
    pluginId: string,
    bindingKey: string,
    data?: {
      installationId?: string
      draftConfig?: Record<string, unknown>
      metadata?: Record<string, unknown>
    }
  ) {
    return this.fetch(
      `/workspaces/${wsId}/mcp/plugins/${pluginId}/auth/${bindingKey}/start`,
      { method: "POST", body: JSON.stringify(data || {}) }
    )
  }
  getPluginAuthSession(wsId: string, sessionId: string) {
    return this.fetch(`/workspaces/${wsId}/mcp/auth/sessions/${sessionId}`)
  }
  inspectPluginAuthSession(wsId: string, sessionId: string) {
    return this.fetch(
      `/workspaces/${wsId}/mcp/auth/sessions/${sessionId}/inspect`,
      {
        method: "POST",
        body: "{}",
      }
    )
  }
  getPluginInstallationAccess(wsId: string, installId: string) {
    return this.fetch(
      `/workspaces/${wsId}/mcp/installations/${installId}/access`
    )
  }
  grantPluginInstallationAccess(
    wsId: string,
    installId: string,
    data: {
      accessTarget?: CapabilityAccessTarget
      conversationTypeMaskOverride?: number | null
      permissions?: string[]
      reason?: string
    }
  ) {
    return this.fetch(
      `/workspaces/${wsId}/mcp/installations/${installId}/access`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
  }
  updatePluginInstallationAccessGrant(
    wsId: string,
    installId: string,
    grantId: string,
    data: {
      conversationTypeMaskOverride?: number | null
    }
  ) {
    return this.fetch(
      `/workspaces/${wsId}/mcp/installations/${installId}/access/${grantId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
  }
  revokePluginInstallationAccess(
    wsId: string,
    installId: string,
    grantId: string
  ) {
    return this.fetch(
      `/workspaces/${wsId}/mcp/installations/${installId}/access/${grantId}`,
      {
        method: "DELETE",
      }
    )
  }

  // MCP Audit
  getMcpToolCallLogs(wsId: string, params?: string) {
    return this.fetch(
      `/workspaces/${wsId}/mcp/audit/tool-calls${params ? "?" + params : ""}`
    )
  }
  getMcpEventLogs(wsId: string, params?: string) {
    return this.fetch(
      `/workspaces/${wsId}/mcp/audit/events${params ? "?" + params : ""}`
    )
  }

  // Devices (v3)
  listDevices(wsId: string): Promise<{ devices: DeviceSummaryView[] }> {
    return this.fetch(`/workspaces/${wsId}/devices`)
  }
  getDevice(wsId: string, deviceId: string): Promise<DeviceDetailView> {
    return this.fetch(`/workspaces/${wsId}/devices/${deviceId}`)
  }
  deleteDevice(wsId: string, deviceId: string): Promise<void> {
    return this.fetch(`/workspaces/${wsId}/devices/${deviceId}`, {
      method: "DELETE",
    })
  }
  startDevicePairingSession(
    wsId: string,
    body: {
      mode: "local_qr" | "cloud_bootstrap" | "service_join"
      title?: string
      device_type?: string
      device_id?: string
      context?: Record<string, unknown>
    }
  ): Promise<DevicePairingTicketView> {
    return this.fetch(`/workspaces/${wsId}/devices/pairing-sessions`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  }
  claimRemoteAgentDaemon(
    wsId: string,
    deviceId: string,
    remoteAgentMachineId: string
  ): Promise<DeviceServiceSummaryView> {
    return this.fetch(`/workspaces/${wsId}/devices/${deviceId}/services`, {
      method: "POST",
      body: JSON.stringify({
        service_kind: "remote_agent_daemon",
        remote_agent_machine_id: remoteAgentMachineId,
      }),
    })
  }
  detachDeviceService(
    wsId: string,
    deviceId: string,
    serviceId: string
  ): Promise<void> {
    return this.fetch(
      `/workspaces/${wsId}/devices/${deviceId}/services/${serviceId}`,
      { method: "DELETE" }
    )
  }
  // v3.1: manual runtime-authorization grant endpoint. The chat card for
  // active-page / page_id / all_pages browser tools renders "Manual grant
  // required" — this is the endpoint that backs the Settings page.
  createManualRuntimeAuthorizationGrant(
    wsId: string,
    body: {
      device_capability_id: string
      policy: Record<string, unknown>
    }
  ): Promise<{ grant: Record<string, unknown> }> {
    return this.fetch(`/workspaces/${wsId}/runtime-authorization-grants`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  // Automation Event Sources
  getAutomationEventSources(
    wsId: string,
    filters?: {
      status?: "active" | "deprecated" | "disabled" | "archived"
      providerKind?: "device" | "webhook" | "internal" | "integration"
      providerRef?: string
      sourceKey?: string
    }
  ): Promise<AutomationEventSource[]> {
    const params = new URLSearchParams()
    if (filters?.status) params.set("status", filters.status)
    if (filters?.providerKind) params.set("providerKind", filters.providerKind)
    if (filters?.providerRef) params.set("providerRef", filters.providerRef)
    if (filters?.sourceKey) params.set("sourceKey", filters.sourceKey)
    const qs = params.toString()
    return this.fetch(
      `/workspaces/${wsId}/automation-event-sources${qs ? `?${qs}` : ""}`
    )
  }
  createAutomationEventSource(
    wsId: string,
    data: {
      providerKind: "device" | "webhook" | "internal" | "integration"
      providerRef?: string
      integration?: {
        installationId: string
        provider: "github" | "gitlab"
        ingressKind?: "webhook" | "polling"
        targetKind: "repository" | "project"
        targetId: string
        targetLabel?: string
      }
      sourceKey?: string
      name?: string
      description?: string
      recommendedUsage?: string
      payloadSchema?: Record<string, unknown>
      examplePayload?: Record<string, unknown>
      status?: "active" | "deprecated" | "disabled" | "archived"
      metadata?: Record<string, unknown>
    }
  ): Promise<AutomationEventSource> {
    return this.fetch(`/workspaces/${wsId}/automation-event-sources`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updateAutomationEventSource(
    wsId: string,
    eventSourceId: string,
    data: {
      providerRef?: string
      name?: string
      description?: string
      recommendedUsage?: string
      payloadSchema?: Record<string, unknown>
      examplePayload?: Record<string, unknown>
      status?: "active" | "deprecated" | "disabled" | "archived"
      metadata?: Record<string, unknown>
    }
  ): Promise<AutomationEventSource> {
    return this.fetch(
      `/workspaces/${wsId}/automation-event-sources/${eventSourceId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
  }
  archiveAutomationEventSource(wsId: string, eventSourceId: string) {
    return this.fetch(
      `/workspaces/${wsId}/automation-event-sources/${eventSourceId}`,
      {
        method: "DELETE",
      }
    )
  }
  getAutomationEventSourceOccurrences(
    wsId: string,
    eventSourceId: string
  ): Promise<AutomationOccurrence[]> {
    return this.fetch(
      `/workspaces/${wsId}/automation-event-sources/${eventSourceId}/occurrences`
    )
  }

  // Automation Rules / Triggers
  getAutomations(
    wsId: string,
    filters?: {
      status?: "active" | "paused" | "error" | "archived"
      category?: "schedule" | "event_subscription"
      conversationId?: string
    }
  ): Promise<AutomationRule[]> {
    const params = new URLSearchParams()
    if (filters?.status) params.set("status", filters.status)
    if (filters?.category) params.set("category", filters.category)
    if (filters?.conversationId)
      params.set("conversationId", filters.conversationId)
    const qs = params.toString()
    return this.fetch(`/workspaces/${wsId}/automations${qs ? `?${qs}` : ""}`)
  }
  getAutomation(wsId: string, automationId: string): Promise<AutomationRule> {
    return this.fetch(`/workspaces/${wsId}/automations/${automationId}`)
  }
  createAutomation(
    wsId: string,
    data: AutomationRuleCreatePayload
  ): Promise<AutomationRule> {
    return this.fetch(`/workspaces/${wsId}/automations`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updateAutomation(
    wsId: string,
    automationId: string,
    data: AutomationRuleUpdatePayload
  ): Promise<AutomationRule> {
    return this.fetch(`/workspaces/${wsId}/automations/${automationId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  deleteAutomation(wsId: string, automationId: string) {
    return this.fetch(`/workspaces/${wsId}/automations/${automationId}`, {
      method: "DELETE",
    })
  }
  getAutomationExecutions(
    wsId: string,
    automationId: string
  ): Promise<AutomationExecution[]> {
    return this.fetch(
      `/workspaces/${wsId}/automations/${automationId}/executions`
    )
  }

  // File Upload
  async uploadFile(
    wsId: string,
    file: File,
    options?: {
      signal?: AbortSignal
      onProgress?: (progress: number) => void
    }
  ): Promise<FileRecordView> {
    const formData = new FormData()
    formData.append("file", file)
    formData.append(
      "origin",
      JSON.stringify({
        family: "user_upload",
        system: FILE_ORIGIN_SYSTEMS.WORKSPACE_WEB_UPLOAD,
      })
    )

    return new Promise<FileRecordView>((resolve, reject) => {
      const request = new XMLHttpRequest()
      let completed = false

      const cleanup = () => {
        options?.signal?.removeEventListener("abort", handleAbort)
      }

      const finalizeReject = (error: Error) => {
        if (completed) return
        completed = true
        cleanup()
        reject(error)
      }

      const handleAbort = () => {
        request.abort()
        finalizeReject(new ApiError("Upload aborted", 0, "ABORTED"))
      }

      request.open("POST", `${API_BASE}/workspaces/${wsId}/files`)
      request.withCredentials = true
      request.responseType = "json"

      request.upload.addEventListener("progress", (event) => {
        if (!event.lengthComputable) {
          return
        }

        options?.onProgress?.(event.loaded / event.total)
      })

      request.addEventListener("load", () => {
        if (completed) return
        completed = true
        cleanup()

        if (request.status >= 200 && request.status < 300) {
          resolve(request.response as FileRecordView)
          return
        }

        const response =
          request.response && typeof request.response === "object"
            ? request.response
            : null
        const message =
          response && "error" in response && typeof response.error === "string"
            ? response.error
            : "Upload failed"

        reject(new ApiError(message, request.status || 500))
      })

      request.addEventListener("error", () => {
        finalizeReject(new Error("Upload failed"))
      })
      request.addEventListener("abort", () => {
        finalizeReject(new ApiError("Upload aborted", 0, "ABORTED"))
      })

      options?.signal?.addEventListener("abort", handleAbort, {
        once: true,
      })

      request.send(formData)
    })
  }
  getFileInfo(fileId: string): Promise<FileRecordView> {
    return this.fetch(`/files/${fileId}/info`)
  }
}

export const api = new ApiClient()
