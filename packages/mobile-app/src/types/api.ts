import type {
  Actor,
  ActorAccessRequestListResponse,
  AuthQrLoginResolveResponse,
  AuthQrLoginStatusResponse,
  AuthResponse,
  AuthSessionSummary,
  ContactHubDetailResponse,
  ContactHubEntryView,
  ContactHubResponse,
  ConversationFeedItem,
  ConversationFeedPage,
  DirectConversationOpenResponse,
  FileRecordView,
  FriendRequestListResponse,
  IdentitySearchMatchView,
  IdentitySearchResponse,
  RelationshipProfileView,
  RelationshipScanResponse,
  User,
  WorkspaceChiefActorPreference,
} from "@shared"

export interface AuthMeResponse {
  user: User
  session: AuthSessionSummary
}

export interface WorkspaceInfo {
  id: string
  name: string
  slug: string
  trustLevel?: string
}

export interface WorkspaceListResponse {
  data: WorkspaceInfo[]
}

export interface WorkspaceMemberView {
  id: string
  userId: string
  userName?: string
  userEmail?: string
  avatarUrl?: string | null
  trustLevel: string
  joinedAt: string
}

export interface WorkspaceMemberListResponse {
  data: WorkspaceMemberView[]
}

export interface ActorListResponse {
  actors: Actor[]
}

export interface ContactWorkspaceRef {
  id: string
  name: string
  slug: string
}

export interface ConversationParticipantView {
  memberId?: string
  participantId?: string
  type?: "actor" | "workspace_member" | "external"
  id?: string
  workspaceMemberId?: string
  actorId?: string
  name?: string
  title?: string
  role?: string
  conversationRole?: string
  avatarUrl?: string
  avatarEmoji?: string
  state?: string
}

export interface ConversationMessagePreview {
  content: string
  role: "user" | "assistant" | "system"
  actorName?: string
  createdAt: string
}

export interface ConversationPresentationView {
  chatType: "direct" | "group" | "virtual"
  title: string
  avatarUrl?: string
  subtitle?: string
  peer?: ConversationParticipantView
  canRename?: boolean
  canManageMembers?: boolean
}

export interface ConversationSummaryView {
  id: string
  kind: "private" | "group" | "virtual"
  boundary: "internal" | "external"
  status: "active" | "completed"
  transportKind?: string
  participants: ConversationParticipantView[]
  members: ConversationParticipantView[]
  lastMessage?: ConversationMessagePreview
  unreadCount: number
  createdAt: string
  title: string
  name: string
  avatarUrl?: string
  presentation?: ConversationPresentationView
  permissions?: {
    canManage?: boolean
    canManageMembers?: boolean
  }
  viewerParticipantId?: string
  viewerWorkspaceMemberId?: string
}

export interface ConversationMemberListResponse {
  members: ConversationParticipantView[]
}

export interface ConversationCreateResponse {
  conversationId: string
}

export interface ConversationSendResponse {
  item: ConversationFeedItem
}

export interface UploadAssetInput {
  uri: string
  name: string
  mimeType: string
  file?: Blob | File | null
}

export interface FriendIdProfileView {
  friendId: string
  searchByIdEnabled: boolean
}

export type {
  Actor,
  ActorAccessRequestListResponse,
  AuthQrLoginResolveResponse,
  AuthQrLoginStatusResponse,
  AuthResponse,
  ContactHubDetailResponse,
  ContactHubEntryView,
  ContactHubResponse,
  ConversationFeedPage,
  DirectConversationOpenResponse,
  FileRecordView,
  FriendRequestListResponse,
  IdentitySearchMatchView,
  IdentitySearchResponse,
  RelationshipProfileView,
  RelationshipScanResponse,
  WorkspaceChiefActorPreference,
}
