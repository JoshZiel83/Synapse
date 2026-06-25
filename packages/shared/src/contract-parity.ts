/**
 * Compile-time parity assertions: hand-written response types (types/index.ts)
 * vs their independently-defined response zod schemas. FULL SCAN of every
 * hand-written type whose name EXACTLY matches a z.object/z.strictObject schema
 * (request Input/Query excluded; z.infer/z.input-led types can't drift), plus
 * verified name-mismatch pairs (e.g. FileOriginSummaryView <-> FileOriginSummary).
 *
 * NOT included: schema `XViewSchema` vs a same-stem hand type `X` where `X` is a
 * SEPARATE internal/domain type and the real response type is `XView = z.infer`
 * (drift-proof) — e.g. ModelGroup/Workspace/AuditLog. Pairing those is a false
 * coupling, so they are intentionally absent.
 *
 * A mismatch makes Expect<false> a type error and fails `npm run build:shared`
 * (this file is compiled — only *.test.ts is excluded). See the 2026-06-25
 * contract-drift fix. Extend by adding a hand-written View <-> z.object schema pair.
 */
import { z } from "zod"
import * as S from "./schemas/index.js"
import type * as T from "./types/index.js"

type Equal<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
    ? true
    : false
type Expect<TT extends true> = TT

type _ActorAccessRequestView = Expect<
  Equal<
    z.infer<typeof S.ActorAccessRequestViewSchema>,
    T.ActorAccessRequestView
  >
>
type _ActorDefinition = Expect<
  Equal<z.infer<typeof S.ActorDefinitionSchema>, T.ActorDefinition>
>
type _ActorDoc = Expect<Equal<z.infer<typeof S.ActorDocSchema>, T.ActorDoc>>
type _ActorPackageManifest = Expect<
  Equal<z.infer<typeof S.ActorPackageManifestSchema>, T.ActorPackageManifest>
>
type _ActorPackageSourceLink = Expect<
  Equal<
    z.infer<typeof S.ActorPackageSourceLinkSchema>,
    T.ActorPackageSourceLink
  >
>
type _ActorRuntimeState = Expect<
  Equal<z.infer<typeof S.ActorRuntimeStateSchema>, T.ActorRuntimeState>
>
type _ActorVersionDelta = Expect<
  Equal<z.infer<typeof S.ActorVersionDeltaSchema>, T.ActorVersionDelta>
>
type _AutomationEventSource = Expect<
  Equal<z.infer<typeof S.AutomationEventSourceSchema>, T.AutomationEventSource>
>
type _AutomationExecution = Expect<
  Equal<z.infer<typeof S.AutomationExecutionSchema>, T.AutomationExecution>
>
type _AutomationOccurrence = Expect<
  Equal<z.infer<typeof S.AutomationOccurrenceSchema>, T.AutomationOccurrence>
>
type _AutomationRule = Expect<
  Equal<z.infer<typeof S.AutomationRuleSchema>, T.AutomationRule>
>
type _AutomationWebhookEndpoint = Expect<
  Equal<
    z.infer<typeof S.AutomationWebhookEndpointSchema>,
    T.AutomationWebhookEndpoint
  >
>
type _AutomationWebhookEndpointCreateResult = Expect<
  Equal<
    z.infer<typeof S.AutomationWebhookEndpointCreateResultSchema>,
    T.AutomationWebhookEndpointCreateResult
  >
>
type _ContactHubDetailResponse = Expect<
  Equal<
    z.infer<typeof S.ContactHubDetailResponseSchema>,
    T.ContactHubDetailResponse
  >
>
type _ContactHubDirectState = Expect<
  Equal<z.infer<typeof S.ContactHubDirectStateSchema>, T.ContactHubDirectState>
>
type _ContactHubEntryRef = Expect<
  Equal<z.infer<typeof S.ContactHubEntryRefSchema>, T.ContactHubEntryRef>
>
type _ContactHubEntryView = Expect<
  Equal<z.infer<typeof S.ContactHubEntryViewSchema>, T.ContactHubEntryView>
>
type _ContactHubResponse = Expect<
  Equal<z.infer<typeof S.ContactHubResponseSchema>, T.ContactHubResponse>
>
type _ConversationMessagePreview = Expect<
  Equal<
    z.infer<typeof S.ConversationMessagePreviewSchema>,
    T.ConversationMessagePreview
  >
>
type _ConversationParticipantView = Expect<
  Equal<
    z.infer<typeof S.ConversationParticipantViewSchema>,
    T.ConversationParticipantView
  >
