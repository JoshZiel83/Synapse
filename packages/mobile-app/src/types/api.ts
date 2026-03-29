import type {
  Actor,
  AuthQrLoginResolveResponse,
  AuthQrLoginStatusResponse,
  AuthResponse,
  AuthSessionSummary,
  ConversationFeedItem,
  ConversationFeedPage,
  FileRecordView,
  User,
  WorkspaceChiefActorPreference,
} from '@shared';

export interface AuthMeResponse {
  user: User;
  session: AuthSessionSummary;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  slug: string;
  trustLevel?: string;
}

export interface WorkspaceListResponse {
  data: WorkspaceInfo[];
}

export interface WorkspaceMemberView {
  id: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  avatarUrl?: string | null;
  trustLevel: string;
  joinedAt: string;
}

export interface WorkspaceMemberListResponse {
  data: WorkspaceMemberView[];
}

export interface ActorListResponse {
  actors: Actor[];
}

export interface ConversationParticipantView {
  memberId?: string;
  participantId?: string;
  type?: 'actor' | 'user' | 'external';
  id?: string;
  actorId?: string;
  userId?: string;
  name?: string;
  title?: string;
  role?: string;
  avatarUrl?: string;
  avatarEmoji?: string;
  state?: string;
}

export interface ConversationMessagePreview {
  content: string;
  role: 'user' | 'assistant' | 'system';
  actorName?: string;
  createdAt: string;
}

export interface ConversationSummaryView {
  id: string;
  status: 'active' | 'completed';
  transportKind?: string;
  participants: ConversationParticipantView[];
  members: ConversationParticipantView[];
  lastMessage?: ConversationMessagePreview;
  unreadCount: number;
  createdAt: string;
  title: string;
  name: string;
  avatarUrl?: string;
  permissions?: {
    canManage?: boolean;
    canManageMembers?: boolean;
  };
}

export interface ConversationCollectionResponse {
  conversations: ConversationSummaryView[];
  runtimeMap?: Record<string, unknown>;
}

export interface ConversationCreateResponse {
  id?: string;
  conversationId?: string;
}

export interface ConversationSendResponse {
  item: ConversationFeedItem;
}

export interface UploadAssetInput {
  uri: string;
  name: string;
  mimeType: string;
}

export type {
  Actor,
  AuthQrLoginResolveResponse,
  AuthQrLoginStatusResponse,
  AuthResponse,
  ConversationFeedPage,
  FileRecordView,
  WorkspaceChiefActorPreference,
};
