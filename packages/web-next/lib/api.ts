import type {
  ActorTemplateCloneResult,
  AuthResponse,
  AuthSessionSummary,
  ActorTemplateRecord,
  CanonicalContentBlock,
  ConversationFeedItem,
  ConversationFeedPage,
  InstalledSkill,
  WorkspaceFeedPage,
  RelayDashboardView,
  RelayDeviceDetailView,
  RelayDeviceSummaryView,
  RelayPairingSessionView,
  SkillMarketplaceEntry,
  SkillUseScope,
} from "@synapse/shared"

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
    name: string
  ): Promise<AuthResponse> {
    return this.fetch("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        name,
        clientType: "web",
        transport: "cookie",
      }),
    })
  }
  login(email: string, password: string): Promise<AuthResponse> {
    return this.fetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        clientType: "web",
        transport: "cookie",
      }),
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
  updateMe(data: { name?: string; avatarUrl?: string | null }) {
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
        | "capability_admin"
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
      | "capability_admin"
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
  getSkillMarketplace(params?: string): Promise<{ skills: SkillMarketplaceEntry[] }> {
    return this.fetch(`/skills/marketplace${params ? "?" + params : ""}`)
  }
  getSkillMarketplaceItem(skillId: string): Promise<{ skill: SkillMarketplaceEntry }> {
    return this.fetch(`/skills/marketplace/${skillId}`)
  }
  publishMarketplaceSkill(data: {
    skillId?: string
    slug: string
    name: string
    summary?: string
    iconUrl?: string
    tags?: string[]
    version: string
    entryPath?: string
    changelog?: string
    isActive?: boolean
    metadata?: Record<string, unknown>
    files: Array<{
      path: string
      contentBlocks: CanonicalContentBlock[]
    }>
  }): Promise<{ skill: SkillMarketplaceEntry }> {
    return this.fetch("/skills/marketplace", {
      method: "POST",
      body: JSON.stringify(data),
    })
  }

  // Installed Skills
  getInstalledSkills(wsId: string, params?: string): Promise<{ skills: InstalledSkill[] }> {
    return this.fetch(`/workspaces/${wsId}/skills${params ? "?" + params : ""}`)
  }
  getInstalledSkill(wsId: string, installedSkillId: string): Promise<{ skill: InstalledSkill }> {
    return this.fetch(`/workspaces/${wsId}/skills/${installedSkillId}`)
  }
  installSkill(
    wsId: string,
    data: {
      marketSkillId: string
      useScope: SkillUseScope
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
      summary?: string
      iconUrl?: string | null
      tags?: string[]
      entryPath?: string
      useScope?: SkillUseScope
      actorId?: string | null
      conversationId?: string | null
      userId?: string | null
      isEnabled?: boolean
      files?: Array<{
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
  upgradeInstalledSkill(wsId: string, installedSkillId: string): Promise<{ skill: InstalledSkill }> {
    return this.fetch(`/workspaces/${wsId}/skills/${installedSkillId}/upgrade`, {
      method: "POST",
      body: "{}",
    })
  }
  uninstallInstalledSkill(wsId: string, installedSkillId: string) {
    return this.fetch(`/workspaces/${wsId}/skills/${installedSkillId}`, {
      method: "DELETE",
    })
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
  getActorTemplates(
    wsId: string,
    search?: string
  ): Promise<ActorTemplateRecord[]> {
    const params = search ? `?search=${encodeURIComponent(search)}` : ""
    return this.fetch(`/workspaces/${wsId}/actors/templates${params}`)
  }
  getActorTemplate(
    wsId: string,
    templateId: string
  ): Promise<ActorTemplateRecord> {
    return this.fetch(`/workspaces/${wsId}/actors/templates/${templateId}`)
  }
  cloneActorTemplate(
    wsId: string,
    templateId: string,
    data?: {
      name?: string
      title?: string
      parentId?: string | null
      syncMode?: "notify" | "manual_merge"
    }
  ): Promise<ActorTemplateCloneResult> {
    return this.fetch(
      `/workspaces/${wsId}/actors/templates/${templateId}/clone`,
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

  // Secretary
  sendMessage(wsId: string, content: string) {
    return this.fetch(`/workspaces/${wsId}/secretary/message`, {
      method: "POST",
      body: JSON.stringify({ content }),
    })
  }
  getConversation(wsId: string) {
    return this.fetch(`/workspaces/${wsId}/secretary/conversation`)
  }
  clearConversation(wsId: string) {
    return this.fetch(`/workspaces/${wsId}/secretary/conversation`, {
      method: "DELETE",
    })
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
    targetActorId?: string
  ) {
    const body: any =
      actorIds.length === 1
        ? { actorId: actorIds[0], ...(content && { content }) }
        : {
            actorIds,
            ...(content && { content }),
            targetActorId: targetActorId || actorIds[0],
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
    targetActorIds?: string[],
    targetUserIds?: string[]
  ): Promise<{ item: ConversationFeedItem }> {
    const body: any = { contentBlocks }
    if (targetActorIds && targetActorIds.length > 0)
      body.targetActorIds = targetActorIds
    if (targetUserIds && targetUserIds.length > 0)
      body.targetUserIds = targetUserIds
    body.clientMessageId = clientMessageId
    return this.fetch(`/workspaces/${wsId}/chat/groups/${groupId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    })
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
  startPluginAuth(wsId: string, pluginId: string, providerKey: string) {
    return this.fetch(
      `/workspaces/${wsId}/mcp/plugins/${pluginId}/auth/${providerKey}/start`,
      { method: "POST", body: "{}" }
    )
  }
  getPluginAuthSession(wsId: string, sessionId: string) {
    return this.fetch(`/workspaces/${wsId}/mcp/auth/sessions/${sessionId}`)
  }
  getCapabilityInstanceGrants(wsId: string, instanceId: string) {
    return this.fetch(
      `/workspaces/${wsId}/capabilities/instances/${instanceId}/grants`
    )
  }
  getCapabilityInstanceAuthorization(
    wsId: string,
    instanceId: string,
    params?: string
  ) {
    return this.fetch(
      `/workspaces/${wsId}/capabilities/instances/${instanceId}/authorization${params ? `?${params}` : ""}`
    )
  }
  issueCapabilityInstanceGrant(
    wsId: string,
    instanceId: string,
    data: {
      grantScope?:
        | "platform"
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
      `/workspaces/${wsId}/capabilities/instances/${instanceId}/grants`,
      { method: "POST", body: JSON.stringify(data) }
    )
  }
  revokeCapabilityGrant(wsId: string, grantId: string) {
    return this.fetch(`/workspaces/${wsId}/capabilities/grants/${grantId}`, {
      method: "DELETE",
    })
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
