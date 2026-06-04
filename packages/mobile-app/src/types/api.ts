import type {
  Actor,
  ActorAccessRequestListResponse,
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

export type {
  ConversationParticipantView,
  ConversationMessagePreview,
  ConversationPresentationView,
  ConversationSummaryView,
} from "@shared"

import type { ConversationParticipantView } from "@shared"

export interface ConversationMemberListResponse {
  members: ConversationParticipantView[]
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
