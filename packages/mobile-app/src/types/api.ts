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
  WorkspaceFeedEventRecord,
  WorkspaceChiefActorPreference,
} from "@shared";

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

export interface ContactWorkspaceRef {
  id: string;
  name: string;
  slug: string;
}

export interface ScopedContactActorView {
  id: string;
  workspaceId: string;
  name: string;
  title?: string;
  role?: string;
  avatarUrl?: string | null;
  avatarEmoji?: string;
}

export interface ScopedContactUserView {
  id: string;
  workspaceId: string;
  name?: string;
  email?: string;
  avatarUrl?: string | null;
}

export interface ScopedContactView {
  id: string;
  scope: "workspace" | "personal";
  targetType: "actor" | "user";
  targetWorkspace: ContactWorkspaceRef;
  actor: ScopedContactActorView | null;
  user: ScopedContactUserView | null;
  createdAt: string;
}

export interface ScopedContactsResponse {
  workspaceContacts: ScopedContactView[];
  personalContacts: ScopedContactView[];
}

export interface ContactDiscoveryActorView {
  targetType: "actor";
  actorId: string;
  name: string;
  title?: string;
  role?: string;
  avatarUrl?: string | null;
  avatarEmoji?: string;
  targetWorkspace: ContactWorkspaceRef;
  alreadyInWorkspaceContacts: boolean;
  alreadyInPersonalContacts: boolean;
}

export interface ContactDiscoveryUserView {
  targetType: "user";
  userId: string;
  name?: string;
  email?: string;
  avatarUrl?: string | null;
  targetWorkspace: ContactWorkspaceRef;
  alreadyInWorkspaceContacts: boolean;
  alreadyInPersonalContacts: boolean;
}

export interface ContactDiscoveryResponse {
  actors: ContactDiscoveryActorView[];
  users: ContactDiscoveryUserView[];
}

export interface ConversationParticipantView {
  memberId?: string;
  participantId?: string;
  type?: "actor" | "user" | "external";
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
  role: "user" | "assistant" | "system";
  actorName?: string;
  createdAt: string;
}

export interface ConversationSummaryView {
  id: string;
  domain: "workspace" | "social";
  kind: "private" | "group" | "virtual";
  status: "active" | "completed";
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

export interface ThreadCollectionResponse {
  threads: ConversationSummaryView[];
  runtimeMap?: Record<string, unknown>;
}

export interface ConversationMemberListResponse {
  members: ConversationParticipantView[];
}

export interface ThreadCreateResponse {
  threadId: string;
}

export interface ConversationSendResponse {
  item: ConversationFeedItem;
}

export interface UploadAssetInput {
  uri: string;
  name: string;
  mimeType: string;
}

export interface WorkspaceFeedPageResponse {
  records: WorkspaceFeedEventRecord[];
  hasMore: boolean;
  nextAfter?: number;
  after?: number;
  limit?: number;
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
