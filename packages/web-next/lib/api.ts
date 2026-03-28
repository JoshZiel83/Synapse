import type {
  ActorPackageInstallResult,
  AuthClientType,
  AuthQrLoginCreateResponse,
  AuthQrLoginResolveResponse,
  AuthQrLoginStatusResponse,
  AuthResponse,
  AuthSessionPersistence,
  AuthSessionSummary,
  AuthTransport,
  ActorPackageRecord,
  AutomationEventSource,
  AutomationExecution,
  AutomationOccurrence,
  AutomationRule,
  AutomationRuleCreatePayload,
  AutomationRuleUpdatePayload,
  CanonicalContentBlock,
  CurrentUserWeixinBindingSummary,
  ConversationFeedItem,
  ConversationFeedPage,
  ConversationTransportBindingSummary,
  InstalledSkill,
  InteractionRequestSummary,
  TransportAccountSummary,
  TransportConnectorCapability,
  TransportExternalUserSummary,
  TransportSessionSummary,
  WeixinQrLoginSessionSummary,
  WorkspaceFeedPage,
  WorkspaceChiefActorPreference,
  RelayDashboardView,
  RelayDeviceDetailView,
  RelayDeviceSummaryView,
  RelayPairingSessionView,
  SkillMarketplaceEntry,
  SkillUseScope,
} from "@synapse/shared"
import type { FileRecordView } from "@synapse/shared/types"

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api/v1"

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
  clientType?: AuthClientType
  transport?: AuthTransport
  sessionPersistence?: AuthSessionPersistence
  deviceName?: string
  platform?: string
}

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
      throw new ApiError(
        data && typeof data.error === "string" ? data.error : "API error",
        res.status,
        data && typeof data.code === "string" ? data.code : undefined,
        data
      )
    }

    return data
  }

  // Auth
  register(
    email: string,
    password: string,
    name: string,
    options: AuthMutationOptions = {}
  ): Promise<AuthResponse> {
    return this.fetch("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        name,
        clientType: options.clientType ?? "web",
        transport: options.transport ?? "cookie",
        sessionPersistence: options.sessionPersistence,
        deviceName: options.deviceName,
        platform: options.platform,
      }),
    })
  }
  login(
    email: string,
    password: string,
    options: AuthMutationOptions = {}
  ): Promise<AuthResponse> {
    return this.fetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        clientType: options.clientType ?? "web",
        transport: options.transport ?? "cookie",
        sessionPersistence: options.sessionPersistence,
        deviceName: options.deviceName,
        platform: options.platform,
      }),
    })
  }
  createQrLoginRequest(): Promise<AuthQrLoginCreateResponse> {
    return this.fetch("/auth/qr-login/requests", { method: "POST", body: "{}" })
  }
  getQrLoginRequestStatus(
    requestId: string,
    browserToken: string
  ): Promise<AuthQrLoginStatusResponse> {
    return this.fetch(`/auth/qr-login/requests/${requestId}/status`, {
      headers: {
        "x-browser-token": browserToken,
      },
    })
  }
  resolveQrLogin(token: string): Promise<AuthQrLoginResolveResponse> {
    return this.fetch("/auth/qr-login/resolve", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
  }
  approveQrLogin(
    token: string,
    sessionPersistence: AuthSessionPersistence
  ): Promise<AuthQrLoginStatusResponse> {
    return this.fetch("/auth/qr-login/approve", {
      method: "POST",
      body: JSON.stringify({ token, sessionPersistence }),
    })
  }
  rejectQrLogin(token: string): Promise<AuthQrLoginStatusResponse> {
    return this.fetch("/auth/qr-login/reject", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
  }
  finalizeQrLogin(
    requestId: string,
    browserToken: string
  ): Promise<AuthResponse> {
    return this.fetch(`/auth/qr-login/requests/${requestId}/finalize`, {
      method: "POST",
      body: JSON.stringify({ browserToken }),
    })
  }
  logout() {
    return this.fetch("/auth/logout", { method: "POST" })
  }
  logoutAll() {
    return this.fetch("/auth/logout-all", { method: "POST" })
  }
  getSessions(): Promise<{ sessions: AuthSessionSummary[] }> {
    return this.fetch("/auth/sessions")
  }
  revokeSession(sessionId: string) {
    return this.fetch(`/auth/sessions/${sessionId}`, { method: "DELETE" })
  }
  getMe() {
    return this.fetch("/auth/me")
  }
  updateMe(data: { name?: string; avatarFileId?: string | null }) {
    return this.fetch("/auth/me", { method: "PUT", body: JSON.stringify(data) })
  }

  // Workspaces
  getWorkspaces() {
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
  grantWorkspaceAccess(
    wsId: string,
    data: {
      userId: string
      accessKey:
        | "model_admin"
        | "actor_admin"
        | "skill_admin"
        | "plugin_admin"
        | "memory_admin"
        | "relay_admin"
        | "conversation_admin"
      metadata?: Record<string, unknown>
    }
  ) {
    return this.fetch(`/workspaces/${wsId}/access`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  revokeWorkspaceAccess(
    wsId: string,
    userId: string,
    accessKey:
      | "model_admin"
      | "actor_admin"
      | "skill_admin"
      | "plugin_admin"
      | "memory_admin"
      | "relay_admin"
      | "conversation_admin"
  ) {
    return this.fetch(
      `/workspaces/${wsId}/access/${accessKey}/users/${userId}/revoke`,
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
    metadata?: Record<string, unknown>
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
    isActive?: boolean
    metadata?: Record<string, unknown>
    attachmentFiles?: Array<{
      path: string
      contentBlocks: CanonicalContentBlock[]
    }>
  }): Promise<{ skill: SkillMarketplaceEntry }> {
    return this.fetch("/skills/marketplace", {
      method: "POST",
      body: JSON.stringify(data),
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
      }>
      grantScope: SkillUseScope
      actorId?: string
      conversationId?: string
      userId?: string
    }
  ): Promise<{ skill: InstalledSkill }> {
    return this.fetch(`/workspaces/${wsId}/skills/custom`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }

  // Installed Skills
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
      grantScope: SkillUseScope
      actorId?: string
      conversationId?: string
      userId?: string
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
      attachmentFiles?: Array<{
        path: string
        contentBlocks: CanonicalContentBlock[]
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
      grantScope?:
        | "workspace"
        | "conversation"
        | "actor_global"
        | "actor_conversation"
        | "user"
      conversationId?: string
      actorId?: string
      userId?: string
      permissions?: string[]
      reason?: string
      metadata?: Record<string, unknown>
    }
  ) {
    return this.fetch(`/workspaces/${wsId}/skills/${installedSkillId}/access`, {
      method: "POST",
      body: JSON.stringify(data),
    })
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

  // Work Items
  getWorkItems(wsId: string, params?: string) {
    return this.fetch(
      `/workspaces/${wsId}/work-items${params ? "?" + params : ""}`
    )
  }
  getWorkItem(wsId: string, id: string) {
    return this.fetch(`/workspaces/${wsId}/work-items/${id}`)
  }

  // Messages
  getMessages(wsId: string, params?: string) {
    return this.fetch(
      `/workspaces/${wsId}/messages${params ? "?" + params : ""}`
    )
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

  // Model Groups - User
  getUserModelGroups() {
    return this.fetch("/me/model-groups")
  }
  createUserModelGroup(data: any) {
    return this.fetch("/me/model-groups", {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  getUserModelGroup(groupId: string) {
    return this.fetch(`/me/model-groups/${groupId}`)
  }
  updateUserModelGroup(groupId: string, data: any) {
    return this.fetch(`/me/model-groups/${groupId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  deleteUserModelGroup(groupId: string) {
    return this.fetch(`/me/model-groups/${groupId}`, { method: "DELETE" })
  }
  getUserModelGroupGrants(groupId: string) {
    return this.fetch(`/me/model-groups/${groupId}/grants`)
  }
  issueUserModelGroupGrant(groupId: string, data: any) {
    return this.fetch(`/me/model-groups/${groupId}/grants`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  revokeUserModelGroupGrant(groupId: string, grantId: string) {
    return this.fetch(`/me/model-groups/${groupId}/grants/${grantId}/revoke`, {
      method: "POST",
      body: "{}",
    })
  }
  addUserModelItem(groupId: string, data: any) {
    return this.fetch(`/me/model-groups/${groupId}/items`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  updateUserModelItem(groupId: string, itemId: string, data: any) {
    return this.fetch(`/me/model-groups/${groupId}/items/${itemId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  deleteUserModelItem(groupId: string, itemId: string) {
    return this.fetch(`/me/model-groups/${groupId}/items/${itemId}`, {
      method: "DELETE",
    })
  }
  getUserItemVersions(groupId: string, itemId: string) {
    return this.fetch(`/me/model-groups/${groupId}/items/${itemId}/versions`)
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

  // Sessions
  createSession(
    wsId: string,
    actorId: string,
    content: string,
    channelType?: string
  ) {
    return this.fetch(`/workspaces/${wsId}/actors/${actorId}/sessions`, {
      method: "POST",
      body: JSON.stringify({ content, channelType: channelType || "web" }),
    })
  }
  sendSessionMessage(wsId: string, sessionId: string, content: string) {
    return this.fetch(`/workspaces/${wsId}/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    })
  }
  getSession(wsId: string, sessionId: string) {
    return this.fetch(`/workspaces/${wsId}/sessions/${sessionId}`)
  }
  getSessionMessages(wsId: string, sessionId: string) {
    return this.fetch(`/workspaces/${wsId}/sessions/${sessionId}/messages`)
  }
  getActorSessions(wsId: string, actorId: string, status?: string) {
    const params = status ? `?status=${status}` : ""
    return this.fetch(`/workspaces/${wsId}/actors/${actorId}/sessions${params}`)
  }
  getSessionTree(wsId: string, sessionId: string) {
    return this.fetch(`/workspaces/${wsId}/sessions/${sessionId}/tree`)
  }
  retrySession(wsId: string, sessionId: string, itemId?: string) {
    return this.fetch(`/workspaces/${wsId}/sessions/${sessionId}/retry`, {
      method: "POST",
      body: JSON.stringify(itemId ? { itemId } : {}),
    })
  }
  cancelSession(wsId: string, sessionId: string) {
    return this.fetch(`/workspaces/${wsId}/sessions/${sessionId}`, {
      method: "DELETE",
    })
  }

  // Chat Groups
  getGroups(wsId: string) {
    return this.fetch(`/workspaces/${wsId}/chat/groups`)
  }
  updateGroup(
    wsId: string,
    groupId: string,
    data: { title?: string; avatarFileId?: string | null }
  ) {
    return this.fetch(`/workspaces/${wsId}/chat/groups/${groupId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  createGroup(
    wsId: string,
    actorIds: string[],
    content?: string,
    targetActorIdOrIds?: string | string[],
    contentBlocks?: CanonicalContentBlock[]
  ) {
    const targetActorIds = Array.isArray(targetActorIdOrIds)
      ? targetActorIdOrIds.filter(Boolean)
      : typeof targetActorIdOrIds === "string" && targetActorIdOrIds
        ? [targetActorIdOrIds]
        : []
    const body: any =
      actorIds.length === 1
        ? {
            actorId: actorIds[0],
            ...(content && { content }),
            ...(contentBlocks && contentBlocks.length > 0 && { contentBlocks }),
            ...(targetActorIds.length > 0 && { targetActorIds }),
          }
        : {
            actorIds,
            ...(content && { content }),
            ...(contentBlocks && contentBlocks.length > 0 && { contentBlocks }),
            ...(targetActorIds.length > 0
              ? {
                  targetActorIds,
                  targetActorId: targetActorIds[0],
                }
              : {
                  targetActorId: actorIds[0],
                }),
          }
    return this.fetch(`/workspaces/${wsId}/chat/groups`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  }
  getGroupMessages(
    wsId: string,
    groupId: string,
    limit?: number,
    before?: string
  ): Promise<ConversationFeedPage> {
    const params = new URLSearchParams()
    if (limit) params.set("limit", String(limit))
    if (before) params.set("before", before)
    const qs = params.toString()
    return this.fetch(
      `/workspaces/${wsId}/chat/groups/${groupId}/messages${qs ? "?" + qs : ""}`
    )
  }
  getWorkspaceFeed(
    wsId: string,
    after?: number,
    limit?: number
  ): Promise<WorkspaceFeedPage> {
    const params = new URLSearchParams()
    if (typeof after === "number" && Number.isFinite(after) && after > 0) {
      params.set("after", String(after))
    }
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      params.set("limit", String(limit))
    }
    const qs = params.toString()
    return this.fetch(`/workspaces/${wsId}/chat/feed${qs ? "?" + qs : ""}`)
  }
  getGroupMembers(wsId: string, groupId: string) {
    return this.fetch(`/workspaces/${wsId}/chat/groups/${groupId}/members`)
  }
  addGroupMembers(
    wsId: string,
    groupId: string,
    data: { actorIds?: string[]; userIds?: string[] }
  ) {
    return this.fetch(`/workspaces/${wsId}/chat/groups/${groupId}/members`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  sendGroupMessage(
    wsId: string,
    groupId: string,
    contentBlocks: CanonicalContentBlock[],
    clientMessageId: string,
    targetParticipantIds?: string[],
    targetActorIds?: string[]
  ): Promise<{ item: ConversationFeedItem }> {
    const body: any = { contentBlocks }
    if (targetParticipantIds && targetParticipantIds.length > 0)
      body.targetParticipantIds = targetParticipantIds
    if (targetActorIds && targetActorIds.length > 0)
      body.targetActorIds = targetActorIds
    body.clientMessageId = clientMessageId
    return this.fetch(`/workspaces/${wsId}/chat/groups/${groupId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  }
  resolveInteraction(
    wsId: string,
    groupId: string,
    interactionId: string,
    data: {
      answers?: {
        fieldId: string
        selectedOptionIds?: string[]
        otherText?: string
        text?: string
      }[]
      selectedOptionId?: string
      decision?: "approve" | "reject"
      note?: string
    }
  ): Promise<{ interaction: InteractionRequestSummary }> {
    return this.fetch(
      `/workspaces/${wsId}/chat/groups/${groupId}/interactions/${interactionId}/respond`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
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
    userId: string | null
  ): Promise<{ binding: CurrentUserWeixinBindingSummary }> {
    return this.fetch(`/workspaces/${wsId}/im/me/weixin-binding/auto-link`, {
      method: "PUT",
      body: JSON.stringify({ userId }),
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
  getGroupTransportBinding(
    wsId: string,
    groupId: string
  ): Promise<{ binding: ConversationTransportBindingSummary | null }> {
    return this.fetch(
      `/workspaces/${wsId}/chat/groups/${groupId}/transport-binding`
    )
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
  setTransportExternalUserWorkspaceUser(
    wsId: string,
    addressId: string,
    userId: string | null
  ): Promise<{ externalUser: TransportExternalUserSummary }> {
    return this.fetch(
      `/workspaces/${wsId}/im/external-users/${addressId}/workspace-user`,
      {
        method: "PUT",
        body: JSON.stringify({ userId }),
      }
    )
  }
  markGroupRead(wsId: string, groupId: string) {
    return this.fetch(`/workspaces/${wsId}/chat/groups/${groupId}/read`, {
      method: "POST",
      body: "{}",
    })
  }
  cancelGroup(wsId: string, groupId: string) {
    return this.fetch(`/workspaces/${wsId}/chat/groups/${groupId}`, {
      method: "DELETE",
    })
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
      attachmentType:
        | "workspace"
        | "conversation"
        | "actor_global"
        | "actor_conversation"
        | "user"
      actorId?: string
      conversationId?: string
      userId?: string
      lifecycleScope?:
        | "turn"
        | "workspace"
        | "conversation"
        | "actor_global"
        | "actor_conversation"
        | "user"
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
  getPluginInstallationAccess(wsId: string, installId: string) {
    return this.fetch(
      `/workspaces/${wsId}/mcp/installations/${installId}/access`
    )
  }
  grantPluginInstallationAccess(
    wsId: string,
    installId: string,
    data: {
      grantScope?:
        | "workspace"
        | "conversation"
        | "actor_global"
        | "actor_conversation"
        | "user"
      conversationId?: string
      actorId?: string
      userId?: string
      permissions?: string[]
      reason?: string
      metadata?: Record<string, unknown>
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

  // MCP Relays
  getRelayDashboard(wsId: string): Promise<RelayDashboardView> {
    return this.fetch(`/workspaces/${wsId}/mcp/relays`)
  }
  createRelayPairingSession(
    wsId: string,
    data: { displayName?: string; metadata?: Record<string, unknown> }
  ): Promise<{ pairing: RelayPairingSessionView }> {
    return this.fetch(`/workspaces/${wsId}/mcp/relays/pairing-sessions`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  getRelayPairingSession(
    wsId: string,
    pairingId: string
  ): Promise<{ pairing: RelayPairingSessionView }> {
    return this.fetch(
      `/workspaces/${wsId}/mcp/relays/pairing-sessions/${pairingId}`
    )
  }
  cancelRelayPairingSession(
    wsId: string,
    pairingId: string
  ): Promise<{ pairing: RelayPairingSessionView }> {
    return this.fetch(
      `/workspaces/${wsId}/mcp/relays/pairing-sessions/${pairingId}/cancel`,
      { method: "POST", body: "{}" }
    )
  }
  claimRelayPairing(data: {
    pairingCode: string
    displayName?: string
    clientKind?: string
    platform?: string
    publicKey: string
    publicKeyFingerprint: string
    metadata?: Record<string, unknown>
  }) {
    return this.fetch("/mcp/relay/pairing/claim", {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  getRelayDevice(
    wsId: string,
    relayId: string
  ): Promise<RelayDeviceDetailView> {
    return this.fetch(`/workspaces/${wsId}/mcp/relays/${relayId}`)
  }
  getRelayExposureAccess(wsId: string, relayId: string, exposureId: string) {
    return this.fetch(
      `/workspaces/${wsId}/mcp/relays/${relayId}/exposures/${exposureId}/access`
    )
  }
  grantRelayExposureAccess(
    wsId: string,
    relayId: string,
    exposureId: string,
    data: {
      grantScope?:
        | "workspace"
        | "conversation"
        | "actor_global"
        | "actor_conversation"
        | "user"
      actorId?: string
      conversationId?: string
      userId?: string
      permissions?: string[]
      reason?: string
      metadata?: Record<string, unknown>
    }
  ) {
    return this.fetch(
      `/workspaces/${wsId}/mcp/relays/${relayId}/exposures/${exposureId}/access`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
  }
  revokeRelayExposureAccess(
    wsId: string,
    relayId: string,
    exposureId: string,
    bindingId: string
  ) {
    return this.fetch(
      `/workspaces/${wsId}/mcp/relays/${relayId}/exposures/${exposureId}/access/${bindingId}`,
      {
        method: "DELETE",
      }
    )
  }
  updateRelayDevice(
    wsId: string,
    relayId: string,
    data: { displayName: string; metadata?: Record<string, unknown> }
  ): Promise<RelayDeviceSummaryView> {
    return this.fetch(`/workspaces/${wsId}/mcp/relays/${relayId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  disconnectRelayDevice(wsId: string, relayId: string) {
    return this.fetch(`/workspaces/${wsId}/mcp/relays/${relayId}/disconnect`, {
      method: "POST",
      body: "{}",
    })
  }
  updateRelayTrustStatus(
    wsId: string,
    relayId: string,
    trustStatus: "active" | "revoked" | "blocked"
  ): Promise<{ device: RelayDeviceSummaryView }> {
    return this.fetch(
      `/workspaces/${wsId}/mcp/relays/${relayId}/trust-status`,
      {
        method: "POST",
        body: JSON.stringify({ trustStatus }),
      }
    )
  }
  deleteRelayDevice(wsId: string, relayId: string) {
    return this.fetch(`/workspaces/${wsId}/mcp/relays/${relayId}`, {
      method: "DELETE",
    })
  }

  // Automation Event Sources
  getAutomationEventSources(
    wsId: string,
    filters?: {
      status?: "active" | "deprecated" | "disabled" | "archived"
      providerKind?: "relay" | "webhook" | "internal"
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
      providerKind: "relay" | "webhook" | "internal"
      providerRef?: string
      sourceKey?: string
      name: string
      description: string
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
      ownerSessionId?: string
    }
  ): Promise<AutomationRule[]> {
    const params = new URLSearchParams()
    if (filters?.status) params.set("status", filters.status)
    if (filters?.category) params.set("category", filters.category)
    if (filters?.ownerSessionId)
      params.set("ownerSessionId", filters.ownerSessionId)
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
  async uploadFile(wsId: string, file: File) {
    const formData = new FormData()
    formData.append("file", file)
    const res = await fetch(`${API_BASE}/workspaces/${wsId}/files`, {
      method: "POST",
      body: formData,
      credentials: "include",
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || "Upload failed")
    }
    return res.json()
  }
  getFileInfo(fileId: string): Promise<FileRecordView> {
    return this.fetch(`/files/${fileId}/info`)
  }

  // A2A Apps
  getA2AApps(wsId: string) {
    return this.fetch(`/workspaces/${wsId}/a2a/apps`)
  }
  createA2AApp(
    wsId: string,
    data: {
      name: string
      description?: string
      actorIds: string[]
      rateLimitRpm?: number
    }
  ) {
    return this.fetch(`/workspaces/${wsId}/a2a/apps`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  }
  getA2AApp(wsId: string, appId: string) {
    return this.fetch(`/workspaces/${wsId}/a2a/apps/${appId}`)
  }
  updateA2AApp(wsId: string, appId: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/a2a/apps/${appId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }
  deleteA2AApp(wsId: string, appId: string) {
    return this.fetch(`/workspaces/${wsId}/a2a/apps/${appId}`, {
      method: "DELETE",
    })
  }
  regenerateA2AAppKey(wsId: string, appId: string) {
    return this.fetch(`/workspaces/${wsId}/a2a/apps/${appId}/regenerate-key`, {
      method: "POST",
      body: "{}",
    })
  }
}

export const api = new ApiClient()
