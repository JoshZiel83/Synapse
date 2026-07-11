import { FILE_ORIGIN_SYSTEMS } from "@synapse/shared/constants"
import {
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
  WORKSPACE_RESOURCE_KIND,
} from "@synapse/shared"
import type {
  DeviceListView,
  DeviceDetailView,
  DeviceServiceView,
  DeviceCapabilityView,
  DevicePairingTicketView,
  MarketplacePluginView,
  PluginAuditLogList,
  ModelGroupView,
  ModelGroupListView,
  ModelGroupDetailView,
  ModelGroupGrantView,
  ModelGroupGrantListView,
  ModelGroupItemView,
  ModelGroupItemVersionListView,
  ActorModelGroupAssignmentListView,
  WorkspaceInviteView,
  WorkspaceInviteListView,
  WorkspaceInvitePublicView,
  WorkspaceInviteRedeemResult,
  WorkspaceNavigationView,
  WorkspaceMemberListView,
  WorkspaceAccessBindingListView,
  WorkspaceAccessBindingView,
  Actor,
  ActorRuntimeTurnActivityDetail,
  CapabilityAccessTarget,
  AuthResponse,
  AutomationEventSource,
  AutomationEventSourceListSchemaType,
  AutomationExecution,
  AutomationExecutionListSchemaType,
  AutomationOccurrence,
  AutomationOccurrenceListSchemaType,
  AutomationRule,
  AutomationRuleListSchemaType,
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
  WorkspaceChiefActorPreference,
  WorkspaceListView,
  WorkspaceResourceGrant,
  WorkspaceCapabilityConversationTypePoliciesView,
  UpdateMeInput,
  UpdateMemberRelationshipProfileInput,
  UpdateActorRelationshipProfileInput,
  BindRemoteAgentInput,
  CreateRemoteAgentMachineInput,
  UpdateRemoteAgentGroupTaskGrantsInput,
  StartPluginAuthInput,
  TrustLevel,
  WorkspaceResourceSuccessViewSchemaType,
} from "@synapse/shared"
import {
  normalizeConversationCatalogEntry,
  type ConversationCatalogEntry,
} from "@synapse/shared"
import { isChatTaskResolveConflictResponse } from "@synapse/shared"
import {
  type ChatTaskResolvePayload,
  type FileRecordView,
} from "@synapse/shared/types"
import type {
  ActorPackageInstallInput,
  AutomationEventSourceCreateInput,
  AutomationEventSourceListQuery,
  AutomationEventSourceUpdateInput,
  AutomationRuleCreateInput,
  AutomationRuleListQuery,
  AutomationRuleUpdateInput,
  AutomationSuccessSchemaType,
  ActorModelGroupSetInput,
  ActorPackageInstallResultView,
  ActorPackageListView,
  ActorPackageListQuery,
  ActorPackageRecordView,
  ActorTreeView,
  ActorVersionListView,
  CreateManualRuntimeAuthorizationGrantInput,
  CreateMemoryInputBody,
  CreateWorkspaceResourceInput,
  CreateWorkspaceInviteInput,
  DingtalkDeviceFlowStartInput,
  DingtalkDeviceFlowStartResponseSchemaType,
  DingtalkDeviceFlowPollResponseSchemaType,
  DingtalkManualAccountCreateInput,
  FileUploadOriginInput,
  ImportMarketplaceSkillInput,
  InstalledSkillItemView,
  InstalledSkillListQuery,
  InstalledSkillListView,
  McpMarketplaceListQuery,
  McpPluginEventAuditLogListQuery,
  McpPluginInstallationListQuery,
  McpPluginToolCallAuditLogListQuery,
  MemoryItemEnvelopeView,
  MemoryListQuery,
  MemoryListView,
  MemoryMoveResultView,
  MarketplacePluginListView,
  MarketplacePublisherDetailView,
  MarketplacePublisherListView,
  ModelGroupCreateInput,
  ModelGroupGrantIssueInput,
  ModelGroupItemCreateInput,
  ModelGroupItemUpdateInput,
  ModelGroupUpdateInput,
  MoveMemoryInput,
  PublishMarketplaceSkillInput,
  PlatformAccessBindingListView,
  PlatformAccessBindingView,
  PlatformAccessGrantInput,
  PlatformNavigationView,
  PluginCategoryListView,
  PluginInstallationDetailView,
  PluginInstallationListView,
  ReplaceWorkspaceResourceGrantsInput,
  RemoteAgentGroupTaskGrantsResponseSchemaType,
  RemoteAgentListResponseSchemaType,
  RemoteAgentMachineListResponseSchemaType,
  RemoteAgentResponseSchemaType,
  RuntimeAuthorizationGrantRecordView,
  SkillMarketplaceItemView,
  SkillMarketplaceItemQuery,
  SkillMarketplaceListView,
  SkillMarketplaceListQuery,
  StartPairingInput,
  TransportAccountResponseSchemaType,
  TransportAccountCreateInput,
  TransportAccountUpdateInput,
  TransportAccountsResponseSchemaType,
  TransportConnectorsResponseSchemaType,
  TransportExternalUserResponseSchemaType,
  TransportExternalUserLinkedMemberInput,
  TransportExternalUsersResponseSchemaType,
  TransportExternalUsersListQuery,
  TransportFeishuAccountCreateInput,
  TransportFeishuAccountUpdateInput,
  TransportQqAccountCreateInput,
  TransportQqAccountUpdateInput,
  TransportSessionResponseSchemaType,
  TransportSessionsResponseSchemaType,
  TransportSessionSettingsInput,
  TransportTelegramAccountCreateInput,
  TransportTelegramAccountUpdateInput,
  TransportWecomAccountCreateInput,
  TransportWecomAccountUpdateInput,
  TransportWhatsappAccountCreateInput,
  TransportWhatsappAccountUpdateInput,
  WhatsappUnofficialLoginStartInput,
  WeixinBindingAutoLinkInput,
  WeixinBindingCandidatesResponseSchemaType,
  WeixinBindingResponseSchemaType,
  WeixinQrSessionCreateInput,
  WeixinQrSessionResponseSchemaType,
  UpdateMemoryInputBody,
  WorkspaceAccessGrantInput,
  WorkspaceResourceGrantListViewSchemaType,
  WorkspaceCapabilityConversationTypePolicyUpdateInput,
  WorkspaceChiefActorPreferenceInput,
  WorkspaceCreateInput,
  UpdateWorkspaceResourceInput,
} from "@synapse/shared/schemas"
import {
  StoredFileRecordViewSchema,
  type StoredFileRecordView,
  WorkspaceResourceGrantEntrySchema,
} from "@synapse/shared/schemas"

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
  RemoteAgentAccessRequestListResponse,
  RemoteAgentBindingView,
  RemoteAgentGroupTaskGrantView,
  RemoteAgentGroupTaskGrantsResponseSchemaType,
  RemoteAgentLifecycleState,
  RemoteAgentMachineDetailView,
  RemoteAgentMachineListResponseSchemaType,
  RemoteAgentMachinePairingSessionView,
  RemoteAgentMachineTrustStatus,
  RemoteAgentMachineView,
  RemoteAgentResponseSchemaType,
  RemoteAgentRuntimeCapabilityView,
  RemoteAgentRuntimeCatalogEntryView,
  RemoteAgentRuntimeKind,
  RemoteAgentRuntimeSummaryView,
  RemoteAgentView,
  TrustLevel,
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

export type ContactHubEntryKind = ContactHubKind
export type RemoteAgentRuntimeStatus = RemoteAgentRuntimeCatalogStatus

type WorkspaceResourceGrantEntryInput =
  ReplaceWorkspaceResourceGrantsInput["grants"][number]
type WorkspaceResourceGrantEntryLike = Omit<
  WorkspaceResourceGrantEntryInput,
  "target" | "permissions"
> & {
  target: CapabilityAccessTarget
  permissions: string[]
}

type WorkspaceResourceCreateActorInput = Omit<
  Extract<
    CreateWorkspaceResourceInput,
    { kind: typeof WORKSPACE_RESOURCE_KIND.ACTOR }
  >,
  "kind" | "grants"
> & { grants?: WorkspaceResourceGrantEntryLike[] }
type WorkspaceResourceUpdateActorInput = Omit<
  Extract<
    UpdateWorkspaceResourceInput,
    { kind: typeof WORKSPACE_RESOURCE_KIND.ACTOR }
  >,
  "kind"
