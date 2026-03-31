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
  workspaceMemberId?: string;
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
  workspaceMemberId?: string;
  actorId?: string;
  userId?: string;
  name?: string;
  title?: string;
  role?: string;
  conversationRole?: string;
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

export interface ConversationPresentationView {
  chatType: "direct" | "group" | "virtual";
  title: string;
  avatarUrl?: string;
  subtitle?: string;
  peer?: ConversationParticipantView;
  canRename?: boolean;
  canManageMembers?: boolean;
}

export interface ConversationSummaryView {
  id: string;
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
  presentation?: ConversationPresentationView;
  permissions?: {
    canManage?: boolean;
    canManageMembers?: boolean;
  };
  viewerParticipantId?: string;
  viewerWorkspaceMemberId?: string;
}

export interface ConversationCollectionResponse {
  conversations: ConversationSummaryView[];
  runtimeMap?: Record<string, unknown>;
}

export interface ConversationMemberListResponse {
  members: ConversationParticipantView[];
}

export interface ConversationCreateResponse {
  conversationId: string;
}

export interface ConversationSendResponse {
  item: ConversationFeedItem;
}

export interface UploadAssetInput {
  uri: string;
  name: string;
  mimeType: string;
}

export interface RelationshipProfileView {
  subjectType: "user" | "actor";
  approvalMode: "auto" | "manual";
  qrToken: string;
  qrUrl: string;
  accessPolicy?: "workspace_open" | "approval_required";
}

export interface FriendIdProfileView {
  friendId: string;
  searchByIdEnabled: boolean;
}

export interface ContactHubEntryRef {
  kind: "workspace-actor" | "workspace-user" | "friend-actor" | "friend-user";
  id: string;
}

export interface FriendIdSearchMatchView {
  profileId: string;
  title: string;
  subtitle?: string;
  avatarUrl?: string;
  workspace: WorkspaceInfo;
  userId: string;
  state:
    | "same_workspace_user"
    | "friend"
    | "pending_request"
    | "requestable";
  contact?: ContactHubEntryRef;
  conversationId?: string;
  requestId?: string;
}

export interface FriendIdSearchResponse {
  query: string;
  outcome: "empty" | "invalid" | "self" | "not_found" | "found";
  matches: FriendIdSearchMatchView[];
}

export interface ContactHubEntryView {
  kind: "workspace-actor" | "workspace-user" | "friend-actor" | "friend-user";
  id: string;
  targetType: "user" | "actor";
  title: string;
  subtitle?: string;
  avatarUrl?: string;
  avatarEmoji?: string;
  workspace: WorkspaceInfo;
  workspaceMemberId?: string;
  userId?: string;
  actorId?: string;
  relationLabel: string;
  directState: {
    status:
      | "existing"
      | "available"
      | "approval_required"
      | "pending_approval";
    conversationId?: string;
  };
}

export interface RelationshipUserSummaryView {
  workspace: WorkspaceInfo;
  userId: string;
  name: string;
  email: string;
  avatarFileId?: string | null;
  trustLevel?: string;
}

export interface RelationshipActorSummaryView {
  workspace: WorkspaceInfo;
  actorId: string;
  name: string;
  title: string;
  role: string;
  avatarStoredName?: string | null;
  avatarEmoji?: string | null;
  accessPolicy: "workspace_open" | "approval_required";
}

export interface FriendRequestView {
  id: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  requester?: RelationshipUserSummaryView | null;
  targetType: "user" | "actor";
  targetUser?: RelationshipUserSummaryView | null;
  targetActor?: RelationshipActorSummaryView | null;
}

export interface FriendRequestListResponse {
  incoming: FriendRequestView[];
  outgoing: FriendRequestView[];
}

export interface ActorAccessRequestView {
  id: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  requester?: RelationshipUserSummaryView | null;
  actor?: RelationshipActorSummaryView | null;
}

export interface ActorAccessRequestListResponse {
  incoming: ActorAccessRequestView[];
  outgoing: ActorAccessRequestView[];
}

export interface ContactHubResponse {
  requestSummary: {
    friendPendingCount: number;
    actorAccessPendingCount: number;
    totalPendingCount: number;
  };
  workspaceActors: ContactHubEntryView[];
  workspaceUsers: ContactHubEntryView[];
  friends: ContactHubEntryView[];
  groups: ConversationSummaryView[];
}

export interface ContactHubDetailResponse {
  contact: ContactHubEntryView;
  groups: ConversationSummaryView[];
}

export interface RelationshipScanResponse {
  outcome:
    | "self_scan"
    | "same_workspace_user"
    | "friend_active"
    | "friend_request_created"
    | "friend_request_pending"
    | "actor_access_granted"
    | "actor_access_request_created"
    | "actor_access_pending";
  requestId?: string;
  contact?: ContactHubEntryRef;
}

export interface DirectConversationOpenResponse {
  status: "ready" | "pending_approval";
  created?: boolean;
  conversationId?: string;
  requestId?: string;
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
