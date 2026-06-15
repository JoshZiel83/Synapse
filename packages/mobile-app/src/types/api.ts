import type {
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
  UpdateMemberRelationshipProfileInput,
  WorkspaceCreateResultView,
  WorkspaceChiefActorPreference,
  WorkspaceListItemView,
  WorkspaceMemberView as SharedWorkspaceMemberView,
} from "@shared"

export type WorkspaceInfo = WorkspaceListItemView
export type WorkspaceCreateResult = WorkspaceCreateResultView

export type WorkspaceMemberView = SharedWorkspaceMemberView

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

export interface UploadAssetInput {
  uri: string
  name: string
  mimeType: string
  file?: Blob | File | null
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
  UpdateMemberRelationshipProfileInput,
  WorkspaceChiefActorPreference,
}