>
type WorkspaceResourceCreateRemoteAgentInput = Omit<
  Extract<
    CreateWorkspaceResourceInput,
    { kind: typeof WORKSPACE_RESOURCE_KIND.REMOTE_AGENT }
  >,
  "kind" | "grants"
> & { grants?: WorkspaceResourceGrantEntryLike[] }
type WorkspaceResourceUpdateRemoteAgentInput = Omit<
  Extract<
    UpdateWorkspaceResourceInput,
    { kind: typeof WORKSPACE_RESOURCE_KIND.REMOTE_AGENT }
  >,
  "kind"
>
type WorkspaceResourceCreatePluginInstallationInput = Omit<
  Extract<
    CreateWorkspaceResourceInput,
    { kind: typeof WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION }
  >,
  "kind" | "grants"
> & { grants?: WorkspaceResourceGrantEntryLike[] }
type WorkspaceResourceUpdatePluginInstallationInput = Omit<
  Extract<
    UpdateWorkspaceResourceInput,
    { kind: typeof WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION }
  >,
  "kind"
>

function parseWorkspaceResourceGrantEntry(
  grant: WorkspaceResourceGrantEntryLike
): WorkspaceResourceGrantEntryInput {
  return WorkspaceResourceGrantEntrySchema.parse(grant)
}

function parseWorkspaceResourceGrantEntries(
  grants: WorkspaceResourceGrantEntryLike[] | undefined
) {
  return grants?.map(parseWorkspaceResourceGrantEntry)
}

function parseFileUploadResponseData(value: unknown): StoredFileRecordView {
  if (!value || typeof value !== "object" || !("data" in value)) {
    throw new Error("Malformed upload response")
  }
  return StoredFileRecordViewSchema.parse((value as { data: unknown }).data)
}

type QueryValue = string | number | readonly string[] | undefined | null
type MemoryListQueryParams = Omit<MemoryListQuery, "owner" | "scope">

// Request input types for the telegram / whatsapp / whatsapp_unofficial
// connectors are single-sourced from @synapse/shared (imported above), like
// the other connectors. Only the whatsapp_unofficial login-session + session-
// guard RESPONSE shapes stay declared here — the backend keeps those schemas
// controller-local (epoch-ms expiresAt / runtime kill-switch state).
export type WhatsappUnofficialLoginSession = {
  sessionId: string
  status: string
  qrDataUrl?: string
  pairingCode?: string
  transportAccountId?: string
  errorMessage?: string
  /** epoch milliseconds */
  expiresAt: number
}

export type WhatsappUnofficialLoginSessionResponse = {
  session: WhatsappUnofficialLoginSession
}

export type WhatsappUnofficialSessionGuardInput = {
  accountId: string
  paused: boolean
  ttlSeconds?: number
}

export type WhatsappUnofficialSessionGuardResponse = {
  accountId: string
  paused: boolean
  reason: string | null
  remainingMs: number
}

function withQuery<TQuery extends Record<string, QueryValue>>(
  path: string,
  query?: TQuery
) {
  if (!query) return path

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      const joined = value
        .map((item) => item.trim())
        .filter(Boolean)
        .join(",")
      if (joined) params.set(key, joined)
      continue
    }
    const text = String(value).trim()
    if (text) params.set(key, text)
  }

  const queryString = params.toString()
  return queryString ? `${path}?${queryString}` : path
}

class ApiClient {
  private async fetch<T = any>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
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

    if (res.status === 204) return null as T

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

    return data as T
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
  async getMe() {
    const res = await this.fetch("/auth/me")
    return res.data
  }
  async updateMe(data: UpdateMeInput) {
    const res = await this.fetch("/auth/me", {
      method: "PUT",
      body: JSON.stringify(data),
    })
    return res.data
  }

