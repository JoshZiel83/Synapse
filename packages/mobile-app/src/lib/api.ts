import { FILE_ORIGIN_SYSTEMS, isChatTaskResolveConflictResponse } from "@shared"
import type {
  Actor,
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
  AuthMeView,
  RelationshipProfileView,
  UpdateMemberRelationshipProfileInput,
  WorkspaceCreateResultView,
  WorkspaceListView,
  TaskSummary,
  Timestamp,
} from "@shared"
import { Platform } from "react-native"

import { getApiBase, resolveApiUrl } from "@/lib/config"
import type {
  ActorAccessRequestListResponse,
  ContactHubDetailResponse,
  ContactHubEntryView,
  ContactHubResponse,
  DirectConversationOpenResponse,
  IdentitySearchResponse,
  FriendRequestListResponse,
  RelationshipScanResponse,
  UploadAssetInput,
  WorkspaceChiefActorPreference,
} from "@/types/api"
import type { FileRecordView, UpdateMeInput } from "@shared"
import type {
  FileUploadOriginInput,
  WorkspaceChiefActorPreferenceInput,
  WorkspaceCreateInput,
} from "@shared/schemas"
import {
  StoredFileRecordViewSchema,
  type StoredFileRecordView,
} from "@shared/schemas"

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

function parseFileUploadResponseData(value: unknown): StoredFileRecordView {
  if (!value || typeof value !== "object" || !("data" in value)) {
    throw new Error("Malformed upload response")
  }
  return StoredFileRecordViewSchema.parse((value as { data: unknown }).data)
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

  async getMe(): Promise<AuthMeView> {
    // API returns the app-facing envelope { data: { user, session } }
    // (sendData + AuthMeViewSchema). Unwrap so callers keep the { user, session }
    // shape, matching web (packages/web-next/lib/api.ts getMe).
    const res = await this.request<{ data: AuthMeView }>("/auth/me")
    return res.data
  }

  async updateMe(data: UpdateMeInput) {
    const res = await this.request<{ data: AuthMeView }>("/auth/me", {
      method: "PUT",
      body: JSON.stringify(data),
    })
    return res.data
  }

  async getWorkspaces(): Promise<WorkspaceListView> {
    const res = await this.request<{ data: WorkspaceListView }>("/workspaces")
    return res.data
  }

  async createWorkspace(
    name: string,
    description?: string
  ): Promise<WorkspaceCreateResultView> {
    const body: WorkspaceCreateInput =
      description === undefined ? { name } : { name, description }
    // App-facing create returns the `{ data }` envelope (appRoute + sendData).
    // Unwrap so callers keep the bare create-result payload (e.g. `workspace.id`).
    const res = await this.request<{ data: WorkspaceCreateResultView }>(
      "/workspaces",
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    )
    return res.data
  }

  async getActors(workspaceId: string): Promise<Actor[]> {
    const res = await this.request<{ data: Actor[] }>(
      `/workspaces/${workspaceId}/actors`
    )
    return res.data
  }

  async getMyRelationshipProfile(
    workspaceId: string
  ): Promise<RelationshipProfileView> {
    const res = await this.request<{ data: RelationshipProfileView }>(
      `/workspaces/${workspaceId}/me/relationship-profile`
    )
    return res.data
  }

  async updateMyRelationshipProfile(
    workspaceId: string,
    input: UpdateMemberRelationshipProfileInput
  ): Promise<RelationshipProfileView> {
    const res = await this.request<{ data: RelationshipProfileView }>(
      `/workspaces/${workspaceId}/me/relationship-profile`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      }
    )
    return res.data
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

  async getWorkspaceChiefActorPreference(
    workspaceId: string
  ): Promise<WorkspaceChiefActorPreference> {
    // App-facing route now returns the `{ data }` envelope; unwrap to the bare
    // preference shape callers expect (e.g. `preference?.chiefActorId`).
    const res = await this.request<{ data: WorkspaceChiefActorPreference }>(
      `/workspaces/${workspaceId}/preferences/chief-actor`
    )
    return res.data
  }

  async updateWorkspaceChiefActorPreference(
    workspaceId: string,
    data: WorkspaceChiefActorPreferenceInput
  ): Promise<WorkspaceChiefActorPreference> {
    const res = await this.request<{ data: WorkspaceChiefActorPreference }>(
      `/workspaces/${workspaceId}/preferences/chief-actor`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    )
    return res.data
  }

  async getChatBootstrap(workspaceId: string): Promise<ChatBootstrapResponse> {
    const res = await this.request<{ data: ChatBootstrapResponse }>(
      `/workspaces/${workspaceId}/chat/bootstrap`
    )
    return res.data
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

    const res = await this.request<{ data: ChatSyncResponse }>(
      `/workspaces/${workspaceId}/chat/sync${query ? `?${query}` : ""}`
    )
    return res.data
  }

  async createChatClientInstance(
    workspaceId: string,
    input?: ChatClientInstanceCreateInput
  ): Promise<ChatClientInstanceRegistrationResponse> {
    const res = await this.request<{
      data: ChatClientInstanceRegistrationResponse
    }>(`/workspaces/${workspaceId}/chat/client-instances`, {
      method: "POST",
      body: JSON.stringify({
        platform: input?.platform,
        deviceLabel: input?.deviceLabel,
        metadata: input?.metadata,
      }),
    })
    return res.data
  }

  async touchChatClientInstance(
    workspaceId: string,
    clientInstanceId: string,
    input?: ChatClientInstanceTouchInput
  ): Promise<ChatClientInstanceRegistrationResponse> {
    const res = await this.request<{
      data: ChatClientInstanceRegistrationResponse
    }>(`/workspaces/${workspaceId}/chat/client-instances/${clientInstanceId}`, {
      method: "PUT",
      body: JSON.stringify({
        platform: input?.platform,
        deviceLabel: input?.deviceLabel,
        metadata: input?.metadata,
      }),
    })
    return res.data
  }

  async createChatConversation(
    workspaceId: string,
    input: ChatConversationCreateInput
  ): Promise<ChatConversationCreateResponse> {
    const res = await this.request<{ data: ChatConversationCreateResponse }>(
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

    const res = await this.request<{ data: ChatConversationMessagesPage }>(
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
    const res = await this.request<{ data: ActorRuntimeTurnActivityDetail }>(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/actors/${actorId}/runtime-turns/${turnId}`
    )
    return res.data
  }

  async sendChatConversationMessage(
    workspaceId: string,
    conversationId: string,
    input: ChatConversationSendMessageInput
  ): Promise<ChatConversationSendMessageResponse> {
    const res = await this.request<{
      data: ChatConversationSendMessageResponse
    }>(
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

  resolveChatTask(
    workspaceId: string,
    conversationId: string,
    taskId: string,
    input: ChatTaskResolveInput
  ): Promise<ChatTaskResolveResponse> {
    return this.request<{ data: ChatTaskResolveResponse }>(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/tasks/${taskId}/respond`,
      {
        method: "POST",
        body: JSON.stringify(input),
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

  async updateChatConversationReadWatermark(
    workspaceId: string,
    conversationId: string,
    input: ChatConversationReadWatermarkInput
  ): Promise<ChatConversationReadWatermarkResponse> {
    const res = await this.request<{
      data: ChatConversationReadWatermarkResponse
    }>(
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
    const res = await this.request<{ data: { broadcast: boolean } }>(
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
    const res = await this.request<{
      data: { token: { id: string; platform: string; createdAt: Timestamp } }
    }>(`/workspaces/${workspaceId}/chat/push-tokens`, {
      method: "POST",
      body: JSON.stringify(input),
    })
    return res.data
  }

  async listChatPushTokens(workspaceId: string) {
    const res = await this.request<{
      data: { tokens: Array<{ id: string; platform: string }> }
    }>(`/workspaces/${workspaceId}/chat/push-tokens`)
    return res.data
  }

  async deleteChatPushToken(workspaceId: string, tokenId: string) {
    const res = await this.request<{ data: { deleted: boolean } }>(
      `/workspaces/${workspaceId}/chat/push-tokens/${tokenId}`,
      { method: "DELETE" }
    )
    return res.data
  }

  async uploadAsset(
    workspaceId: string,
    asset: UploadAssetInput,
    options?: UploadAssetOptions
  ): Promise<StoredFileRecordView> {
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

    const origin: FileUploadOriginInput = {
      family: "user_upload",
      system: FILE_ORIGIN_SYSTEMS.WORKSPACE_MOBILE_UPLOAD,
    }
    formData.append("origin", JSON.stringify(origin))

    const headers = new Headers()
    const authHeaders = getAuthHeaders()
    if (authHeaders) {
      Object.entries(authHeaders).forEach(([key, value]) =>
        headers.set(key, value)
      )
    }

    return new Promise<StoredFileRecordView>((resolve, reject) => {
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

      function succeed(value: StoredFileRecordView) {
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
        try {
          succeed(parseFileUploadResponseData(data))
        } catch (error) {
          fail(
            new ApiError(
              error instanceof Error
                ? error.message
                : "Malformed upload response",
              xhr.status || 500,
              undefined,
              data
            )
          )
        }
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
