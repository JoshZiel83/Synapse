import { FILE_ORIGIN_SYSTEMS, isChatTaskResolveConflictResponse } from "@shared"
import type {
  ActorRuntimeTurnActivityDetail,
  CanonicalContentBlock,
  ChatBootstrapResponse,
  ChatClientInstanceCreateInput,
  ChatClientInstanceRegistrationResponse,
  ChatClientInstanceTouchInput,
  ChatConversationCreateInput,
  ChatConversationCreateResponse,
  ChatConversationMessagesQuery,
  ChatConversationMessagesPage,
  ChatConversationReadWatermarkInput,
  ChatConversationReadWatermarkResponse,
  ChatConversationSendMessageInput,
  ChatConversationSendMessageResponse,
  ChatTaskResolveInput,
  ChatTaskResolvePayload,
  ChatTaskResolveResponse,
  ChatSyncResponse,
  TaskSummary,
  Timestamp,
} from "@shared"
import { Platform } from "react-native"

import { getApiBase, resolveApiUrl } from "@/lib/config"
import type {
  ActorAccessRequestListResponse,
  ActorListResponse,
  AuthMeResponse,
  ContactHubDetailResponse,
  ContactHubEntryView,
  ContactHubResponse,
  DirectConversationOpenResponse,
  FriendIdProfileView,
  IdentitySearchResponse,
  FriendRequestListResponse,
  RelationshipScanResponse,
  UploadAssetInput,
  WorkspaceChiefActorPreference,
  WorkspaceInfo,
  WorkspaceListResponse,
} from "@/types/api"
import type { FileRecordView } from "@shared"

let authToken: string | null = null
let unauthorizedHandler: (() => void | Promise<void>) | null = null
let unauthorizedHandlerPending = false

export type {
  ChatTaskResolveInput,
  ChatTaskResolvePayload,
  ChatTaskResolveResponse,
}
export class ApiError extends Error {
  status: number
  code?: string
  details?: unknown

  constructor(
    message: string,
    status: number,
    code?: string,
    details?: unknown
  ) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.details = details
  }
}

interface UploadAssetOptions {
  onProgress?: (progress: number) => void
  signal?: AbortSignal
}

function notifyUnauthorizedStatus(status: number) {
  if (
    status !== 401 ||
    !authToken ||
    !unauthorizedHandler ||
    unauthorizedHandlerPending
  ) {
    return
  }

  unauthorizedHandlerPending = true
  void Promise.resolve(unauthorizedHandler()).finally(() => {
    unauthorizedHandlerPending = false
  })
}

function getAuthHeaders() {
  return authToken
    ? {
        Authorization: `Bearer ${authToken}`,
      }
    : undefined
}

