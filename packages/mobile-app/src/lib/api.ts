import Constants from "expo-constants";
import type { CanonicalContentBlock, AuthSessionPersistence } from "@shared";
import { Platform } from "react-native";

import {
  API_BASE,
  getDeviceLabel,
  getPlatformClientType,
  resolveApiUrl,
} from "@/lib/config";
import type {
  ActorListResponse,
  AuthMeResponse,
  AuthQrLoginResolveResponse,
  AuthQrLoginStatusResponse,
  AuthResponse,
  ContactDiscoveryResponse,
  ConversationCollectionResponse,
  ConversationCreateResponse,
  ConversationMemberListResponse,
  ConversationSendResponse,
  ScopedContactsResponse,
  UploadAssetInput,
  WorkspaceChiefActorPreference,
  WorkspaceListResponse,
  WorkspaceMemberListResponse,
} from "@/types/api";
import type { ConversationFeedPage, FileRecordView } from "@shared";

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

function normalizeConversationCollectionResponse(
  data: unknown,
): ConversationCollectionResponse {
  if (Array.isArray(data)) {
    return { conversations: data };
  }

  if (data && typeof data === "object") {
    const objectData = data as {
      conversations?: unknown;
      runtimeMap?: unknown;
    };
    return {
      conversations: asArray(objectData.conversations),
      runtimeMap:
        objectData.runtimeMap && typeof objectData.runtimeMap === "object"
          ? (objectData.runtimeMap as Record<string, unknown>)
          : undefined,
    };
  }

  return { conversations: [] };
}

function normalizeScopedContactsResponse(data: unknown): ScopedContactsResponse {
  if (data && typeof data === "object") {
    return {
      workspaceContacts: asArray(
        (data as { workspaceContacts?: unknown }).workspaceContacts,
      ),
      personalContacts: asArray(
        (data as { personalContacts?: unknown }).personalContacts,
      ),
    };
  }

  return {
    workspaceContacts: [],
    personalContacts: [],
  };
}

function normalizeContactDiscoveryResponse(
  data: unknown,
): ContactDiscoveryResponse {
  if (data && typeof data === "object") {
    return {
      actors: asArray((data as { actors?: unknown }).actors),
      users: asArray((data as { users?: unknown }).users),
    };
  }

  return {
    actors: [],
    users: [],
  };
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

  getScopedContacts(workspaceId: string): Promise<ScopedContactsResponse> {
    return this.request<unknown>(`/workspaces/${workspaceId}/contacts`).then(
      normalizeScopedContactsResponse,
    );
  }

  discoverContacts(
    workspaceId: string,
    queryText = "",
    limit = 20,
  ): Promise<ContactDiscoveryResponse> {
    const params = new URLSearchParams();
    if (queryText.trim()) {
      params.set("q", queryText.trim());
    }
    if (limit > 0) {
      params.set("limit", String(limit));
    }

    return this.request<unknown>(
      `/workspaces/${workspaceId}/contacts/discover${
        params.size > 0 ? `?${params.toString()}` : ""
      }`,
    ).then(normalizeContactDiscoveryResponse);
  }

  createWorkspaceContact(
    workspaceId: string,
    input:
      | {
          targetType: "actor";
          targetWorkspaceId: string;
          targetActorId: string;
        }
      | {
          targetType: "user";
          targetWorkspaceId: string;
          targetUserId: string;
        },
  ) {
    return this.request<{ contact: unknown }>(
      `/workspaces/${workspaceId}/contacts/workspace`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }

  createPersonalContact(
    workspaceId: string,
    input:
      | {
          targetType: "actor";
          targetWorkspaceId: string;
          targetActorId: string;
        }
      | {
          targetType: "user";
          targetWorkspaceId: string;
          targetUserId: string;
        },
  ) {
    return this.request<{ contact: unknown }>(
      `/workspaces/${workspaceId}/contacts/personal`,
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

  getThreads(workspaceId: string): Promise<ConversationCollectionResponse> {
    return this.request<unknown>(
      `/conversations?${new URLSearchParams({ workspaceId }).toString()}`,
    ).then(normalizeConversationCollectionResponse);
  }

  getThread(threadId: string) {
    return this.request<{ conversation: unknown }>(
      `/conversations/${threadId}`,
    ).then(
      (data) => ({
        conversation: (data?.conversation || null) as any,
      }),
    );
  }

  createThread(input: {
    domain: "workspace" | "social";
    kind: "private" | "group";
    workspaceId?: string;
    actorIds?: string[];
    userIds?: string[];
    title?: string;
    content?: string;
    contentBlocks?: CanonicalContentBlock[];
    targetActorIds?: string[];
  }): Promise<ConversationCreateResponse> {
    return this.request<ConversationCreateResponse>("/conversations", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getThreadMessages(
    threadId: string,
    limit = 100,
    before?: string,
  ): Promise<ConversationFeedPage> {
    const params = new URLSearchParams();
    if (limit > 0) params.set("limit", String(limit));
    if (before) params.set("before", before);
    const query = params.toString();
    return this.request<ConversationFeedPage>(
      `/conversations/${threadId}/messages${query ? `?${query}` : ""}`,
    );
  }

  getThreadMembers(threadId: string): Promise<ConversationMemberListResponse> {
    return this.request<ConversationMemberListResponse>(
      `/conversations/${threadId}/members`,
    );
  }

  sendThreadMessage(
    threadId: string,
    contentBlocks: CanonicalContentBlock[],
    clientMessageId: string,
  ): Promise<ConversationSendResponse> {
    return this.request<ConversationSendResponse>(
      `/conversations/${threadId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          contentBlocks,
          clientMessageId,
        }),
      },
    );
  }

  addThreadMembers(
    threadId: string,
    input: { actorIds?: string[]; userIds?: string[] },
  ): Promise<ConversationMemberListResponse> {
    return this.request<ConversationMemberListResponse>(
      `/conversations/${threadId}/members`,
      {
        method: "POST",
        body: JSON.stringify({
          actorIds: input.actorIds ?? [],
          userIds: input.userIds ?? [],
        }),
      },
    );
  }

  markThreadRead(threadId: string, readUpToSequence: number) {
    return this.request<void>(`/conversations/${threadId}/read-watermark`, {
      method: "POST",
      body: JSON.stringify({ readUpToSequence }),
    });
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
