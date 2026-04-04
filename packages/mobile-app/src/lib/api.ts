import Constants from "expo-constants";
import type {
  AuthSessionPersistence,
  CanonicalContentBlock,
  ChatBootstrapResponse,
  ChatClientInstanceRegistrationResponse,
  ChatConversationCreateResponse,
  ChatConversationMessagesQuery,
  ChatConversationMessagesPage,
  ChatConversationReadWatermarkInput,
  ChatConversationReadWatermarkResponse,
  ChatConversationSendMessageInput,
  ChatConversationSendMessageResponse,
  ChatSyncResponse,
} from "@shared";
import { Platform } from "react-native";

import {
  API_BASE,
  getDeviceLabel,
  getPlatformClientType,
  resolveApiUrl,
} from "@/lib/config";
import type {
  ActorAccessRequestListResponse,
  ActorListResponse,
  AuthMeResponse,
  AuthQrLoginResolveResponse,
  AuthQrLoginStatusResponse,
  AuthResponse,
  ContactHubDetailResponse,
  ContactHubResponse,
  DirectConversationOpenResponse,
  FriendIdProfileView,
  IdentitySearchResponse,
  FriendRequestListResponse,
  RelationshipProfileView,
  RelationshipScanResponse,
  UploadAssetInput,
  WorkspaceChiefActorPreference,
  WorkspaceInfo,
  WorkspaceListResponse,
  WorkspaceMemberListResponse,
} from "@/types/api";
import type { FileRecordView } from "@shared";