  // Workspaces
  async getWorkspaces(): Promise<WorkspaceListView> {
    const res = await this.fetch("/workspaces")
    return res.data
  }
  async createWorkspace(name: string, description?: string) {
    const body: WorkspaceCreateInput =
      description === undefined ? { name } : { name, description }
    const res = await this.fetch("/workspaces", {
      method: "POST",
      body: JSON.stringify(body),
    })
    return res.data
  }
  async getWorkspace(id: string) {
    const res = await this.fetch(`/workspaces/${id}`)
    return res.data
  }
  async getWorkspaceMembers(wsId: string): Promise<WorkspaceMemberListView> {
    const res = await this.fetch(`/workspaces/${wsId}/members`)
    return res.data
  }
  async getWorkspaceNavigation(wsId: string): Promise<WorkspaceNavigationView> {
    const res = await this.fetch(`/workspaces/${wsId}/navigation`)
    return res.data
  }
  async getWorkspaceChiefActorPreference(
    wsId: string
  ): Promise<WorkspaceChiefActorPreference> {
    const res = await this.fetch(`/workspaces/${wsId}/preferences/chief-actor`)
    return res.data
  }
  async updateWorkspaceChiefActorPreference(
    wsId: string,
    data: WorkspaceChiefActorPreferenceInput
  ): Promise<WorkspaceChiefActorPreference> {
    const res = await this.fetch(
      `/workspaces/${wsId}/preferences/chief-actor`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async getWorkspaceAccess(
    wsId: string
  ): Promise<WorkspaceAccessBindingListView> {
    const res = await this.fetch(`/workspaces/${wsId}/access`)
    return res.data
  }
  async getWorkspaceCapabilityConversationTypePolicies(
    wsId: string
  ): Promise<WorkspaceCapabilityConversationTypePoliciesView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/capability-conversation-type-policies`
    )
    return res.data
  }
  async updateWorkspaceCapabilityConversationTypePolicies(
    wsId: string,
    data: WorkspaceCapabilityConversationTypePolicyUpdateInput
  ): Promise<WorkspaceCapabilityConversationTypePoliciesView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/capability-conversation-type-policies`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async grantWorkspaceAccess(
    wsId: string,
    data: WorkspaceAccessGrantInput
  ): Promise<WorkspaceAccessBindingView> {
    const res = await this.fetch(`/workspaces/${wsId}/access`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  async revokeWorkspaceAccess(
    wsId: string,
    workspaceMemberId: string,
    accessKey: WorkspaceAccessGrantInput["accessKey"]
  ): Promise<WorkspaceAccessBindingView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/access/${accessKey}/members/${workspaceMemberId}/revoke`,
      { method: "POST", body: "{}" }
    )
    return res.data
  }

  // Platform Access
  async getPlatformNavigation(): Promise<PlatformNavigationView> {
    const res = await this.fetch("/platform/navigation")
    return res.data
  }
  async getPlatformAccess(): Promise<PlatformAccessBindingListView> {
    const res = await this.fetch("/platform/access")
    return res.data
  }
  async grantPlatformAccess(
    data: PlatformAccessGrantInput
  ): Promise<PlatformAccessBindingView> {
    const res = await this.fetch("/platform/access", {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  revokePlatformAccess(
    userId: string,
    accessKey: PlatformAccessGrantInput["accessKey"]
  ) {
    return this.fetch(`/platform/access/${accessKey}/users/${userId}/revoke`, {
      method: "POST",
      body: "{}",
    })
  }

  // Skills Marketplace
  getSkillMarketplace(
    options?: SkillMarketplaceListQuery
  ): Promise<SkillMarketplaceListView> {
    const params = new URLSearchParams()
    if (options?.search) params.set("search", options.search)
    if (typeof options?.tags === "string") {
      params.set("tags", options.tags)
    } else if (options?.tags?.length) {
      params.set("tags", options.tags.join(","))
    }
    if (options?.workspaceId) params.set("workspaceId", options.workspaceId)
    const qs = params.toString()
    return this.fetch(`/skills/marketplace${qs ? "?" + qs : ""}`).then(
      (res) => res.data
    )
  }
  getSkillMarketplaceItem(
    skillId: string,
    workspaceId?: SkillMarketplaceItemQuery["workspaceId"]
  ): Promise<SkillMarketplaceItemView> {
    const params = new URLSearchParams()
    if (workspaceId) params.set("workspaceId", workspaceId)
    const qs = params.toString()
    return this.fetch(
      `/skills/marketplace/${skillId}${qs ? "?" + qs : ""}`
    ).then((res) => res.data)
  }
  publishMarketplaceSkill(
    data: PublishMarketplaceSkillInput
  ): Promise<SkillMarketplaceItemView> {
    return this.fetch("/skills/marketplace", {
      method: "POST",
      body: JSON.stringify(data),
    }).then((res) => res.data)
  }
  importMarketplaceSkill(
    data: ImportMarketplaceSkillInput
  ): Promise<SkillMarketplaceItemView> {
    return this.fetch("/skills/marketplace/import", {
      method: "POST",
      body: JSON.stringify(data),
    }).then((res) => res.data)
  }
  refreshMarketplaceSkill(skillId: string): Promise<SkillMarketplaceItemView> {
    return this.fetch(`/skills/marketplace/${skillId}/refresh`, {
      method: "POST",
      body: "{}",
    }).then((res) => res.data)
  }
  async createWorkspaceSkill(
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
  ): Promise<InstalledSkillItemView> {
    const body: CreateWorkspaceResourceInput = {
      kind: WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL,
      sourceType: "custom",
      displayName: data.name,
      description: data.description,
      iconFileId: data.iconFileId,
      tags: data.tags,
      attachmentFiles: data.attachmentFiles,
      grants: [
        parseWorkspaceResourceGrantEntry({
          target: data.accessTarget,
          permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.USE],
        }),
      ],
    }
    const created = await this.fetch(
      `/workspaces/${wsId}/workspace-resources`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    )
    return {
      skill: await this.getInstalledSkill(wsId, created.data.resource.id).then(
        (res) => res.skill
      ),
    }
  }

  // Skills
  getInstalledSkills(
    wsId: string,
    query?: InstalledSkillListQuery
  ): Promise<InstalledSkillListView> {
    return this.fetch(withQuery(`/workspaces/${wsId}/skills`, query)).then(
      (res) => res.data
    )
  }
  getInstalledSkill(
    wsId: string,
    installedSkillId: string
  ): Promise<InstalledSkillItemView> {
    return this.fetch(`/workspaces/${wsId}/skills/${installedSkillId}`).then(
      (res) => res.data
    )
  }
  async installSkill(
    wsId: string,
    data: {
      marketSkillId: string
      accessTarget: CapabilityAccessTarget
    }
  ): Promise<InstalledSkillItemView> {
    const body: CreateWorkspaceResourceInput = {
      kind: WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL,
      sourceType: "marketplace",
      marketSkillId: data.marketSkillId,
      grants: [
        parseWorkspaceResourceGrantEntry({
          target: data.accessTarget,
          permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.USE],
        }),
      ],
    }
    const created = await this.fetch(
      `/workspaces/${wsId}/workspace-resources`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    )
    return {
      skill: await this.getInstalledSkill(wsId, created.data.resource.id).then(
        (res) => res.skill
      ),
    }
  }
  async updateInstalledSkill(
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
  ): Promise<InstalledSkillItemView> {
    const body: UpdateWorkspaceResourceInput = {
      kind: WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL,
      displayName: data.name,
      description: data.description,
      iconFileId: data.iconFileId,
      tags: data.tags,
      isEnabled: data.isEnabled,
      conversationTypeMaskOverride: data.conversationTypeMaskOverride,
      attachmentFiles: data.attachmentFiles,
    }
    await this.fetch(
      `/workspaces/${wsId}/workspace-resources/${installedSkillId}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      }
    )
    return {
      skill: await this.getInstalledSkill(wsId, installedSkillId).then(
        (res) => res.skill
      ),
    }
  }
  upgradeInstalledSkill(
    wsId: string,
    installedSkillId: string
  ): Promise<InstalledSkillItemView> {
    return this.fetch(
      `/workspaces/${wsId}/skills/${installedSkillId}/upgrade`,
      {
        method: "POST",
        body: "{}",
      }
    ).then((res) => res.data)
  }
  async uninstallInstalledSkill(
    wsId: string,
    installedSkillId: string
  ): Promise<WorkspaceResourceSuccessViewSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/workspace-resources/${installedSkillId}`,
      {
        method: "DELETE",
      }
    )
    return res.data
  }
  async getWorkspaceResourceGrants(
    wsId: string,
    resourceId: string
  ): Promise<WorkspaceResourceGrantListViewSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/workspace-resources/${resourceId}/grants`
    )
    return res.data
  }
  async replaceWorkspaceResourceGrants(
    wsId: string,
    resourceId: string,
    data: { grants: WorkspaceResourceGrantEntryLike[] }
  ): Promise<WorkspaceResourceGrantListViewSchemaType> {
    const body: ReplaceWorkspaceResourceGrantsInput = {
      grants: data.grants.map(parseWorkspaceResourceGrantEntry),
    }
    const res = await this.fetch(
      `/workspaces/${wsId}/workspace-resources/${resourceId}/grants`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      }
    )
    return res.data
  }

  // Workspace Invites
  async getInviteInfo(token: string): Promise<WorkspaceInvitePublicView> {
    const res = await this.fetch(`/invites/${token}`)
    return res.data
  }
  async redeemInvite(token: string): Promise<WorkspaceInviteRedeemResult> {
    const res = await this.fetch(`/invites/${token}/redeem`, {
      method: "POST",
      body: "{}",
    })
    return res.data
  }
  async createInvite(
    wsId: string,
    data: CreateWorkspaceInviteInput
  ): Promise<WorkspaceInviteView> {
    const res = await this.fetch(`/workspaces/${wsId}/invites`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  async listInvites(wsId: string): Promise<WorkspaceInviteListView> {
    const res = await this.fetch(`/workspaces/${wsId}/invites`)
    return res.data
  }
  async revokeInvite(
    wsId: string,
    inviteId: string
  ): Promise<WorkspaceInviteView> {
    const res = await this.fetch(`/workspaces/${wsId}/invites/${inviteId}`, {
      method: "DELETE",
    })
    return res.data
  }

  // Actors
  async getActors(wsId: string): Promise<Actor[]> {
    const res = (await this.fetch(`/workspaces/${wsId}/actors`)) as {
      data: Actor[]
    }
    return res.data
  }
  async getActor(wsId: string, actorId: string) {
    const res = await this.fetch(`/workspaces/${wsId}/actors/${actorId}`)
    return res.data
  }
  async getActorVersions(
    wsId: string,
    actorId: string
  ): Promise<ActorVersionListView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/actors/${actorId}/versions`
    )
    return res.data
  }
  async getActorPackages(
    wsId: string,
    search?: ActorPackageListQuery["search"]
  ): Promise<ActorPackageListView> {
    const params = search ? `?search=${encodeURIComponent(search)}` : ""
    const res = await this.fetch(`/workspaces/${wsId}/actors/packages${params}`)
    return res.data
  }
  async getActorPackage(
    wsId: string,
    packageId: string
  ): Promise<ActorPackageRecordView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/actors/packages/${packageId}`
    )
    return res.data
  }
  async installActorPackage(
    wsId: string,
    packageId: string,
    data?: ActorPackageInstallInput
  ): Promise<ActorPackageInstallResultView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/actors/packages/${packageId}/install`,
      {
        method: "POST",
        body: JSON.stringify(data || {}),
      }
    )
    return res.data
  }
  async getOrgTree(wsId: string): Promise<ActorTreeView> {
    const res = await this.fetch(`/workspaces/${wsId}/actors/tree`)
    return res.data
  }
  async createActor(
    wsId: string,
    data: WorkspaceResourceCreateActorInput
  ): Promise<Actor> {
    const { grants, ...rest } = data
    const body: CreateWorkspaceResourceInput = {
      kind: WORKSPACE_RESOURCE_KIND.ACTOR,
      ...rest,
      grants: parseWorkspaceResourceGrantEntries(grants),
    }
    const created = await this.fetch(
      `/workspaces/${wsId}/workspace-resources`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    )
    return this.getActor(wsId, created.data.resource.id)
  }
  async updateActor(
    wsId: string,
    actorId: string,
    data: WorkspaceResourceUpdateActorInput
  ): Promise<Actor> {
    const body: UpdateWorkspaceResourceInput = {
      kind: WORKSPACE_RESOURCE_KIND.ACTOR,
      ...data,
    }
    await this.fetch(`/workspaces/${wsId}/workspace-resources/${actorId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    })
    return this.getActor(wsId, actorId)
  }
  async deleteActor(
    wsId: string,
    actorId: string
  ): Promise<WorkspaceResourceSuccessViewSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/workspace-resources/${actorId}`,
      {
        method: "DELETE",
      }
    )
    return res.data
  }

  // Memories
  getMemories(
    wsId: string,
    query?: MemoryListQueryParams
  ): Promise<MemoryListView> {
    return this.fetch(withQuery(`/workspaces/${wsId}/memories`, query)).then(
      (res) => res.data
    )
  }
  getMemory(wsId: string, id: string): Promise<MemoryItemEnvelopeView> {
    return this.fetch(`/workspaces/${wsId}/memories/${id}`).then(
      (res) => res.data
    )
  }
  createMemory(
    wsId: string,
    data: CreateMemoryInputBody
  ): Promise<MemoryItemEnvelopeView> {
    return this.fetch(`/workspaces/${wsId}/memories`, {
      method: "POST",
      body: JSON.stringify(data),
    }).then((res) => res.data)
  }
  updateMemory(
    wsId: string,
    id: string,
    data: UpdateMemoryInputBody
  ): Promise<MemoryItemEnvelopeView> {
    return this.fetch(`/workspaces/${wsId}/memories/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }).then((res) => res.data)
  }
  deleteMemory(wsId: string, id: string) {
    return this.fetch(`/workspaces/${wsId}/memories/${id}`, {
      method: "DELETE",
    })
  }
  moveMemory(
    wsId: string,
    id: string,
    data: MoveMemoryInput
  ): Promise<MemoryMoveResultView> {
    return this.fetch(`/workspaces/${wsId}/memories/${id}/move`, {
      method: "POST",
      body: JSON.stringify(data),
    }).then((res) => res.data)
  }

  // Model Groups - Workspace
  async getModelGroups(wsId: string): Promise<ModelGroupListView> {
    const res = await this.fetch(`/workspaces/${wsId}/model-groups`)
    return res.data
  }
  async createModelGroup(
    wsId: string,
    data: ModelGroupCreateInput
  ): Promise<ModelGroupView> {
    const res = await this.fetch(`/workspaces/${wsId}/model-groups`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  async getModelGroup(
    wsId: string,
    groupId: string
  ): Promise<ModelGroupDetailView> {
    const res = await this.fetch(`/workspaces/${wsId}/model-groups/${groupId}`)
    return res.data
  }
  async updateModelGroup(
    wsId: string,
    groupId: string,
    data: ModelGroupUpdateInput
  ): Promise<ModelGroupDetailView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/model-groups/${groupId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  deleteModelGroup(wsId: string, groupId: string) {
    return this.fetch(`/workspaces/${wsId}/model-groups/${groupId}`, {
      method: "DELETE",
    })
  }
  async getModelGroupGrants(
    wsId: string,
    groupId: string
  ): Promise<ModelGroupGrantListView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/model-groups/${groupId}/grants`
    )
    return res.data
  }
  async issueModelGroupGrant(
    wsId: string,
    groupId: string,
    data: ModelGroupGrantIssueInput
  ): Promise<ModelGroupGrantView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/model-groups/${groupId}/grants`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  revokeModelGroupGrant(wsId: string, groupId: string, grantId: string) {
    return this.fetch(
      `/workspaces/${wsId}/model-groups/${groupId}/grants/${grantId}/revoke`,
      { method: "POST", body: "{}" }
    )
  }
  async addModelItem(
    wsId: string,
    groupId: string,
    data: ModelGroupItemCreateInput
  ): Promise<ModelGroupItemView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/model-groups/${groupId}/items`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async updateModelItem(
    wsId: string,
    groupId: string,
    itemId: string,
    data: ModelGroupItemUpdateInput
  ): Promise<ModelGroupItemView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/model-groups/${groupId}/items/${itemId}`,
      { method: "PUT", body: JSON.stringify(data) }
    )
    return res.data
  }
  deleteModelItem(wsId: string, groupId: string, itemId: string) {
    return this.fetch(
      `/workspaces/${wsId}/model-groups/${groupId}/items/${itemId}`,
      { method: "DELETE" }
    )
  }
  async getItemVersions(
    wsId: string,
    groupId: string,
    itemId: string
  ): Promise<ModelGroupItemVersionListView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/model-groups/${groupId}/items/${itemId}/versions`
    )
    return res.data
  }

  // Model Groups - Platform
  async getPlatformModelGroups(): Promise<ModelGroupListView> {
    const res = await this.fetch("/platform/model-groups")
    return res.data
  }
  async createPlatformModelGroup(
    data: ModelGroupCreateInput
  ): Promise<ModelGroupView> {
    const res = await this.fetch("/platform/model-groups", {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  async getPlatformModelGroup(groupId: string): Promise<ModelGroupDetailView> {
    const res = await this.fetch(`/platform/model-groups/${groupId}`)
    return res.data
  }
  async updatePlatformModelGroup(
    groupId: string,
    data: ModelGroupUpdateInput
  ): Promise<ModelGroupDetailView> {
    const res = await this.fetch(`/platform/model-groups/${groupId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
    return res.data
  }
  deletePlatformModelGroup(groupId: string) {
    return this.fetch(`/platform/model-groups/${groupId}`, { method: "DELETE" })
  }
  async getPlatformModelGroupGrants(
    groupId: string
  ): Promise<ModelGroupGrantListView> {
    const res = await this.fetch(`/platform/model-groups/${groupId}/grants`)
    return res.data
  }
  async issuePlatformModelGroupGrant(
    groupId: string,
    data: ModelGroupGrantIssueInput
  ): Promise<ModelGroupGrantView> {
    const res = await this.fetch(`/platform/model-groups/${groupId}/grants`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  revokePlatformModelGroupGrant(groupId: string, grantId: string) {
    return this.fetch(
      `/platform/model-groups/${groupId}/grants/${grantId}/revoke`,
      { method: "POST", body: "{}" }
    )
  }
  async addPlatformModelItem(
    groupId: string,
    data: ModelGroupItemCreateInput
  ): Promise<ModelGroupItemView> {
    const res = await this.fetch(`/platform/model-groups/${groupId}/items`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  async updatePlatformModelItem(
    groupId: string,
    itemId: string,
    data: ModelGroupItemUpdateInput
  ): Promise<ModelGroupItemView> {
    const res = await this.fetch(
      `/platform/model-groups/${groupId}/items/${itemId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  deletePlatformModelItem(groupId: string, itemId: string) {
    return this.fetch(`/platform/model-groups/${groupId}/items/${itemId}`, {
      method: "DELETE",
    })
  }
  async getPlatformItemVersions(
    groupId: string,
    itemId: string
  ): Promise<ModelGroupItemVersionListView> {
    const res = await this.fetch(
      `/platform/model-groups/${groupId}/items/${itemId}/versions`
    )
    return res.data
  }

  // Model Groups - Workspace Member
  async getWorkspaceMemberModelGroups(
    wsId: string
  ): Promise<ModelGroupListView> {
    const res = await this.fetch(`/workspaces/${wsId}/me/model-groups`)
    return res.data
  }
  async createWorkspaceMemberModelGroup(
    wsId: string,
    data: ModelGroupCreateInput
  ): Promise<ModelGroupView> {
    const res = await this.fetch(`/workspaces/${wsId}/me/model-groups`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  async getWorkspaceMemberModelGroup(
    wsId: string,
    groupId: string
  ): Promise<ModelGroupDetailView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/me/model-groups/${groupId}`
    )
    return res.data
  }
  async updateWorkspaceMemberModelGroup(
    wsId: string,
    groupId: string,
    data: ModelGroupUpdateInput
  ): Promise<ModelGroupDetailView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/me/model-groups/${groupId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  deleteWorkspaceMemberModelGroup(wsId: string, groupId: string) {
    return this.fetch(`/workspaces/${wsId}/me/model-groups/${groupId}`, {
      method: "DELETE",
    })
  }
  async getWorkspaceMemberModelGroupGrants(
    wsId: string,
    groupId: string
  ): Promise<ModelGroupGrantListView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/me/model-groups/${groupId}/grants`
    )
    return res.data
  }
  async issueWorkspaceMemberModelGroupGrant(
    wsId: string,
    groupId: string,
    data: ModelGroupGrantIssueInput
  ): Promise<ModelGroupGrantView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/me/model-groups/${groupId}/grants`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
    return res.data
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
  async addWorkspaceMemberModelItem(
    wsId: string,
    groupId: string,
    data: ModelGroupItemCreateInput
  ): Promise<ModelGroupItemView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/me/model-groups/${groupId}/items`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async updateWorkspaceMemberModelItem(
    wsId: string,
    groupId: string,
    itemId: string,
    data: ModelGroupItemUpdateInput
  ): Promise<ModelGroupItemView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/me/model-groups/${groupId}/items/${itemId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
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
  async getWorkspaceMemberItemVersions(
    wsId: string,
    groupId: string,
    itemId: string
  ): Promise<ModelGroupItemVersionListView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/me/model-groups/${groupId}/items/${itemId}/versions`
    )
    return res.data
  }

  // Actor Model Group Assignment
  async getActorModelGroups(
    wsId: string,
    actorId: string
  ): Promise<ActorModelGroupAssignmentListView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/actors/${actorId}/model-groups`
    )
    return res.data
  }
  async getVisibleActorModelGroups(
    wsId: string,
    actorId: string
  ): Promise<ModelGroupListView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/actors/${actorId}/model-groups/visible`
    )
    return res.data
  }
  async setActorModelGroups(
    wsId: string,
    actorId: string,
    groups: ActorModelGroupSetInput["groups"]
  ): Promise<ActorModelGroupAssignmentListView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/actors/${actorId}/model-groups`,
      {
        method: "PUT",
        body: JSON.stringify({ groups }),
      }
    )
    return res.data
  }

  async getMyRelationshipProfile(
    wsId: string
  ): Promise<RelationshipProfileView> {
    const res = await this.fetch(`/workspaces/${wsId}/me/relationship-profile`)
    return res.data
  }
  async updateMyRelationshipProfile(
    wsId: string,
    input: UpdateMemberRelationshipProfileInput
  ): Promise<RelationshipProfileView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/me/relationship-profile`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      }
    )
    return res.data
  }
  async getActorRelationshipProfile(
    wsId: string,
    actorId: string
  ): Promise<RelationshipProfileView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/actors/${actorId}/relationship-profile`
    )
    return res.data
  }
  async updateActorRelationshipProfile(
    wsId: string,
    actorId: string,
    input: UpdateActorRelationshipProfileInput
  ): Promise<RelationshipProfileView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/actors/${actorId}/relationship-profile`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      }
    )
    return res.data
  }
  async getRemoteAgentRelationshipProfile(
    wsId: string,
    remoteAgentId: string
  ): Promise<RelationshipProfileView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/remote-agents/${remoteAgentId}/relationship-profile`
    )
    return res.data
  }
  async updateRemoteAgentRelationshipProfile(
    wsId: string,
    remoteAgentId: string,
    input: UpdateActorRelationshipProfileInput
  ): Promise<RelationshipProfileView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/remote-agents/${remoteAgentId}/relationship-profile`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      }
    )
    return res.data
  }
  async scanRelationshipQr(
    wsId: string,
    token: string
  ): Promise<RelationshipScanResponse> {
    const res = await this.fetch(`/workspaces/${wsId}/relationship-qr/scan`, {
      method: "POST",
      body: JSON.stringify({ token }),
    })
    return res.data
  }
  async searchIdentity(
    wsId: string,
    query: string
  ): Promise<IdentitySearchResponse> {
    const params = new URLSearchParams()
    if (query.trim()) {
      params.set("q", query.trim())
    }
    const res = await this.fetch(
      `/workspaces/${wsId}/identity-search${
        params.size > 0 ? `?${params.toString()}` : ""
      }`
    )
    return res.data
  }
  async requestRelationshipByIdentityProfile(
    wsId: string,
    profileId: string
  ): Promise<RelationshipScanResponse> {
    const res = await this.fetch(
      `/workspaces/${wsId}/identity-search/request`,
      {
        method: "POST",
        body: JSON.stringify({ profileId }),
      }
    )
    return res.data
  }
  async getContactHub(wsId: string): Promise<ContactHubResponse> {
    const res = await this.fetch(`/workspaces/${wsId}/contact-hub`)
    return res.data
  }
  async getContactHubDetail(
    wsId: string,
    contactKind: ContactHubEntryKind,
    contactId: string
  ): Promise<ContactHubDetailResponse> {
    const res = await this.fetch(
      `/workspaces/${wsId}/contact-hub/${contactKind}/${contactId}`
    )
    return res.data
  }
  async getFriendRequests(wsId: string): Promise<FriendRequestListResponse> {
    const res = await this.fetch(`/workspaces/${wsId}/friend-requests`)
    return res.data
  }
  async approveFriendRequest(wsId: string, requestId: string) {
    const res = await this.fetch(
      `/workspaces/${wsId}/friend-requests/${requestId}/approve`,
      {
        method: "POST",
        body: "{}",
      }
    )
    return res.data
  }
  async rejectFriendRequest(wsId: string, requestId: string) {
    const res = await this.fetch(
      `/workspaces/${wsId}/friend-requests/${requestId}/reject`,
      {
        method: "POST",
        body: "{}",
      }
    )
    return res.data
  }
  async getActorAccessRequests(
    wsId: string
  ): Promise<ActorAccessRequestListResponse> {
    const res = await this.fetch(`/workspaces/${wsId}/actor-access-requests`)
    return res.data
  }
  async getRemoteAgentAccessRequests(
    wsId: string
  ): Promise<RemoteAgentAccessRequestListResponse> {
    const res = await this.fetch(
      `/workspaces/${wsId}/remote-agent-access-requests`
    )
    return res.data
  }
  async approveActorAccessRequest(wsId: string, requestId: string) {
    const res = await this.fetch(
      `/workspaces/${wsId}/actor-access-requests/${requestId}/approve`,
      {
        method: "POST",
        body: "{}",
      }
    )
    return res.data
  }
  async rejectActorAccessRequest(wsId: string, requestId: string) {
    const res = await this.fetch(
      `/workspaces/${wsId}/actor-access-requests/${requestId}/reject`,
      {
        method: "POST",
        body: "{}",
      }
    )
    return res.data
  }
  async approveRemoteAgentAccessRequest(wsId: string, requestId: string) {
    const res = await this.fetch(
      `/workspaces/${wsId}/remote-agent-access-requests/${requestId}/approve`,
      {
        method: "POST",
        body: "{}",
      }
    )
    return res.data
  }
  async rejectRemoteAgentAccessRequest(wsId: string, requestId: string) {
    const res = await this.fetch(
      `/workspaces/${wsId}/remote-agent-access-requests/${requestId}/reject`,
      {
        method: "POST",
        body: "{}",
      }
    )
    return res.data
  }
  async openDirectConversation(
    wsId: string,
    input: {
      contactKind: ContactHubEntryKind
      contactId: string
    }
  ): Promise<DirectConversationOpenResponse> {
    const res = await this.fetch(
      `/workspaces/${wsId}/chat/direct-conversations/open`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    )
    return res.data
  }

  async getRemoteAgents(
    wsId: string
  ): Promise<RemoteAgentListResponseSchemaType> {
    const res = await this.fetch(`/workspaces/${wsId}/remote-agents`)
    return res.data
  }
  async getRemoteAgent(
    wsId: string,
    remoteAgentId: string
  ): Promise<RemoteAgentResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/remote-agents/${remoteAgentId}`
    )
    return res.data
  }
  async createRemoteAgent(
    wsId: string,
    input: WorkspaceResourceCreateRemoteAgentInput
  ): Promise<RemoteAgentResponseSchemaType> {
    const { grants, ...rest } = input
    const body: CreateWorkspaceResourceInput = {
      kind: WORKSPACE_RESOURCE_KIND.REMOTE_AGENT,
      ...rest,
      grants: parseWorkspaceResourceGrantEntries(grants),
    }
    const created = await this.fetch(
      `/workspaces/${wsId}/workspace-resources`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    )
    return {
      remoteAgent: await this.getRemoteAgent(
        wsId,
        created.data.resource.id
      ).then((res) => res.remoteAgent),
    }
  }
  async updateRemoteAgent(
    wsId: string,
    remoteAgentId: string,
    input: WorkspaceResourceUpdateRemoteAgentInput
  ): Promise<RemoteAgentResponseSchemaType> {
    const body: UpdateWorkspaceResourceInput = {
      kind: WORKSPACE_RESOURCE_KIND.REMOTE_AGENT,
      ...input,
    }
    await this.fetch(
      `/workspaces/${wsId}/workspace-resources/${remoteAgentId}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      }
    )
    return {
      remoteAgent: await this.getRemoteAgent(wsId, remoteAgentId).then(
        (res) => res.remoteAgent
      ),
    }
  }
  async deleteRemoteAgent(
    wsId: string,
    remoteAgentId: string
  ): Promise<WorkspaceResourceSuccessViewSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/workspace-resources/${remoteAgentId}`,
      {
        method: "DELETE",
      }
    )
    return res.data
  }
  async bindRemoteAgent(
    wsId: string,
    remoteAgentId: string,
    input: BindRemoteAgentInput
  ): Promise<RemoteAgentResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/remote-agents/${remoteAgentId}/bind`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    )
    return res.data
  }
  async createRemoteAgentMachinePairingSession(
    wsId: string,
    input: CreateRemoteAgentMachineInput
  ): Promise<RemoteAgentMachinePairingSessionView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/remote-agent-machines/pairing-sessions`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    )
    return res.data
  }
  async getRemoteAgentMachines(
    wsId: string
  ): Promise<RemoteAgentMachineListResponseSchemaType> {
    const res = await this.fetch(`/workspaces/${wsId}/remote-agent-machines`)
    return res.data
  }
  async getRemoteAgentMachine(
    wsId: string,
    machineId: string
  ): Promise<RemoteAgentMachineDetailView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/remote-agent-machines/${machineId}`
    )
    return res.data
  }
  async getRemoteAgentGroupTaskGrants(
    wsId: string,
    remoteAgentId: string
  ): Promise<RemoteAgentGroupTaskGrantsResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/remote-agents/${remoteAgentId}/group-task-grants`
    )
    return res.data
  }
  async updateRemoteAgentGroupTaskGrants(
    wsId: string,
    remoteAgentId: string,
    input: UpdateRemoteAgentGroupTaskGrantsInput
  ): Promise<RemoteAgentGroupTaskGrantsResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/remote-agents/${remoteAgentId}/group-task-grants`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      }
    )
    return res.data
  }

  // Actor lanes
  async retryConversationMessage(
    workspaceId: string,
    conversationId: string,
    itemId: string
  ) {
    const res = await this.fetch(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/messages/${itemId}/retry`,
      {
        method: "POST",
      }
    )
    return res.data
  }

  async getChatBootstrap(workspaceId: string): Promise<ChatBootstrapResponse> {
    const res = await this.fetch(`/workspaces/${workspaceId}/chat/bootstrap`)
    return res.data
  }

  async loadConversationCatalog(
    workspaceId: string
  ): Promise<ConversationCatalogEntry[]> {
    const bootstrap = await this.getChatBootstrap(workspaceId)
    return bootstrap.conversations.map(normalizeConversationCatalogEntry)
  }

  async getChatSync(
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

    const res = await this.fetch(
      `/workspaces/${workspaceId}/chat/sync${query ? `?${query}` : ""}`
    )
    return res.data
  }

  async createChatClientInstance(
    workspaceId: string,
    input?: ChatClientInstanceCreateInput
  ): Promise<ChatClientInstanceRegistrationResponse> {
    const res = await this.fetch(
      `/workspaces/${workspaceId}/chat/client-instances`,
      {
        method: "POST",
        body: JSON.stringify({
          platform: input?.platform,
          deviceLabel: input?.deviceLabel,
          metadata: input?.metadata,
        }),
      }
    )
    return res.data
  }

  async touchChatClientInstance(
    workspaceId: string,
    clientInstanceId: string,
    input?: ChatClientInstanceTouchInput
  ): Promise<ChatClientInstanceRegistrationResponse> {
    const res = await this.fetch(
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
    return res.data
  }

  async createChatConversation(
    workspaceId: string,
    input: ChatConversationCreateInput
  ): Promise<ChatConversationCreateResponse> {
    const res = await this.fetch(
      `/workspaces/${workspaceId}/chat/conversations`,
      {
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
      }
    )
    return res.data
  }

  async getChatConversationMessages(
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

    const res = await this.fetch(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/messages${query ? `?${query}` : ""}`
    )
    return res.data
  }

  async getChatConversationRuntimeTurnDetail(
    workspaceId: string,
    conversationId: string,
    actorId: string,
    turnId: string
  ): Promise<ActorRuntimeTurnActivityDetail> {
    const res = await this.fetch(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/actors/${actorId}/runtime-turns/${turnId}`
    )
    return res.data
  }

  async sendChatConversationMessage(
    workspaceId: string,
    conversationId: string,
    input: ChatConversationSendMessageInput
  ): Promise<ChatConversationSendMessageResponse> {
    const res = await this.fetch(
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
    return res.data
  }

  async updateChatConversationReadWatermark(
    workspaceId: string,
    conversationId: string,
    input: ChatConversationReadWatermarkInput
  ): Promise<ChatConversationReadWatermarkResponse> {
    const res = await this.fetch(
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
    return res.data
  }

  async sendChatTypingState(
    workspaceId: string,
    conversationId: string,
    state: "started" | "stopped"
  ) {
    const res = await this.fetch(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/typing`,
      { method: "POST", body: JSON.stringify({ state }) }
    )
    return res.data
  }

  async registerChatPushToken(
    workspaceId: string,
    input: {
      platform: "ios" | "android" | "web"
      token: string
      deviceLabel?: string
      metadata?: Record<string, unknown>
    }
  ) {
    const res = await this.fetch(
      `/workspaces/${workspaceId}/chat/push-tokens`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    )
    return res.data
  }

  async listChatPushTokens(workspaceId: string) {
    const res = await this.fetch(`/workspaces/${workspaceId}/chat/push-tokens`)
    return res.data
  }

  async deleteChatPushToken(workspaceId: string, tokenId: string) {
    const res = await this.fetch(
      `/workspaces/${workspaceId}/chat/push-tokens/${tokenId}`,
      { method: "DELETE" }
    )
    return res.data
  }

  resolveChatTask(
    workspaceId: string,
    conversationId: string,
    taskId: string,
    data: ChatTaskResolveInput
  ): Promise<ChatTaskResolveResponse> {
    return this.fetch(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/tasks/${taskId}/respond`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
      .then((res) => res.data)
      .catch((error) => {
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
  async getTransportConnectors(
    wsId: string
  ): Promise<TransportConnectorsResponseSchemaType> {
    const res = await this.fetch(`/workspaces/${wsId}/im/connectors`)
    return res.data
  }
  async getTransportAccounts(
    wsId: string
  ): Promise<TransportAccountsResponseSchemaType> {
    const res = await this.fetch(`/workspaces/${wsId}/im/accounts`)
    return res.data
  }
  async getTransportSessions(
    wsId: string
  ): Promise<TransportSessionsResponseSchemaType> {
    const res = await this.fetch(`/workspaces/${wsId}/im/sessions`)
    return res.data
  }
  async getTransportExternalUsers(
    wsId: string,
    transportAccountId?: TransportExternalUsersListQuery["transportAccountId"]
  ): Promise<TransportExternalUsersResponseSchemaType> {
    const params = new URLSearchParams()
    if (transportAccountId) params.set("transportAccountId", transportAccountId)
    const res = await this.fetch(
      `/workspaces/${wsId}/im/external-users${params.size ? `?${params.toString()}` : ""}`
    )
    return res.data
  }
  async createFeishuTransportAccount(
    wsId: string,
    data: TransportFeishuAccountCreateInput
  ): Promise<TransportAccountResponseSchemaType> {
    const res = await this.fetch(`/workspaces/${wsId}/im/accounts/feishu`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  async updateFeishuTransportAccount(
    wsId: string,
    accountId: string,
    data: TransportFeishuAccountUpdateInput
  ): Promise<TransportAccountResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/accounts/feishu/${accountId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async createWecomTransportAccount(
    wsId: string,
    data: TransportWecomAccountCreateInput
  ): Promise<TransportAccountResponseSchemaType> {
    const res = await this.fetch(`/workspaces/${wsId}/im/accounts/wecom`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  async updateWecomTransportAccount(
    wsId: string,
    accountId: string,
    data: TransportWecomAccountUpdateInput
  ): Promise<TransportAccountResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/accounts/wecom/${accountId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async createQqTransportAccount(
    wsId: string,
    data: TransportQqAccountCreateInput
  ): Promise<TransportAccountResponseSchemaType> {
    const res = await this.fetch(`/workspaces/${wsId}/im/accounts/qq`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  async updateQqTransportAccount(
    wsId: string,
    accountId: string,
    data: TransportQqAccountUpdateInput
  ): Promise<TransportAccountResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/accounts/qq/${accountId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  // ── Telegram (token-style create, mirrors QQ) ──
  // The telegram/whatsapp/whatsapp_unofficial connectors use LOCAL zod
  // schemas on the backend (NOT exported from @synapse/shared), so the
  // request body shapes are declared inline here.
  async createTelegramTransportAccount(
    wsId: string,
    data: TransportTelegramAccountCreateInput
  ): Promise<TransportAccountResponseSchemaType> {
    const res = await this.fetch(`/workspaces/${wsId}/im/accounts/telegram`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  async updateTelegramTransportAccount(
    wsId: string,
    accountId: string,
    data: TransportTelegramAccountUpdateInput
  ): Promise<TransportAccountResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/accounts/telegram/${accountId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  // ── WhatsApp Cloud API (token-style create, webhook only) ──
  async createWhatsappTransportAccount(
    wsId: string,
    data: TransportWhatsappAccountCreateInput
  ): Promise<TransportAccountResponseSchemaType> {
    const res = await this.fetch(`/workspaces/${wsId}/im/accounts/whatsapp`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  async updateWhatsappTransportAccount(
    wsId: string,
    accountId: string,
    data: TransportWhatsappAccountUpdateInput
  ): Promise<TransportAccountResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/accounts/whatsapp/${accountId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  // ── WhatsApp unofficial (Baileys) QR / pairing login + kill-switch ──
  async startWhatsappUnofficialLogin(
    wsId: string,
    data: WhatsappUnofficialLoginStartInput
  ): Promise<WhatsappUnofficialLoginSessionResponse> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/accounts/whatsapp_unofficial/login`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async pollWhatsappUnofficialLogin(
    wsId: string,
    sessionId: string
  ): Promise<WhatsappUnofficialLoginSessionResponse> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/accounts/whatsapp_unofficial/login/${sessionId}`
    )
    return res.data
  }
  cancelWhatsappUnofficialLogin(
    wsId: string,
    sessionId: string
  ): Promise<{ ok: boolean }> {
    return this.fetch(
      `/workspaces/${wsId}/im/accounts/whatsapp_unofficial/login/${sessionId}`,
      { method: "DELETE" }
    ).then((res) => res.data)
  }
  async toggleWhatsappUnofficialSessionGuard(
    wsId: string,
    data: WhatsappUnofficialSessionGuardInput
  ): Promise<WhatsappUnofficialSessionGuardResponse> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/accounts/whatsapp_unofficial/session-guard`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async startWeixinQrTransportSession(
    wsId: string,
    data: WeixinQrSessionCreateInput
  ): Promise<WeixinQrSessionResponseSchemaType> {
    const res = await this.fetch(`/workspaces/${wsId}/im/accounts/weixin/qr`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  async getWeixinQrTransportSession(
    wsId: string,
    sessionId: string
  ): Promise<WeixinQrSessionResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/accounts/weixin/qr/${sessionId}`
    )
    return res.data
  }
  async submitWeixinQrTransportVerifyCode(
    wsId: string,
    sessionId: string,
    code: string
  ): Promise<WeixinQrSessionResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/accounts/weixin/qr/${sessionId}/verify-code`,
      { method: "POST", body: JSON.stringify({ code }) }
    )
    return res.data
  }
  async startDingtalkDeviceFlow(
    wsId: string,
    data: DingtalkDeviceFlowStartInput
  ): Promise<DingtalkDeviceFlowStartResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/accounts/dingtalk/device-registration/start`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async pollDingtalkDeviceFlow(
    wsId: string,
    sessionId: string
  ): Promise<DingtalkDeviceFlowPollResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/accounts/dingtalk/device-registration/${sessionId}`
    )
    return res.data
  }
  cancelDingtalkDeviceFlow(wsId: string, sessionId: string): Promise<void> {
    return this.fetch(
      `/workspaces/${wsId}/im/accounts/dingtalk/device-registration/${sessionId}`,
      { method: "DELETE" }
    )
  }
  async createDingtalkAccountManual(
    wsId: string,
    data: DingtalkManualAccountCreateInput
  ): Promise<TransportAccountResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/accounts/dingtalk/manual`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async getCurrentUserWeixinBinding(
    wsId: string
  ): Promise<WeixinBindingResponseSchemaType> {
    const res = await this.fetch(`/workspaces/${wsId}/im/me/weixin-binding`)
    return res.data
  }
  async getCurrentUserWeixinBindingCandidates(
    wsId: string
  ): Promise<WeixinBindingCandidatesResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/me/weixin-binding/candidates`
    )
    return res.data
  }
  async startCurrentUserWeixinBindingQr(
    wsId: string
  ): Promise<WeixinQrSessionResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/me/weixin-binding/qr`,
      {
        method: "POST",
        body: "{}",
      }
    )
    return res.data
  }
  async getCurrentUserWeixinBindingQr(
    wsId: string,
    sessionId: string
  ): Promise<WeixinQrSessionResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/me/weixin-binding/qr/${sessionId}`
    )
    return res.data
  }
  async submitCurrentUserWeixinBindingVerifyCode(
    wsId: string,
    sessionId: string,
    code: string
  ): Promise<WeixinQrSessionResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/me/weixin-binding/qr/${sessionId}/verify-code`,
      { method: "POST", body: JSON.stringify({ code }) }
    )
    return res.data
  }
  async linkCurrentUserWeixinBinding(
    wsId: string
  ): Promise<WeixinBindingResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/me/weixin-binding/link`,
      {
        method: "POST",
        body: "{}",
      }
    )
    return res.data
  }
  async setCurrentUserWeixinBindingAutoLink(
    wsId: string,
    workspaceMemberId: WeixinBindingAutoLinkInput["workspaceMemberId"]
  ): Promise<WeixinBindingResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/me/weixin-binding/auto-link`,
      {
        method: "PUT",
        body: JSON.stringify({ workspaceMemberId }),
      }
    )
    return res.data
  }
  async createTransportAccount(
    wsId: string,
    data: TransportAccountCreateInput
  ): Promise<TransportAccountResponseSchemaType> {
    const res = await this.fetch(`/workspaces/${wsId}/im/accounts`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  async updateTransportAccount(
    wsId: string,
    accountId: string,
    data: TransportAccountUpdateInput
  ): Promise<TransportAccountResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/accounts/${accountId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async updateTransportSessionSettings(
    wsId: string,
    sessionId: string,
    data: TransportSessionSettingsInput
  ): Promise<TransportSessionResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/sessions/${sessionId}/settings`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async setTransportExternalUserWorkspaceMember(
    wsId: string,
    addressId: string,
    workspaceMemberId: TransportExternalUserLinkedMemberInput["workspaceMemberId"]
  ): Promise<TransportExternalUserResponseSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/im/external-users/${addressId}/workspace-member`,
      {
        method: "PUT",
        body: JSON.stringify({ workspaceMemberId }),
      }
    )
    return res.data
  }
  // MCP Marketplace
  async getMarketplace(
    query?: McpMarketplaceListQuery
  ): Promise<MarketplacePluginListView> {
    const res = await this.fetch(withQuery("/mcp/marketplace", query))
    return res.data
  }
  async getMarketplacePlugin(pluginId: string): Promise<MarketplacePluginView> {
    const res = await this.fetch(`/mcp/marketplace/${pluginId}`)
    return res.data
  }
  async getPluginCategories(): Promise<PluginCategoryListView> {
    const res = await this.fetch("/mcp/categories")
    return res.data
  }
  async getMcpOrganizations(): Promise<MarketplacePublisherListView> {
    const res = await this.fetch("/mcp/organizations")
    return res.data
  }
  async getMcpOrganization(
    orgId: string
  ): Promise<MarketplacePublisherDetailView> {
    const res = await this.fetch(`/mcp/organizations/${orgId}`)
    return res.data
  }

  // MCP Unified Installations
  async getInstallations(
    wsId: string,
    query?: McpPluginInstallationListQuery
  ): Promise<PluginInstallationListView> {
    const res = await this.fetch(
      withQuery(`/workspaces/${wsId}/mcp/installations`, query)
    )
    return res.data
  }
  async getInstallation(
    wsId: string,
    installId: string
  ): Promise<PluginInstallationDetailView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/mcp/installations/${installId}`
    )
    return res.data
  }
  async installPlugin(
    wsId: string,
    data: WorkspaceResourceCreatePluginInstallationInput
  ): Promise<PluginInstallationDetailView> {
    const { grants, ...rest } = data
    const body: CreateWorkspaceResourceInput = {
      kind: WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION,
      ...rest,
      grants: parseWorkspaceResourceGrantEntries(grants),
    }
    const created = await this.fetch(
      `/workspaces/${wsId}/workspace-resources`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    )
    return this.getInstallation(wsId, created.data.resource.id)
  }
  async updateInstallation(
    wsId: string,
    installId: string,
    data: WorkspaceResourceUpdatePluginInstallationInput
  ): Promise<PluginInstallationDetailView> {
    const body: UpdateWorkspaceResourceInput = {
      kind: WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION,
      ...data,
    }
    await this.fetch(`/workspaces/${wsId}/workspace-resources/${installId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    })
    return this.getInstallation(wsId, installId)
  }
  async uninstallPlugin(
    wsId: string,
    installId: string
  ): Promise<WorkspaceResourceSuccessViewSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/workspace-resources/${installId}`,
      {
        method: "DELETE",
      }
    )
    return res.data
  }
  async startPluginAuth(
    wsId: string,
    pluginId: string,
    bindingKey: string,
    data?: StartPluginAuthInput
  ) {
    const res = await this.fetch(
      `/workspaces/${wsId}/mcp/plugins/${pluginId}/auth/${bindingKey}/start`,
      { method: "POST", body: JSON.stringify(data || {}) }
    )
    return res.data
  }
  async getPluginAuthSession(wsId: string, sessionId: string) {
    const res = await this.fetch(
      `/workspaces/${wsId}/mcp/auth/sessions/${sessionId}`
    )
    return res.data
  }
  async inspectPluginAuthSession(wsId: string, sessionId: string) {
    const res = await this.fetch(
      `/workspaces/${wsId}/mcp/auth/sessions/${sessionId}/inspect`,
      {
        method: "POST",
        body: "{}",
      }
    )
    return res.data
  }

  // MCP Audit
  async getMcpToolCallLogs(
    wsId: string,
    query?: McpPluginToolCallAuditLogListQuery
  ): Promise<PluginAuditLogList> {
    const res = await this.fetch(
      withQuery(`/workspaces/${wsId}/mcp/audit/tool-calls`, query)
    )
    return res.data
  }
  async getMcpEventLogs(
    wsId: string,
    query?: McpPluginEventAuditLogListQuery
  ): Promise<PluginAuditLogList> {
    const res = await this.fetch(
      withQuery(`/workspaces/${wsId}/mcp/audit/events`, query)
    )
    return res.data
  }

  // Devices (v3)
  async listDevices(wsId: string): Promise<DeviceListView> {
    const res = await this.fetch(`/workspaces/${wsId}/devices`)
    return res.data
  }
  async getDevice(wsId: string, deviceId: string): Promise<DeviceDetailView> {
    const res = await this.fetch(`/workspaces/${wsId}/devices/${deviceId}`)
    return res.data
  }
  deleteDevice(wsId: string, deviceId: string): Promise<void> {
    return this.fetch(`/workspaces/${wsId}/devices/${deviceId}`, {
      method: "DELETE",
    })
  }
  async startDevicePairingSession(
    wsId: string,
    body: Omit<StartPairingInput, "workspaceId">
  ): Promise<DevicePairingTicketView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/devices/pairing-sessions`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    )
    return res.data
  }
  async claimRemoteAgentDaemon(
    wsId: string,
    deviceId: string,
    remoteAgentMachineId: string
  ): Promise<DeviceServiceView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/devices/${deviceId}/services`,
      {
        method: "POST",
        body: JSON.stringify({
          serviceKind: "remote_agent_daemon",
          remoteAgentMachineId,
        }),
      }
    )
    return res.data
  }
  detachRuntimeService(
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
  async createManualRuntimeAuthorizationGrant(
    wsId: string,
    body: CreateManualRuntimeAuthorizationGrantInput
  ): Promise<RuntimeAuthorizationGrantRecordView> {
    const res = await this.fetch(
      `/workspaces/${wsId}/runtime-authorization-grants`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    )
    return res.data
  }

  // Automation Event Sources
  async getAutomationEventSources(
    wsId: string,
    filters?: AutomationEventSourceListQuery
  ): Promise<AutomationEventSourceListSchemaType> {
    const params = new URLSearchParams()
    if (filters?.status) params.set("status", filters.status)
    if (filters?.providerKind) params.set("providerKind", filters.providerKind)
    if (filters?.providerRef) params.set("providerRef", filters.providerRef)
    if (filters?.sourceKey) params.set("sourceKey", filters.sourceKey)
    const qs = params.toString()
    // §5.3 APP route: unwrap the { data } envelope.
    const res = await this.fetch(
      `/workspaces/${wsId}/automation-event-sources${qs ? `?${qs}` : ""}`
    )
    return res.data
  }
  async createAutomationEventSource(
    wsId: string,
    data: AutomationEventSourceCreateInput
  ): Promise<AutomationEventSource> {
    // §5.3 APP route: unwrap the { data } envelope.
    const res = await this.fetch(
      `/workspaces/${wsId}/automation-event-sources`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async updateAutomationEventSource(
    wsId: string,
    eventSourceId: string,
    data: AutomationEventSourceUpdateInput
  ): Promise<AutomationEventSource> {
    // §5.3 APP route: unwrap the { data } envelope.
    const res = await this.fetch(
      `/workspaces/${wsId}/automation-event-sources/${eventSourceId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async archiveAutomationEventSource(
    wsId: string,
    eventSourceId: string
  ): Promise<AutomationSuccessSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/automation-event-sources/${eventSourceId}`,
      {
        method: "DELETE",
      }
    )
    return res.data
  }
  async getAutomationEventSourceOccurrences(
    wsId: string,
    eventSourceId: string
  ): Promise<AutomationOccurrenceListSchemaType> {
    // §5.3 APP route: unwrap the { data } envelope.
    const res = await this.fetch(
      `/workspaces/${wsId}/automation-event-sources/${eventSourceId}/occurrences`
    )
    return res.data
  }

  // Automation Rules / Triggers
  async getAutomations(
    wsId: string,
    filters?: AutomationRuleListQuery
  ): Promise<AutomationRuleListSchemaType> {
    const params = new URLSearchParams()
    if (filters?.status) params.set("status", filters.status)
    if (filters?.category) params.set("category", filters.category)
    if (filters?.conversationId)
      params.set("conversationId", filters.conversationId)
    const qs = params.toString()
    // §5.3 APP route: unwrap the { data } envelope.
    const res = await this.fetch(
      `/workspaces/${wsId}/automations${qs ? `?${qs}` : ""}`
    )
    return res.data
  }
  async getAutomation(
    wsId: string,
    automationId: string
  ): Promise<AutomationRule> {
    // §5.3 APP route: unwrap the { data } envelope.
    const res = await this.fetch(
      `/workspaces/${wsId}/automations/${automationId}`
    )
    return res.data
  }
  async createAutomation(
    wsId: string,
    data: AutomationRuleCreateInput
  ): Promise<AutomationRule> {
    // §5.3 APP route: unwrap the { data } envelope.
    const res = await this.fetch(`/workspaces/${wsId}/automations`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return res.data
  }
  async updateAutomation(
    wsId: string,
    automationId: string,
    data: AutomationRuleUpdateInput
  ): Promise<AutomationRule> {
    // §5.3 APP route: unwrap the { data } envelope.
    const res = await this.fetch(
      `/workspaces/${wsId}/automations/${automationId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }
  async deleteAutomation(
    wsId: string,
    automationId: string
  ): Promise<AutomationSuccessSchemaType> {
    const res = await this.fetch(
      `/workspaces/${wsId}/automations/${automationId}`,
      {
        method: "DELETE",
      }
    )
    return res.data
  }
  async getAutomationExecutions(
    wsId: string,
    automationId: string
  ): Promise<AutomationExecutionListSchemaType> {
    // §5.3 APP route: unwrap the { data } envelope.
    const res = await this.fetch(
      `/workspaces/${wsId}/automations/${automationId}/executions`
    )
    return res.data
  }

  // File Upload
  async uploadFile(
    wsId: string,
    file: File,
    options?: {
      signal?: AbortSignal
      onProgress?: (progress: number) => void
    }
  ): Promise<StoredFileRecordView> {
    const formData = new FormData()
    formData.append("file", file)
    const origin: FileUploadOriginInput = {
      family: "user_upload",
      system: FILE_ORIGIN_SYSTEMS.WORKSPACE_WEB_UPLOAD,
    }
    formData.append("origin", JSON.stringify(origin))

    return new Promise<StoredFileRecordView>((resolve, reject) => {
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

        if (request.status >= 200 && request.status < 300) {
          // §5.3 APP route: upload returns the { data } envelope.
          let file: StoredFileRecordView
          try {
            file = parseFileUploadResponseData(request.response)
          } catch (error) {
            finalizeReject(
              error instanceof Error
                ? error
                : new Error("Malformed upload response")
            )
            return
          }
          completed = true
          cleanup()
          resolve(file)
          return
        }

        completed = true
        cleanup()

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
  async getFileInfo(fileId: string): Promise<FileRecordView> {
    // §5.3 APP route: unwrap the { data } envelope, preserve public shape.
    const res = await this.fetch(`/files/${fileId}/info`)
    return res.data
  }
}

export const api = new ApiClient()
