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

export interface ConversationParticipantView {
  memberId?: string;
  participantId?: string;
  type?: "actor" | "workspace_member" | "external";
  id?: string;
  workspaceMemberId?: string;
  actorId?: string;
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
  boundary: "internal" | "external";
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
  file?: Blob | File | null;
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
  kind:
    | "workspace-actor"
    | "workspace-member"
    | "friend-actor"
    | "friend-member";
  id: string;
}

export interface IdentitySearchMatchView {
  profileId: string;
  targetType: "member" | "actor";
  title: string;
  subtitle?: string;
  avatarUrl?: string;
  avatarEmoji?: string;
  workspace: WorkspaceInfo;
  workspaceMemberId?: string;
  userId?: string;
  actorId?: string;
  state:
    | "same_workspace_member"
    | "friend"
    | "pending_request"
    | "requestable"
    | "existing"
    | "available"
    | "approval_required"
    | "pending_approval";
  contact?: ContactHubEntryRef;
  conversationId?: string;
  requestId?: string;
}

export interface IdentitySearchResponse {
  query: string;
  outcome: "empty" | "invalid" | "self" | "not_found" | "found";
  matches: IdentitySearchMatchView[];
}

export interface ContactHubEntryView {
  kind:
    | "workspace-actor"
    | "workspace-member"
    | "friend-actor"
    | "friend-member";
  id: string;
  targetType: "member" | "actor";
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

export interface RelationshipMemberSummaryView {
  workspace: WorkspaceInfo;
  workspaceMemberId: string;
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
  requester?: RelationshipMemberSummaryView | null;
  targetType: "member" | "actor";
  targetMember?: RelationshipMemberSummaryView | null;
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
  requester?: RelationshipMemberSummaryView | null;
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
  workspaceMembers: ContactHubEntryView[];
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
    | "same_workspace_member"
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