function parseErrorMessage(data: unknown, fallback: string) {
  if (data && typeof data === "object" && "error" in data) {
    const value = (data as { error?: unknown }).error
    if (typeof value === "string" && value.trim()) {
      return value
    }
  }

  return fallback
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function normalizeWorkspaceListResponse(data: unknown): WorkspaceListResponse {
  if (Array.isArray(data)) {
    return { data }
  }

  if (data && typeof data === "object") {
    return {
      data: asArray((data as { data?: unknown }).data),
    }
  }

  return { data: [] }
}

function normalizeActorListResponse(data: unknown): ActorListResponse {
  if (Array.isArray(data)) {
    return { actors: data }
  }

  if (data && typeof data === "object") {
    const objectData = data as { actors?: unknown; data?: unknown }
    return {
      actors: asArray(objectData.actors ?? objectData.data),
    }
  }

  return { actors: [] }
}

class ApiClient {
  private async request<T>(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers as HeadersInit | undefined)
    const isFormData =
      typeof FormData !== "undefined" && options.body instanceof FormData

    if (!isFormData && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json")
    }

    const authHeaders = getAuthHeaders()
    if (authHeaders) {
      Object.entries(authHeaders).forEach(([key, value]) =>
        headers.set(key, value)
      )
    }

    const response = await fetch(`${getApiBase()}${path}`, {
      ...options,
      headers,
      // On the Expo-web target the cookie-jar is empty (no Bearer header), so
      // rely on the browser's session cookie — which is only sent with
      // credentials:"include". Native uses the Authorization: Bearer header.
      ...(Platform.OS === "web" ? { credentials: "include" as const } : {}),
    })

    if (response.status === 204) {
      return null as T
    }

    const data = await response.json().catch(() => null)

    if (!response.ok) {
      const error = new ApiError(
        parseErrorMessage(data, "Request failed"),
        response.status,
        data &&
          typeof data === "object" &&
          typeof (data as { code?: unknown }).code === "string"
          ? (data as { code: string }).code
          : undefined,
        data
      )
      notifyUnauthorizedStatus(response.status)
      throw error
    }

    return data as T
  }

  getMe(): Promise<AuthMeResponse> {
    return this.request<AuthMeResponse>("/auth/me")
  }

  updateMe(data: { name?: string; avatarFileId?: string | null }) {
    return this.request<AuthMeResponse>("/auth/me", {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }

  getWorkspaces(): Promise<WorkspaceListResponse> {
    return this.request<unknown>("/workspaces").then(
      normalizeWorkspaceListResponse
    )
  }

  createWorkspace(name: string, description?: string): Promise<WorkspaceInfo> {
    return this.request<WorkspaceInfo>("/workspaces", {
      method: "POST",
      body: JSON.stringify({
        name,
        description,
      }),
    })
  }

  getActors(workspaceId: string): Promise<ActorListResponse> {
    return this.request<unknown>(`/workspaces/${workspaceId}/actors`).then(
      normalizeActorListResponse
    )
  }

  getMyFriendIdProfile(workspaceId: string): Promise<FriendIdProfileView> {
    return this.request<FriendIdProfileView>(
      `/workspaces/${workspaceId}/me/friend-id`
    )
  }

  updateMyFriendIdProfile(
    workspaceId: string,
    input: {
      friendId?: string
      searchByIdEnabled?: boolean
    }
  ): Promise<FriendIdProfileView> {
    return this.request<FriendIdProfileView>(
      `/workspaces/${workspaceId}/me/friend-id`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      }
    )
  }

  scanRelationshipQr(
    workspaceId: string,
    token: string
  ): Promise<RelationshipScanResponse> {
    return this.request<{ data: RelationshipScanResponse }>(
      `/workspaces/${workspaceId}/relationship-qr/scan`,
      {
        method: "POST",
        body: JSON.stringify({ token }),
      }
    ).then((res) => res.data)
  }

  searchIdentity(
    workspaceId: string,
    query: string
  ): Promise<IdentitySearchResponse> {
    const params = new URLSearchParams()
    if (query.trim()) {
      params.set("q", query.trim())
    }
    return this.request<{ data: IdentitySearchResponse }>(
      `/workspaces/${workspaceId}/identity-search${
        params.size > 0 ? `?${params.toString()}` : ""
      }`
    ).then((res) => res.data)
  }

  requestIdentityProfile(
    workspaceId: string,
    profileId: string
  ): Promise<RelationshipScanResponse> {
    return this.request<{ data: RelationshipScanResponse }>(
      `/workspaces/${workspaceId}/identity-search/request`,
      {
        method: "POST",
        body: JSON.stringify({ profileId }),
      }
    ).then((res) => res.data)
  }

  getContactHub(workspaceId: string): Promise<ContactHubResponse> {
    return this.request<{ data: ContactHubResponse }>(
      `/workspaces/${workspaceId}/contact-hub`
    ).then((res) => res.data)
  }

  getContactHubDetail(
    workspaceId: string,
    contactKind: ContactHubEntryView["kind"],
    contactId: string
  ): Promise<ContactHubDetailResponse> {
    return this.request<{ data: ContactHubDetailResponse }>(
      `/workspaces/${workspaceId}/contact-hub/${contactKind}/${contactId}`
    ).then((res) => res.data)
  }

  getFriendRequests(workspaceId: string): Promise<FriendRequestListResponse> {
    return this.request<{ data: FriendRequestListResponse }>(
      `/workspaces/${workspaceId}/friend-requests`
    ).then((res) => res.data)
  }

  approveFriendRequest(workspaceId: string, requestId: string) {
    return this.request<{ data: { request: unknown } }>(
      `/workspaces/${workspaceId}/friend-requests/${requestId}/approve`,
      { method: "POST", body: "{}" }
    ).then((res) => res.data)
  }

  rejectFriendRequest(workspaceId: string, requestId: string) {
    return this.request<{ data: { request: unknown } }>(
      `/workspaces/${workspaceId}/friend-requests/${requestId}/reject`,
      { method: "POST", body: "{}" }
    ).then((res) => res.data)
  }

  getActorAccessRequests(
    workspaceId: string
  ): Promise<ActorAccessRequestListResponse> {
    return this.request<{ data: ActorAccessRequestListResponse }>(
      `/workspaces/${workspaceId}/actor-access-requests`
    ).then((res) => res.data)
  }

  approveActorAccessRequest(workspaceId: string, requestId: string) {
    return this.request<{ data: { request: unknown } }>(
      `/workspaces/${workspaceId}/actor-access-requests/${requestId}/approve`,
      { method: "POST", body: "{}" }
    ).then((res) => res.data)
  }

  rejectActorAccessRequest(workspaceId: string, requestId: string) {
    return this.request<{ data: { request: unknown } }>(
      `/workspaces/${workspaceId}/actor-access-requests/${requestId}/reject`,
      { method: "POST", body: "{}" }
    ).then((res) => res.data)
  }

  openDirectConversation(
    workspaceId: string,
    input: {
      contactKind: ContactHubEntryView["kind"]
      contactId: string
    }
  ): Promise<DirectConversationOpenResponse> {
    return this.request<{ data: DirectConversationOpenResponse }>(
      `/workspaces/${workspaceId}/chat/direct-conversations/open`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    ).then((res) => res.data)
  }

  getWorkspaceChiefActorPreference(
    workspaceId: string
  ): Promise<WorkspaceChiefActorPreference> {
    return this.request<WorkspaceChiefActorPreference>(
      `/workspaces/${workspaceId}/preferences/chief-actor`
    )
  }

  updateWorkspaceChiefActorPreference(
    workspaceId: string,
    data: { chiefActorId: string | null }
  ): Promise<WorkspaceChiefActorPreference> {
    return this.request<WorkspaceChiefActorPreference>(
      `/workspaces/${workspaceId}/preferences/chief-actor`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
  }

  getChatBootstrap(workspaceId: string): Promise<ChatBootstrapResponse> {
    return this.request<ChatBootstrapResponse>(
      `/workspaces/${workspaceId}/chat/bootstrap`
    )
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

    return this.request<ChatSyncResponse>(
      `/workspaces/${workspaceId}/chat/sync${query ? `?${query}` : ""}`
    )
  }

  createChatClientInstance(
    workspaceId: string,
    input?: ChatClientInstanceCreateInput
  ): Promise<ChatClientInstanceRegistrationResponse> {
    return this.request<ChatClientInstanceRegistrationResponse>(
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
  }

  touchChatClientInstance(
    workspaceId: string,
    clientInstanceId: string,
    input?: ChatClientInstanceTouchInput
  ): Promise<ChatClientInstanceRegistrationResponse> {
    return this.request<ChatClientInstanceRegistrationResponse>(
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
    return this.request<ChatConversationCreateResponse>(
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

    return this.request<ChatConversationMessagesPage>(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/messages${query ? `?${query}` : ""}`
    )
  }

  getChatConversationRuntimeTurnDetail(
    workspaceId: string,
    conversationId: string,
    actorId: string,
    turnId: string
  ): Promise<ActorRuntimeTurnActivityDetail> {
    return this.request<ActorRuntimeTurnActivityDetail>(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/actors/${actorId}/runtime-turns/${turnId}`
    )
  }

  sendChatConversationMessage(
    workspaceId: string,
    conversationId: string,
    input: ChatConversationSendMessageInput
  ): Promise<ChatConversationSendMessageResponse> {
    return this.request<ChatConversationSendMessageResponse>(
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

  resolveChatTask(
    workspaceId: string,
    conversationId: string,
    taskId: string,
    input: ChatTaskResolveInput
  ): Promise<ChatTaskResolveResponse> {
    return this.request<ChatTaskResolveResponse>(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/tasks/${taskId}/respond`,
      {
        method: "POST",
        body: JSON.stringify(input),
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

  updateChatConversationReadWatermark(
    workspaceId: string,
    conversationId: string,
    input: ChatConversationReadWatermarkInput
  ): Promise<ChatConversationReadWatermarkResponse> {
    return this.request<ChatConversationReadWatermarkResponse>(
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
    return this.request<{ broadcast: boolean }>(
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
    return this.request<{
      token: { id: string; platform: string; createdAt: Timestamp }
    }>(`/workspaces/${workspaceId}/chat/push-tokens`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  listChatPushTokens(workspaceId: string) {
    return this.request<{ tokens: Array<{ id: string; platform: string }> }>(
      `/workspaces/${workspaceId}/chat/push-tokens`
    )
  }

  deleteChatPushToken(workspaceId: string, tokenId: string) {
    return this.request<{ deleted: boolean }>(
      `/workspaces/${workspaceId}/chat/push-tokens/${tokenId}`,
      { method: "DELETE" }
    )
  }

  async uploadAsset(
    workspaceId: string,
    asset: UploadAssetInput,
    options?: UploadAssetOptions
  ): Promise<FileRecordView> {
    const formData = new FormData()
    if (Platform.OS === "web") {
      let fileBody: Blob | File | null = asset.file ?? null
      if (!fileBody) {
        const response = await fetch(asset.uri)
        if (!response.ok) {
          throw new ApiError("Failed to read selected file", response.status)
        }
        fileBody = await response.blob()
      }

      formData.append("file", fileBody, asset.name)
    } else {
      formData.append("file", {
        uri: asset.uri,
        name: asset.name,
        type: asset.mimeType,
      } as never)
    }

    formData.append(
      "origin",
      JSON.stringify({
        family: "user_upload",
        system: FILE_ORIGIN_SYSTEMS.WORKSPACE_MOBILE_UPLOAD,
      })
    )

    const headers = new Headers()
    const authHeaders = getAuthHeaders()
    if (authHeaders) {
      Object.entries(authHeaders).forEach(([key, value]) =>
        headers.set(key, value)
      )
    }

    return new Promise<FileRecordView>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      let settled = false
      let removeAbortListener: (() => void) | null = null

      function cleanup() {
        removeAbortListener?.()
        removeAbortListener = null
      }

      function fail(error: ApiError) {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        reject(error)
      }

      function succeed(value: FileRecordView) {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        resolve(value)
      }

      xhr.open("POST", `${getApiBase()}/workspaces/${workspaceId}/files`)
      // Expo-web relies on the browser session cookie (no Bearer header there).
      if (Platform.OS === "web") {
        xhr.withCredentials = true
      }
      headers.forEach((value, key) => {
        xhr.setRequestHeader(key, value)
      })

      xhr.onload = () => {
        let data: unknown = null
        if (
          typeof xhr.responseText === "string" &&
          xhr.responseText.length > 0
        ) {
          try {
            data = JSON.parse(xhr.responseText)
          } catch {
            data = null
          }
        }

        if (xhr.status < 200 || xhr.status >= 300) {
          const error = new ApiError(
            parseErrorMessage(data, "Upload failed"),
            xhr.status,
            undefined,
            data
          )
          notifyUnauthorizedStatus(xhr.status)
          fail(error)
          return
        }

        // §5.3 APP route: upload returns the { data } envelope.
        succeed((data as { data: FileRecordView }).data)
      }

      xhr.onerror = () => {
        fail(new ApiError("Upload failed", 0, "NETWORK_ERROR"))
      }

      xhr.onabort = () => {
        fail(new ApiError("Upload aborted", 0, "ABORTED"))
      }

      if (xhr.upload && options?.onProgress) {
        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable || event.total <= 0) {
            return
          }

          options.onProgress?.(Math.min(1, event.loaded / event.total))
        }
      }

      if (options?.signal) {
        const handleAbort = () => {
          xhr.abort()
        }

        if (options.signal.aborted) {
          handleAbort()
          return
        }

        options.signal.addEventListener("abort", handleAbort, { once: true })
        removeAbortListener = () =>
          options.signal?.removeEventListener("abort", handleAbort)
      }

      xhr.send(formData)
    })
  }
}

export const api = new ApiClient()

export function setApiAuthToken(token: string | null) {
  authToken = token
  unauthorizedHandlerPending = false
}

export function getApiAuthToken() {
  return authToken
}

export function setApiUnauthorizedHandler(
  handler: (() => void | Promise<void>) | null
) {
  unauthorizedHandler = handler
}

export function reportApiUnauthorized(status: number) {
  notifyUnauthorizedStatus(status)
}

export function buildAuthenticatedSource(pathOrUrl: string) {
  const headers = getAuthHeaders()
  return {
    uri: resolveApiUrl(pathOrUrl),
    ...(headers ? { headers } : {}),
  }
}
