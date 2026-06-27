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
// "Every arm of A is assignable to B" — distributive forall that is SAFE against
// never-absorption (`[A extends B ? never : A]` collects the arms that do NOT
// extend B; the result is `never` iff all arms extend B). The naive
// `(A extends B ? true : never) extends true` is vacuously true when an arm
// fails (`never extends true`), which silently masks drift — do not use it.
type AllAssignable<A, B> = [A extends B ? never : A] extends [never]
  ? true
  : false
// Mutual assignability in BOTH directions, per arm. Weaker than Equal — it
// tolerates runtime-equivalent REPRESENTATION differences (Omit-then-re-add
// intersection, a distributed event union) while STILL catching real field drift
// either way (a field the server emits the client rejects, OR a required field
// the client expects the server never sends — both break one direction).
type MutualAssign<A, B> =
  AllAssignable<A, B> extends true
    ? AllAssignable<B, A> extends true
      ? true
      : false
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

// ── Explicit NAME-MISMATCHED pairs ──────────────────────────────────────────
// The client's response type name differs from the route schema's name, so the
// exact-name scan above can't pair them — a route binds schema↔type by PATH,
// not by name. This was the blind spot behind the chat-method drifts. Each pair
// below is compiler-verified to hold today. (Pairs with generic-union-vs-
// discriminatedUnion or union-vs-narrowed-arm representation — chat sync/messages/
// send, the three relationship request-lists, RemoteAgentMachineDetail — are
// tracked separately; they need a type restructure, not a one-line assertion.)
type _ChatBootstrapResponse = Expect<
  Equal<z.infer<typeof S.ChatBootstrapViewSchema>, T.ChatBootstrapResponse>
>
type _ChatClientInstanceRegistrationResponse = Expect<
  Equal<
    z.infer<typeof S.ChatClientInstanceViewSchema>,
    T.ChatClientInstanceRegistrationResponse
  >
>
type _ChatConversationCreateResponse = Expect<
  Equal<
    z.infer<typeof S.ChatConversationEnvelopeViewSchema>,
    T.ChatConversationCreateResponse
  >
>
type _ChatConversationReadWatermarkResponse = Expect<
  Equal<
    z.infer<typeof S.ChatReadWatermarkViewSchema>,
    T.ChatConversationReadWatermarkResponse
  >
>
type _ActorRuntimeTurnActivityDetail = Expect<
  Equal<
    z.infer<typeof S.ChatRuntimeTurnDetailViewSchema>,
    T.ActorRuntimeTurnActivityDetail
  >
>
type _Actor = Expect<Equal<z.infer<typeof S.ActorViewSchema>, T.Actor>>
type _WorkspaceChiefActorPreference = Expect<
  Equal<
    z.infer<typeof S.WorkspaceChiefActorPreferenceViewSchema>,
    T.WorkspaceChiefActorPreference
  >
>
type _RemoteAgentMachinePairingSessionView = Expect<
  Equal<
    z.infer<typeof S.RemoteAgentMachinePairingSessionResponseSchema>,
    T.RemoteAgentMachinePairingSessionView
  >
>

// Per-route relationship request-lists: each endpoint emits one arm via its own
// presenter, so its schema is the narrowed list (not the shared 3-arm union) —
// exact Equal now holds.
type _FriendRequestListResponse = Expect<
  Equal<
    z.infer<typeof S.FriendRequestListResponseSchema>,
    T.FriendRequestListResponse
  >
>
type _ActorAccessRequestListResponse = Expect<
  Equal<
    z.infer<typeof S.ActorAccessRequestListResponseSchema>,
    T.ActorAccessRequestListResponse
  >
>
type _RemoteAgentAccessRequestListResponse = Expect<
  Equal<
    z.infer<typeof S.RemoteAgentAccessRequestListResponseSchema>,
    T.RemoteAgentAccessRequestListResponse
  >
>

// ── Representational pair (MutualAssign, not Equal) ─────────────────────────
// machine = Omit<RemoteAgentMachineView,'bindingCount'> & {bindingCount?:number}
// (re-adds the same field) + inline bindings array vs a named schema — runtime-
// identical, mutually assignable both directions; MutualAssign still catches real
// field drift.
type _RemoteAgentMachineDetailView = Expect<
  MutualAssign<
    z.infer<typeof S.RemoteAgentMachineDetailResponseSchema>,
    T.RemoteAgentMachineDetailView
  >
>

// ── KNOWN gap — NOT yet soundly assertable ──────────────────────────────────
// getChatSync / getChatConversationMessages / sendChatConversationMessage + the
// chat task-resolve 200 body. These DO bind to a schema (so they're no longer an
// invisible blind spot — the binding is documented here), but their nested unions
// — ChatConversationItem (12-arm), TaskSummary, the ChatSyncEvent payloads — do
// not satisfy Equal OR a SOUND mutual-assignability check against the schema. It
// is a mix of (a) genuine per-arm field divergence between hand type and schema
// and (b) TypeScript's non-distributive union-property assignability limits (e.g.
// `{item: bigUnion}` whole-union checks fail even where each arm is assignable).
// Asserting the earlier distributive MutualDist here PASSED only by never-
// absorption masking (the adversarial review caught this) — so they are
// deliberately NOT asserted rather than masked. They need a focused per-arm
// reconciliation of ChatConversationItem / TaskSummary / event payloads against
// their schemas (then each arm becomes Equal-assertable):
//   ChatSyncViewSchema ↔ ChatSyncResponse
//   ChatConversationMessagesViewSchema ↔ ChatConversationMessagesPage
//   ChatSendMessageViewSchema ↔ ChatConversationSendMessageResponse
//   ChatTaskRespondViewSchema ↔ ChatTaskResolveAppliedResponse

export {}