let authToken: string | null = null;

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(
    message: string,
    status: number,
    code?: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function getAuthHeaders() {
  return authToken
    ? {
        Authorization: `Bearer ${authToken}`,
      }
    : undefined;
}

function parseErrorMessage(data: unknown, fallback: string) {
  if (data && typeof data === "object" && "error" in data) {
    const value = (data as { error?: unknown }).error;
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return fallback;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeWorkspaceListResponse(data: unknown): WorkspaceListResponse {
  if (Array.isArray(data)) {
    return { data };
  }

  if (data && typeof data === "object") {
    return {
      data: asArray((data as { data?: unknown }).data),
    };
  }

  return { data: [] };
}

function normalizeWorkspaceMemberListResponse(
  data: unknown,
): WorkspaceMemberListResponse {
  if (Array.isArray(data)) {
    return { data };
  }

  if (data && typeof data === "object") {
    return {
      data: asArray((data as { data?: unknown }).data),
    };
  }

  return { data: [] };
}

function normalizeActorListResponse(data: unknown): ActorListResponse {
  if (Array.isArray(data)) {
    return { actors: data };
  }

  if (data && typeof data === "object") {
    const objectData = data as { actors?: unknown; data?: unknown };
    return {
      actors: asArray(objectData.actors ?? objectData.data),
    };
  }

  return { actors: [] };
}

class ApiClient {
  private async request<T>(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers as HeadersInit | undefined);
    const isFormData =
      typeof FormData !== "undefined" && options.body instanceof FormData;

    if (!isFormData && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const authHeaders = getAuthHeaders();
    if (authHeaders) {
      Object.entries(authHeaders).forEach(([key, value]) =>
        headers.set(key, value),
      );
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    if (response.status === 204) {
      return null as T;
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new ApiError(
        parseErrorMessage(data, "Request failed"),
        response.status,
        data &&
          typeof data === "object" &&
          typeof (data as { code?: unknown }).code === "string"
          ? (data as { code: string }).code
          : undefined,
        data,
      );
    }

    return data as T;
  }

  login(email: string, password: string): Promise<AuthResponse> {
    return this.request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        clientType: getPlatformClientType(),
        transport: "token",
        sessionPersistence: "persistent",
        deviceName: getDeviceLabel(),
        platform: `${Platform.OS} / Expo ${Constants.expoVersion ?? "runtime"}`,
      }),
    });
  }

  register(name: string, email: string, password: string): Promise<AuthResponse> {
    return this.request<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name,
        email,
        password,
        clientType: getPlatformClientType(),
        transport: "token",
        sessionPersistence: "persistent",
        deviceName: getDeviceLabel(),
        platform: `${Platform.OS} / Expo ${Constants.expoVersion ?? "runtime"}`,
      }),
    });
  }

  logout() {
    return this.request<void>("/auth/logout", {
      method: "POST",
      body: "{}",
    });
  }

  getMe(): Promise<AuthMeResponse> {
    return this.request<AuthMeResponse>("/auth/me");
  }

  updateMe(data: { name?: string; avatarFileId?: string | null }) {
    return this.request<AuthMeResponse>("/auth/me", {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  getWorkspaces(): Promise<WorkspaceListResponse> {
    return this.request<unknown>("/workspaces").then(
      normalizeWorkspaceListResponse,
    );
  }

  createWorkspace(name: string, description?: string): Promise<WorkspaceInfo> {
    return this.request<WorkspaceInfo>("/workspaces", {
      method: "POST",
      body: JSON.stringify({
        name,
        description,
      }),
    });
  }

  getWorkspaceMembers(
    workspaceId: string,
  ): Promise<WorkspaceMemberListResponse> {
    return this.request<unknown>(`/workspaces/${workspaceId}/members`).then(
      normalizeWorkspaceMemberListResponse,
    );
  }

  getActors(workspaceId: string): Promise<ActorListResponse> {
    return this.request<unknown>(`/workspaces/${workspaceId}/actors`).then(
      normalizeActorListResponse,
    );
  }

  getMyRelationshipProfile(
    workspaceId: string,
  ): Promise<RelationshipProfileView> {
    return this.request<RelationshipProfileView>(
      `/workspaces/${workspaceId}/me/friend-profile`,
    );
  }

  getMyFriendIdProfile(workspaceId: string): Promise<FriendIdProfileView> {
    return this.request<FriendIdProfileView>(
      `/workspaces/${workspaceId}/me/friend-id`,
    );
  }

  updateMyFriendIdProfile(
    workspaceId: string,
    input: {
      friendId?: string;
      searchByIdEnabled?: boolean;
    },
  ): Promise<FriendIdProfileView> {
    return this.request<FriendIdProfileView>(
      `/workspaces/${workspaceId}/me/friend-id`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
    );
  }

  updateMyRelationshipProfile(
    workspaceId: string,
    input: { approvalMode: "auto" | "manual" },
  ): Promise<RelationshipProfileView> {
    return this.request<RelationshipProfileView>(
      `/workspaces/${workspaceId}/me/friend-profile`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
    );
  }

  getActorRelationshipProfile(
    workspaceId: string,
    actorId: string,
  ): Promise<RelationshipProfileView> {
    return this.request<RelationshipProfileView>(
      `/workspaces/${workspaceId}/actors/${actorId}/friend-profile`,
    );
  }

  updateActorRelationshipProfile(
    workspaceId: string,
    actorId: string,
    input: {
      approvalMode: "auto" | "manual";
      accessPolicy?: "workspace_open" | "approval_required";
    },
  ): Promise<RelationshipProfileView> {
    return this.request<RelationshipProfileView>(
      `/workspaces/${workspaceId}/actors/${actorId}/friend-profile`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
    );
  }

  scanRelationshipQr(
    workspaceId: string,
    token: string,
  ): Promise<RelationshipScanResponse> {
    return this.request<RelationshipScanResponse>(
      `/workspaces/${workspaceId}/relationship-qr/scan`,
      {
        method: "POST",
        body: JSON.stringify({ token }),
      },
    );
  }

  searchIdentity(
    workspaceId: string,
    query: string,
  ): Promise<IdentitySearchResponse> {
    const params = new URLSearchParams();
    if (query.trim()) {
      params.set("q", query.trim());
    }
    return this.request<IdentitySearchResponse>(
      `/workspaces/${workspaceId}/identity-search${
        params.size > 0 ? `?${params.toString()}` : ""
      }`,
    );
  }

  requestIdentityProfile(
    workspaceId: string,
    profileId: string,
  ): Promise<RelationshipScanResponse> {
    return this.request<RelationshipScanResponse>(
      `/workspaces/${workspaceId}/identity-search/request`,
      {
        method: "POST",
        body: JSON.stringify({ profileId }),
      },
    );
  }

  getContactHub(workspaceId: string): Promise<ContactHubResponse> {
    return this.request<ContactHubResponse>(
      `/workspaces/${workspaceId}/contact-hub`,
    );
  }

  getContactHubDetail(
    workspaceId: string,
    contactKind:
      | "workspace-actor"
      | "workspace-member"
      | "friend-actor"
      | "friend-member",
    contactId: string,
  ): Promise<ContactHubDetailResponse> {
    return this.request<ContactHubDetailResponse>(
      `/workspaces/${workspaceId}/contact-hub/${contactKind}/${contactId}`,
    );
  }

  getFriendRequests(workspaceId: string): Promise<FriendRequestListResponse> {
    return this.request<FriendRequestListResponse>(
      `/workspaces/${workspaceId}/friend-requests`,
    );
  }

  approveFriendRequest(workspaceId: string, requestId: string) {
    return this.request<{ request: unknown }>(
      `/workspaces/${workspaceId}/friend-requests/${requestId}/approve`,
      { method: "POST", body: "{}" },
    );
  }

  rejectFriendRequest(workspaceId: string, requestId: string) {
    return this.request<{ request: unknown }>(
      `/workspaces/${workspaceId}/friend-requests/${requestId}/reject`,
      { method: "POST", body: "{}" },
    );
  }

  getActorAccessRequests(
    workspaceId: string,
  ): Promise<ActorAccessRequestListResponse> {
    return this.request<ActorAccessRequestListResponse>(
      `/workspaces/${workspaceId}/actor-access-requests`,
    );
  }

  approveActorAccessRequest(workspaceId: string, requestId: string) {
    return this.request<{ request: unknown }>(
      `/workspaces/${workspaceId}/actor-access-requests/${requestId}/approve`,
      { method: "POST", body: "{}" },
    );
  }

  rejectActorAccessRequest(workspaceId: string, requestId: string) {
    return this.request<{ request: unknown }>(
      `/workspaces/${workspaceId}/actor-access-requests/${requestId}/reject`,
      { method: "POST", body: "{}" },
    );
  }

  openDirectConversation(
    workspaceId: string,
    input: {
      contactKind:
        | "workspace-actor"
        | "workspace-member"
        | "friend-actor"
        | "friend-member";
      contactId: string;
    },
  ): Promise<DirectConversationOpenResponse> {
    return this.request<DirectConversationOpenResponse>(
      `/workspaces/${workspaceId}/direct-conversations/open`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }

  getWorkspaceChiefActorPreference(
    workspaceId: string,
  ): Promise<WorkspaceChiefActorPreference> {
    return this.request<WorkspaceChiefActorPreference>(
      `/workspaces/${workspaceId}/preferences/chief-actor`,
    );
  }

  updateWorkspaceChiefActorPreference(
    workspaceId: string,
    data: { chiefActorId: string | null },
  ): Promise<WorkspaceChiefActorPreference> {
    return this.request<WorkspaceChiefActorPreference>(
      `/workspaces/${workspaceId}/preferences/chief-actor`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      },
    );
  }

  getChatBootstrap(workspaceId: string): Promise<ChatBootstrapResponse> {
    return this.request<ChatBootstrapResponse>(
      `/workspaces/${workspaceId}/chat/bootstrap`,
    );
  }

  getChatSync(
    workspaceId: string,
    input?: { cursor?: number; limit?: number },
  ): Promise<ChatSyncResponse> {
    const params = new URLSearchParams();
    if (typeof input?.cursor === "number") {
      params.set("cursor", String(input.cursor));
    }
    if (typeof input?.limit === "number") {
      params.set("limit", String(input.limit));
    }
    const query = params.toString();

    return this.request<ChatSyncResponse>(
      `/workspaces/${workspaceId}/chat/sync${query ? `?${query}` : ""}`,
    );
  }

  registerChatClientInstance(
    workspaceId: string,
    clientInstanceId: string,
    input?: {
      platform?: string;
      deviceLabel?: string;
      metadata?: Record<string, unknown>;
    },
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
      },
    );
  }

  createChatConversation(
    workspaceId: string,
    input: {
      clientRequestId: string;
      kind: "group" | "private" | "virtual";
      boundary?: "internal" | "external";
      title?: string;
      workspaceMemberIds?: string[];
      actorIds?: string[];
      metadata?: Record<string, unknown>;
    },
  ): Promise<ChatConversationCreateResponse> {
    return this.request<ChatConversationCreateResponse>(
      `/workspaces/${workspaceId}/chat/conversations`,
      {
        method: "POST",
        body: JSON.stringify({
          clientRequestId: input.clientRequestId,
          kind: input.kind,
          boundary: input.boundary,
          title: input.title,
          workspaceMemberIds: input.workspaceMemberIds ?? [],
          actorIds: input.actorIds ?? [],
          metadata: input.metadata,
        }),
      },
    );
  }

  getChatConversationMessages(
    workspaceId: string,
    conversationId: string,
    input?: ChatConversationMessagesQuery,
  ): Promise<ChatConversationMessagesPage> {
    const params = new URLSearchParams();
    if (typeof input?.afterSequence === "number") {
      params.set("afterSequence", String(input.afterSequence));
    }
    if (typeof input?.beforeSequence === "number") {
      params.set("beforeSequence", String(input.beforeSequence));
    }
    if (typeof input?.limit === "number") {
      params.set("limit", String(input.limit));
    }
    if (input?.clientInstanceId) {
      params.set("clientInstanceId", input.clientInstanceId);
    }
    const query = params.toString();

    return this.request<ChatConversationMessagesPage>(
      `/workspaces/${workspaceId}/chat/conversations/${conversationId}/messages${query ? `?${query}` : ""}`,
    );
  }

  sendChatConversationMessage(
    workspaceId: string,
    conversationId: string,
    input: ChatConversationSendMessageInput,
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
      },
    );
  }

  updateChatConversationReadWatermark(
    workspaceId: string,
    conversationId: string,
    input: ChatConversationReadWatermarkInput,
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
      },
    );
  }

  async uploadAsset(
    workspaceId: string,
    asset: UploadAssetInput,
  ): Promise<FileRecordView> {
    const formData = new FormData();
    formData.append("file", {
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType,
    } as never);

    const headers = new Headers();
    const authHeaders = getAuthHeaders();
    if (authHeaders) {
      Object.entries(authHeaders).forEach(([key, value]) =>
        headers.set(key, value),
      );
    }

    const response = await fetch(
      `${API_BASE}/workspaces/${workspaceId}/files`,
      {
        method: "POST",
        body: formData,
        headers,
      },
    );

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new ApiError(
        parseErrorMessage(data, "Upload failed"),
        response.status,
        undefined,
        data,
      );
    }

    return data as FileRecordView;
  }

  resolveQrLogin(token: string): Promise<AuthQrLoginResolveResponse> {
    return this.request<AuthQrLoginResolveResponse>("/auth/qr-login/resolve", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  }

  approveQrLogin(
    token: string,
    sessionPersistence: AuthSessionPersistence,
  ): Promise<AuthQrLoginStatusResponse> {
    return this.request<AuthQrLoginStatusResponse>("/auth/qr-login/approve", {
      method: "POST",
      body: JSON.stringify({ token, sessionPersistence }),
    });
  }

  rejectQrLogin(token: string): Promise<AuthQrLoginStatusResponse> {
    return this.request<AuthQrLoginStatusResponse>("/auth/qr-login/reject", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  }
}

export const api = new ApiClient();

export function setApiAuthToken(token: string | null) {
  authToken = token;
}

export function getApiAuthToken() {
  return authToken;
}

export function buildAuthenticatedSource(pathOrUrl: string) {
  const headers = getAuthHeaders();
  return {
    uri: resolveApiUrl(pathOrUrl),
    ...(headers ? { headers } : {}),
  };
}