>
type _ConversationPresentationView = Expect<
  Equal<
    z.infer<typeof S.ConversationPresentationViewSchema>,
    T.ConversationPresentationView
  >
>
type _ConversationSummaryView = Expect<
  Equal<
    z.infer<typeof S.ConversationSummaryViewSchema>,
    T.ConversationSummaryView
  >
>
type _CurrentUserWeixinBindingSummary = Expect<
  Equal<
    z.infer<typeof S.CurrentUserWeixinBindingSummarySchema>,
    T.CurrentUserWeixinBindingSummary
  >
>
type _DingtalkDeviceFlowPollResponse = Expect<
  Equal<
    z.infer<typeof S.DingtalkDeviceFlowPollResponseSchema>,
    T.DingtalkDeviceFlowPollResponse
  >
>
type _DingtalkDeviceFlowSessionSummary = Expect<
  Equal<
    z.infer<typeof S.DingtalkDeviceFlowSessionSummarySchema>,
    T.DingtalkDeviceFlowSessionSummary
  >
>
type _DirectConversationOpenResponse = Expect<
  Equal<
    z.infer<typeof S.DirectConversationOpenResponseSchema>,
    T.DirectConversationOpenResponse
  >
>
type _FileOriginSummary = Expect<
  Equal<z.infer<typeof S.FileOriginSummaryViewSchema>, T.FileOriginSummary>
>
type _FileParseOutputView = Expect<
  Equal<z.infer<typeof S.FileParseOutputViewSchema>, T.FileParseOutputView>
>
type _FileParseRunView = Expect<
  Equal<z.infer<typeof S.FileParseRunViewSchema>, T.FileParseRunView>
>
type _FileRecordView = Expect<
  Equal<z.infer<typeof S.FileRecordViewSchema>, T.FileRecordView>
>
type _FriendRequestView = Expect<
  Equal<z.infer<typeof S.FriendRequestViewSchema>, T.FriendRequestView>
>
type _IdentitySearchMatchView = Expect<
  Equal<
    z.infer<typeof S.IdentitySearchMatchViewSchema>,
    T.IdentitySearchMatchView
  >
>
type _IdentitySearchResponse = Expect<
  Equal<
    z.infer<typeof S.IdentitySearchResponseSchema>,
    T.IdentitySearchResponse
  >
>
type _InstalledSkill = Expect<
  Equal<z.infer<typeof S.InstalledSkillSchema>, T.InstalledSkill>
>
type _MarketplaceRequirementCheck = Expect<
  Equal<
    z.infer<typeof S.MarketplaceRequirementCheckSchema>,
    T.MarketplaceRequirementCheck
  >
>
type _OneClickInstallCommands = Expect<
  Equal<
    z.infer<typeof S.OneClickInstallCommandsSchema>,
    T.OneClickInstallCommands
  >
>
type _RelationshipActorSummaryView = Expect<
  Equal<
    z.infer<typeof S.RelationshipActorSummaryViewSchema>,
    T.RelationshipActorSummaryView
  >
>
type _RelationshipMemberSummaryView = Expect<
  Equal<
    z.infer<typeof S.RelationshipMemberSummaryViewSchema>,
    T.RelationshipMemberSummaryView
  >
>
type _RelationshipProfileView = Expect<
  Equal<
    z.infer<typeof S.RelationshipProfileViewSchema>,
    T.RelationshipProfileView
  >
>
type _RelationshipRemoteAgentSummaryView = Expect<
  Equal<
    z.infer<typeof S.RelationshipRemoteAgentSummaryViewSchema>,
    T.RelationshipRemoteAgentSummaryView
  >
>
type _RelationshipScanResponse = Expect<
  Equal<
    z.infer<typeof S.RelationshipScanResponseSchema>,
    T.RelationshipScanResponse
  >
>
type _RelationshipWorkspaceSummary = Expect<
  Equal<
    z.infer<typeof S.RelationshipWorkspaceSummarySchema>,
    T.RelationshipWorkspaceSummary
  >
>
type _RemoteAgentAccessRequestView = Expect<
  Equal<
    z.infer<typeof S.RemoteAgentAccessRequestViewSchema>,
    T.RemoteAgentAccessRequestView
  >
>
type _RemoteAgentBindingView = Expect<
  Equal<
    z.infer<typeof S.RemoteAgentBindingViewSchema>,
    T.RemoteAgentBindingView
  >
