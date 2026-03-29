import Constants from 'expo-constants';
import type {
  CanonicalContentBlock,
  AuthSessionPersistence,
} from '@shared';
import { Platform } from 'react-native';

import { API_BASE, getDeviceLabel, getPlatformClientType, resolveApiUrl } from '@/lib/config';
import type {
  ActorListResponse,
  AuthMeResponse,
  AuthQrLoginResolveResponse,
  AuthQrLoginStatusResponse,
  AuthResponse,
  ConversationCollectionResponse,
  ConversationCreateResponse,
  ConversationSendResponse,
  UploadAssetInput,
  WorkspaceChiefActorPreference,
  WorkspaceListResponse,
  WorkspaceMemberListResponse,
} from '@/types/api';
import type { ConversationFeedPage, FileRecordView } from '@shared';

let authToken: string | null = null;

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
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
  if (data && typeof data === 'object' && 'error' in data) {
    const value = (data as { error?: unknown }).error;
    if (typeof value === 'string' && value.trim()) {
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

  if (data && typeof data === 'object') {
    return {
      data: asArray((data as { data?: unknown }).data),
    };
  }

  return { data: [] };
}

function normalizeWorkspaceMemberListResponse(data: unknown): WorkspaceMemberListResponse {
  if (Array.isArray(data)) {
    return { data };
  }

  if (data && typeof data === 'object') {
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

  if (data && typeof data === 'object') {
    const objectData = data as { actors?: unknown; data?: unknown };
    return {
      actors: asArray(objectData.actors ?? objectData.data),
    };
  }

  return { actors: [] };
}

function normalizeConversationCollectionResponse(data: unknown): ConversationCollectionResponse {
  if (Array.isArray(data)) {
    return { conversations: data };
  }

  if (data && typeof data === 'object') {
    const objectData = data as { conversations?: unknown; data?: unknown; runtimeMap?: unknown };
    return {
      conversations: asArray(objectData.conversations ?? objectData.data),
      runtimeMap:
        objectData.runtimeMap && typeof objectData.runtimeMap === 'object'
          ? (objectData.runtimeMap as Record<string, unknown>)
          : undefined,
    };
  }

  return { conversations: [] };
}

class ApiClient {
  private async request<T>(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers as HeadersInit | undefined);
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;

    if (!isFormData && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const authHeaders = getAuthHeaders();
    if (authHeaders) {
      Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value));
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
        parseErrorMessage(data, 'Request failed'),
        response.status,
        data && typeof data === 'object' && typeof (data as { code?: unknown }).code === 'string'
          ? (data as { code: string }).code
          : undefined,
        data,
      );
    }

    return data as T;
  }

  login(email: string, password: string): Promise<AuthResponse> {
    return this.request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        clientType: getPlatformClientType(),
        transport: 'token',
        sessionPersistence: 'persistent',
        deviceName: getDeviceLabel(),
        platform: `${Platform.OS} / Expo ${Constants.expoVersion ?? 'runtime'}`,
      }),
    });
  }

  logout() {
    return this.request<void>('/auth/logout', {
      method: 'POST',
      body: '{}',
    });
  }

  getMe(): Promise<AuthMeResponse> {
    return this.request<AuthMeResponse>('/auth/me');
  }

  updateMe(data: { name?: string; avatarFileId?: string | null }) {
    return this.request<AuthMeResponse>('/auth/me', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  getWorkspaces(): Promise<WorkspaceListResponse> {
    return this.request<unknown>('/workspaces').then(normalizeWorkspaceListResponse);
  }

  getWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberListResponse> {
    return this.request<unknown>(`/workspaces/${workspaceId}/members`).then(normalizeWorkspaceMemberListResponse);
  }

  getActors(workspaceId: string): Promise<ActorListResponse> {
    return this.request<unknown>(`/workspaces/${workspaceId}/actors`).then(normalizeActorListResponse);
  }

  getWorkspaceChiefActorPreference(
    workspaceId: string,
  ): Promise<WorkspaceChiefActorPreference> {
    return this.request<WorkspaceChiefActorPreference>(
      `/workspaces/${workspaceId}/preferences/chief-actor`,
    );
  }

  getConversations(workspaceId: string): Promise<ConversationCollectionResponse> {
    return this.request<unknown>(`/workspaces/${workspaceId}/conversations`).then(
      normalizeConversationCollectionResponse,
    );
  }

  createConversation(
    workspaceId: string,
    actorIds: string[],
    content?: string,
    targetActorIds?: string[],
    contentBlocks?: CanonicalContentBlock[],
  ): Promise<ConversationCreateResponse> {
    return this.request<ConversationCreateResponse>(`/workspaces/${workspaceId}/conversations`, {
      method: 'POST',
      body: JSON.stringify(
        actorIds.length === 1
          ? {
              actorId: actorIds[0],
              ...(content ? { content } : {}),
              ...(contentBlocks?.length ? { contentBlocks } : {}),
              ...(targetActorIds?.length ? { targetActorIds } : {}),
            }
          : {
              actorIds,
              ...(content ? { content } : {}),
              ...(contentBlocks?.length ? { contentBlocks } : {}),
              ...(targetActorIds?.length
                ? {
                    targetActorIds,
                    targetActorId: targetActorIds[0],
                  }
                : {}),
            },
      ),
    });
  }

  getConversationMessages(
    workspaceId: string,
    conversationId: string,
    limit = 100,
    before?: string,
  ): Promise<ConversationFeedPage> {
    const params = new URLSearchParams();
    if (limit > 0) params.set('limit', String(limit));
    if (before) params.set('before', before);
    const query = params.toString();
    return this.request<ConversationFeedPage>(
      `/workspaces/${workspaceId}/conversations/${conversationId}/messages${query ? `?${query}` : ''}`,
    );
  }

  sendConversationMessage(
    workspaceId: string,
    conversationId: string,
    contentBlocks: CanonicalContentBlock[],
    clientMessageId: string,
  ): Promise<ConversationSendResponse> {
    return this.request<ConversationSendResponse>(
      `/workspaces/${workspaceId}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          contentBlocks,
          clientMessageId,
        }),
      },
    );
  }

  markConversationRead(workspaceId: string, conversationId: string) {
    return this.request<void>(`/workspaces/${workspaceId}/conversations/${conversationId}/read`, {
      method: 'POST',
      body: '{}',
    });
  }

  async uploadAsset(workspaceId: string, asset: UploadAssetInput): Promise<FileRecordView> {
    const formData = new FormData();
    formData.append('file', {
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType,
    } as never);

    const headers = new Headers();
    const authHeaders = getAuthHeaders();
    if (authHeaders) {
      Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value));
    }

    const response = await fetch(`${API_BASE}/workspaces/${workspaceId}/files`, {
      method: 'POST',
      body: formData,
      headers,
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new ApiError(parseErrorMessage(data, 'Upload failed'), response.status, undefined, data);
    }

    return data as FileRecordView;
  }

  resolveQrLogin(token: string): Promise<AuthQrLoginResolveResponse> {
    return this.request<AuthQrLoginResolveResponse>('/auth/qr-login/resolve', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  }

  approveQrLogin(
    token: string,
    sessionPersistence: AuthSessionPersistence,
  ): Promise<AuthQrLoginStatusResponse> {
    return this.request<AuthQrLoginStatusResponse>('/auth/qr-login/approve', {
      method: 'POST',
      body: JSON.stringify({ token, sessionPersistence }),
    });
  }

  rejectQrLogin(token: string): Promise<AuthQrLoginStatusResponse> {
    return this.request<AuthQrLoginStatusResponse>('/auth/qr-login/reject', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  }
}

export const api = new ApiClient();

export function setApiAuthToken(token: string | null) {
  authToken = token;
}

export function buildAuthenticatedSource(pathOrUrl: string) {
  const headers = getAuthHeaders();
  return {
    uri: resolveApiUrl(pathOrUrl),
    ...(headers ? { headers } : {}),
  };
}