>
type _RemoteAgentGroupTaskGrantView = Expect<
  Equal<
    z.infer<typeof S.RemoteAgentGroupTaskGrantViewSchema>,
    T.RemoteAgentGroupTaskGrantView
  >
>
type _RemoteAgentMachineView = Expect<
  Equal<
    z.infer<typeof S.RemoteAgentMachineViewSchema>,
    T.RemoteAgentMachineView
  >
>
type _RemoteAgentRuntimeCapabilityView = Expect<
  Equal<
    z.infer<typeof S.RemoteAgentRuntimeCapabilityViewSchema>,
    T.RemoteAgentRuntimeCapabilityView
  >
>
type _RemoteAgentRuntimeCatalogEntryView = Expect<
  Equal<
    z.infer<typeof S.RemoteAgentRuntimeCatalogEntryViewSchema>,
    T.RemoteAgentRuntimeCatalogEntryView
  >
>
type _RemoteAgentRuntimeSummaryView = Expect<
  Equal<
    z.infer<typeof S.RemoteAgentRuntimeSummaryViewSchema>,
    T.RemoteAgentRuntimeSummaryView
  >
>
type _RemoteAgentView = Expect<
  Equal<z.infer<typeof S.RemoteAgentViewSchema>, T.RemoteAgentView>
>
type _SkillAttachmentFile = Expect<
  Equal<z.infer<typeof S.SkillAttachmentFileSchema>, T.SkillAttachmentFile>
>
type _SkillFrontmatter = Expect<
  Equal<z.infer<typeof S.SkillFrontmatterSchema>, T.SkillFrontmatter>
>
type _SkillMarketplaceEntry = Expect<
  Equal<z.infer<typeof S.SkillMarketplaceEntrySchema>, T.SkillMarketplaceEntry>
>
type _SkillMarketplaceVersion = Expect<
  Equal<
    z.infer<typeof S.SkillMarketplaceVersionSchema>,
    T.SkillMarketplaceVersion
  >
>
type _SkillMarketplaceWorkspaceInstallation = Expect<
  Equal<
    z.infer<typeof S.SkillMarketplaceWorkspaceInstallationSchema>,
    T.SkillMarketplaceWorkspaceInstallation
  >
>
type _SkillMirrorSourceSummary = Expect<
  Equal<
    z.infer<typeof S.SkillMirrorSourceSummarySchema>,
    T.SkillMirrorSourceSummary
  >
>
type _SystemEvent = Expect<
  Equal<z.infer<typeof S.SystemEventSchema>, T.SystemEvent>
>
type _TaskNoticeSummary = Expect<
  Equal<z.infer<typeof S.TaskNoticeSummarySchema>, T.TaskNoticeSummary>
>
type _TransportAccountSummary = Expect<
  Equal<
    z.infer<typeof S.TransportAccountSummarySchema>,
    T.TransportAccountSummary
  >
>
type _TransportConnectorCapability = Expect<
  Equal<
    z.infer<typeof S.TransportConnectorCapabilitySchema>,
    T.TransportConnectorCapability
  >
>
type _TransportEndpointSummary = Expect<
  Equal<
    z.infer<typeof S.TransportEndpointSummarySchema>,
    T.TransportEndpointSummary
  >
>
type _TransportExternalUserSessionRef = Expect<
  Equal<
    z.infer<typeof S.TransportExternalUserSessionRefSchema>,
    T.TransportExternalUserSessionRef
  >
>
type _TransportExternalUserSummary = Expect<
  Equal<
    z.infer<typeof S.TransportExternalUserSummarySchema>,
    T.TransportExternalUserSummary
  >
>
type _TransportSessionSummary = Expect<
  Equal<
    z.infer<typeof S.TransportSessionSummarySchema>,
    T.TransportSessionSummary
  >
>
type _WeixinQrLoginSessionSummary = Expect<
  Equal<
    z.infer<typeof S.WeixinQrLoginSessionSummarySchema>,
    T.WeixinQrLoginSessionSummary
  >
>
type _WorkspaceCapabilityConversationTypePoliciesView = Expect<
  Equal<
    z.infer<typeof S.WorkspaceCapabilityConversationTypePoliciesViewSchema>,
    T.WorkspaceCapabilityConversationTypePoliciesView
  >
>
type _WorkspaceResourceView = Expect<
  Equal<z.infer<typeof S.WorkspaceResourceViewSchema>, T.WorkspaceResourceView>
>

export {}
