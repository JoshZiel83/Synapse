import type {
  ActorDocVisibility,
  ActorRole,
  AuthClientType,
  AuthSessionPersistence,
  AuthTransport,
  InviteTrustLevel,
  MemoryCategory,
  MemoryIndexStatus,
  MemoryRecallType,
  MemorySpaceType,
  MemoryItemState,
  PluginAuthConnectionStatus,
  PluginAuthOwnerScope,
  PluginAuthSessionStatus,
  SessionInterruptType,
  SessionStatus,
  SessionWakeupSourceType,
  SessionWakeupStatus,
  TaskNoticeStatus,
} from "@synapse/shared"
import {
  ACCESS_BINDABLE_RESOURCE_TYPES,
  ACCESS_BINDING_SOURCES,
  ACCESS_BINDING_STATUSES,
  SUBJECT_KINDS,
} from "@synapse/shared"
import {
  AUTOMATION_COMPLETION_STATUSES,
  AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS,
  AUTOMATION_EVENT_SOURCE_STATUSES,
  AUTOMATION_INTEGRATION_INGRESS_KINDS,
  AUTOMATION_INTEGRATION_PROVIDERS,
  AUTOMATION_INTEGRATION_TARGET_KINDS,
  AUTOMATION_RULE_STATUSES,
  AUTOMATION_SCHEDULE_KINDS,
  AUTOMATION_TARGET_POLICIES,
  AUTOMATION_TRIGGER_KINDS,
  AUTOMATION_TRIGGER_SOURCE_KINDS,
  ATTACHMENT_TARGET_TYPES,
  CONTACT_TARGET_TYPES,
  CONVERSATION_PARTICIPANT_TYPES,
  MEMORY_SPACE_TYPES,
  MODEL_GROUP_GRANT_SCOPES,
  MODEL_GROUP_ROUTING_STRATEGIES,
  PLATFORM_ACCESS_KEYS,
  RELATIONSHIP_ACCESS_POLICIES,
  RELATIONSHIP_APPROVAL_MODES,
  RELATIONSHIP_REQUEST_STATUSES,
  RUNTIME_AUTHORIZATION_GRANT_RETENTIONS,
  RUNTIME_AUTHORIZATION_GRANT_SCOPES,
  RUNTIME_AUTHORIZATION_GRANT_STATUSES,
  RUNTIME_AUTHORIZATION_REQUEST_MODES,
  TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES,
  TRANSPORT_ACCOUNT_OWNER_SCOPES,
  TRANSPORT_ACCOUNT_STATUSES,
  TRANSPORT_CONNECTION_MODES,
  TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES,
  TRANSPORT_KINDS,
  WORKSPACE_ACCESS_KEYS,
} from "@synapse/shared/constants"
import type {
  CatalogVersionFilesFileRole,
  ActorsRole,
  ActorVersionDocsVisibility,
  AutomationDeliveriesTargetPolicy,
  AutomationEventSourcesProviderKind,
  AutomationEventSourcesStatus,
  AutomationIntegrationBindingsIngressKind,
  AutomationIntegrationBindingsProvider,
  AutomationIntegrationBindingsTargetKind,
  AutomationPoliciesCompletionStatus,
  AutomationRulesStatus,
  AutomationTriggersScheduleKind,
  AutomationTriggersSourceKind,
  AutomationTriggersTriggerKind,
  AuthQrLoginRequestsApprovedSessionPersistence,
  AuthSessionsClientType,
  AuthSessionsTransport,
  ConversationParticipantsType,
  InteractionRequestsStatus,
  MemoryItemsCategory,
  MemoryItemsIndexStatus,
  MemoryItemsState,
  MemoryRecallRunsRecallType,
  MemorySpacesSpaceType,
  ModelGroupsRoutingStrategy,
  PlatformAccessBindingsAccessKey,
  PluginAuthSessionsStatus,
  PluginConnectionsOwnerScope,
  PluginConnectionsStatus,
  RuntimeAuthorizationGrantsRetention,
  RuntimeAuthorizationGrantsScope,
  RuntimeAuthorizationGrantsStatus,
  RuntimeAuthorizationRequestMode,
  RelationshipApprovalMode,
  RelationshipRequestStatus,
  ResourceAccessBindingResourceType,
  ResourceAccessBindingsSource,
  ResourceAccessBindingsStatus,
  SubjectKind,
  SessionInterruptsType,
  SessionsStatus,
  SessionWakeupsSourceType,
  SessionWakeupsStatus,
  ToolCallTasksStatus,
  TransportAccountsConnectionMode,
  TransportAccountsInboundActorMode,
  TransportAccountsOwnerScope,
  TransportAccountsStatus,
  TransportAccountsTransportKind,
  ConversationTransportBindingsInboundActorMode,
  WorkspaceAccessBindingsAccessKey,
  WorkspaceInvitesTrustLevel,
} from "./generated/db.js"

type IsEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type Assert<T extends true> = T

type _AuthClientTypeMatchesDb = Assert<
  IsEqual<AuthClientType, AuthSessionsClientType>
>
type _AuthTransportMatchesDb = Assert<
  IsEqual<AuthTransport, AuthSessionsTransport>
>
type _AuthSessionPersistenceMatchesDb = Assert<
  IsEqual<AuthSessionPersistence, AuthQrLoginRequestsApprovedSessionPersistence>
>
type _InviteTrustLevelMatchesDb = Assert<
  IsEqual<InviteTrustLevel, WorkspaceInvitesTrustLevel>
>
type _PlatformAccessKeyMatchesDb = Assert<
  IsEqual<
    (typeof PLATFORM_ACCESS_KEYS)[number],
    PlatformAccessBindingsAccessKey
  >
>
type _WorkspaceAccessKeyMatchesDb = Assert<
  IsEqual<
    (typeof WORKSPACE_ACCESS_KEYS)[number],
    WorkspaceAccessBindingsAccessKey
  >
>
type _ModelGroupRoutingStrategyMatchesDb = Assert<
  IsEqual<
    (typeof MODEL_GROUP_ROUTING_STRATEGIES)[number],
    ModelGroupsRoutingStrategy
  >
>
// P1b: `model_group_grants_grant_scope` enum was dropped; grant scope is now
// inferred from the access_subjects row's `kind`. MODEL_GROUP_GRANT_SCOPES
// remains a pure application-layer enum (used by API request bodies + the
// translation layer in model-groups/service.ts → SubjectRef).
type _ActorRoleMatchesDb = Assert<IsEqual<ActorRole, ActorsRole>>
type _ActorDocVisibilityMatchesDb = Assert<
  IsEqual<ActorDocVisibility, ActorVersionDocsVisibility>
>
type _MemorySpaceTypeListMatchesDb = Assert<
  IsEqual<(typeof MEMORY_SPACE_TYPES)[number], MemorySpacesSpaceType>
>
// Note: the Postgres `relationship_target_type` enum was dropped along with
// its column users by the P1b polymorphic-FK collapse (all subject FKs now go
// through `access_subjects.subject_id`). `CONTACT_TARGET_TYPES` is a pure
// application-layer constant with no DB-side counterpart to assert against.
type _AutomationTriggerKindMatchesDb = Assert<
  IsEqual<
    (typeof AUTOMATION_TRIGGER_KINDS)[number],
    AutomationTriggersTriggerKind
  >
>
type _AutomationTriggerSourceKindMatchesDb = Assert<
  IsEqual<
    (typeof AUTOMATION_TRIGGER_SOURCE_KINDS)[number],
    AutomationTriggersSourceKind
  >
>
type _AutomationScheduleKindMatchesDb = Assert<
  IsEqual<
    (typeof AUTOMATION_SCHEDULE_KINDS)[number],
    AutomationTriggersScheduleKind
  >
>
type _AutomationCompletionStatusMatchesDb = Assert<
  IsEqual<
    (typeof AUTOMATION_COMPLETION_STATUSES)[number],
    AutomationPoliciesCompletionStatus
  >
>
type _AutomationTargetPolicyMatchesDb = Assert<
  IsEqual<
    (typeof AUTOMATION_TARGET_POLICIES)[number],
    AutomationDeliveriesTargetPolicy
  >
>
type _AutomationRuleStatusMatchesDb = Assert<
  IsEqual<(typeof AUTOMATION_RULE_STATUSES)[number], AutomationRulesStatus>
>
type _AutomationIntegrationProviderMatchesDb = Assert<
  IsEqual<
    (typeof AUTOMATION_INTEGRATION_PROVIDERS)[number],
    AutomationIntegrationBindingsProvider
  >
>
type _AutomationIntegrationIngressKindMatchesDb = Assert<
  IsEqual<
    (typeof AUTOMATION_INTEGRATION_INGRESS_KINDS)[number],
    AutomationIntegrationBindingsIngressKind
  >
>
type _AutomationIntegrationTargetKindMatchesDb = Assert<
  IsEqual<
    (typeof AUTOMATION_INTEGRATION_TARGET_KINDS)[number],
    AutomationIntegrationBindingsTargetKind
  >
>
type _AutomationEventSourceProviderKindMatchesDb = Assert<
  IsEqual<
    (typeof AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS)[number],
    AutomationEventSourcesProviderKind
  >
>
type _AutomationEventSourceStatusMatchesDb = Assert<
  IsEqual<
    (typeof AUTOMATION_EVENT_SOURCE_STATUSES)[number],
    AutomationEventSourcesStatus
  >
>
type _MemorySpaceTypeMatchesDb = Assert<
  IsEqual<MemorySpaceType, MemorySpacesSpaceType>
>
type _MemoryCategoryMatchesDb = Assert<
  IsEqual<MemoryCategory, MemoryItemsCategory>
>
type _MemoryItemStateMatchesDb = Assert<
  IsEqual<MemoryItemState, MemoryItemsState>
>
type _MemoryIndexStatusMatchesDb = Assert<
  IsEqual<MemoryIndexStatus, MemoryItemsIndexStatus>
>
type _MemoryRecallTypeMatchesDb = Assert<
  IsEqual<MemoryRecallType, MemoryRecallRunsRecallType>
>
type _SessionStatusMatchesDb = Assert<IsEqual<SessionStatus, SessionsStatus>>
type _SessionInterruptTypeMatchesDb = Assert<
  IsEqual<SessionInterruptType, SessionInterruptsType>
>
type _SessionWakeupSourceTypeMatchesDb = Assert<
  IsEqual<SessionWakeupSourceType, SessionWakeupsSourceType>
>
type _SessionWakeupStatusMatchesDb = Assert<
  IsEqual<SessionWakeupStatus, SessionWakeupsStatus>
>
type _TransportAccountOwnerScopeMatchesDb = Assert<
  IsEqual<
    (typeof TRANSPORT_ACCOUNT_OWNER_SCOPES)[number],
    TransportAccountsOwnerScope
  >
>
type _TransportAccountInboundActorModeMatchesDb = Assert<
  IsEqual<
    (typeof TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES)[number],
    TransportAccountsInboundActorMode
  >
>
type _TransportConversationInboundActorModeMatchesDb = Assert<
  IsEqual<
    (typeof TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES)[number],
    ConversationTransportBindingsInboundActorMode
  >
>
type _TransportKindMatchesDb = Assert<
  IsEqual<(typeof TRANSPORT_KINDS)[number], TransportAccountsTransportKind>
>
type _TransportConnectionModeMatchesDb = Assert<
  IsEqual<
    (typeof TRANSPORT_CONNECTION_MODES)[number],
    TransportAccountsConnectionMode
  >
>
type _TransportAccountStatusMatchesDb = Assert<
  IsEqual<(typeof TRANSPORT_ACCOUNT_STATUSES)[number], TransportAccountsStatus>
>
type _PluginAuthOwnerScopeMatchesDb = Assert<
  IsEqual<PluginAuthOwnerScope, PluginConnectionsOwnerScope>
>
type _PluginAuthSessionStatusMatchesDb = Assert<
  IsEqual<PluginAuthSessionStatus, PluginAuthSessionsStatus>
>
type _PluginAuthConnectionStatusMatchesDb = Assert<
  IsEqual<PluginAuthConnectionStatus, PluginConnectionsStatus>
>
// Relay enum assertions were removed in PR #20 along with the relay_* tables.
type _TaskNoticeStatusMatchesTerminalToolTaskStatuses = Assert<
  IsEqual<
    TaskNoticeStatus,
    Extract<ToolCallTasksStatus, "completed" | "failed" | "cancelled">
  >
>
type _CatalogFileRoleMatchesDb = Assert<
  IsEqual<
    Extract<
      CatalogVersionFilesFileRole,
      "document" | "reference" | "script" | "image" | "json" | "binary"
    >,
    CatalogVersionFilesFileRole
  >
>
type _InteractionRequestStatusHasAppTerminalStates = Assert<
  IsEqual<
    Extract<
      InteractionRequestsStatus,
      | "pending"
      | "answered"
      | "approved"
      | "rejected"
      | "cancelled"
      | "expired"
      | "superseded"
    >,
    InteractionRequestsStatus
  >
>

// ============ Access / authorization enum alignment (P5) ============

type _SubjectKindMatchesDb = Assert<
  IsEqual<(typeof SUBJECT_KINDS)[number], SubjectKind>
>
type _AccessBindableResourceTypeMatchesDb = Assert<
  IsEqual<
    (typeof ACCESS_BINDABLE_RESOURCE_TYPES)[number],
    ResourceAccessBindingResourceType
  >
>
type _AccessBindingStatusMatchesDb = Assert<
  IsEqual<
    (typeof ACCESS_BINDING_STATUSES)[number],
    ResourceAccessBindingsStatus
  >
>
type _AccessBindingSourceMatchesDb = Assert<
  IsEqual<(typeof ACCESS_BINDING_SOURCES)[number], ResourceAccessBindingsSource>
>
// P1b: plugin_installations.attachment_target_type column + the DB enum
// have been dropped. ATTACHMENT_TARGET_TYPES remains a pure application-layer
// enum used at the API layer / translated to SubjectKind via
// buildPluginAttachmentSubjectRef.
type _ConversationParticipantTypeMatchesDb = Assert<
  IsEqual<
    (typeof CONVERSATION_PARTICIPANT_TYPES)[number],
    ConversationParticipantsType
  >
>
// Note: the historical `actor_access_policy` Postgres enum + the
// `actors.access_policy` / `remote_agents.access_policy` columns have been
// dropped (P2). `RELATIONSHIP_ACCESS_POLICIES` is now a pure
// application-layer constant (input to `setAccessPolicy` / API request bodies)
// with no DB-side counterpart to assert equality against.
type _RelationshipApprovalModeMatchesDb = Assert<
  IsEqual<
    (typeof RELATIONSHIP_APPROVAL_MODES)[number],
    RelationshipApprovalMode
  >
>
type _RelationshipRequestStatusMatchesDb = Assert<
  IsEqual<
    (typeof RELATIONSHIP_REQUEST_STATUSES)[number],
    RelationshipRequestStatus
  >
>
type _RuntimeAuthorizationGrantScopeMatchesDb = Assert<
  IsEqual<
    (typeof RUNTIME_AUTHORIZATION_GRANT_SCOPES)[number],
    RuntimeAuthorizationGrantsScope
  >
>
type _RuntimeAuthorizationGrantStatusMatchesDb = Assert<
  IsEqual<
    (typeof RUNTIME_AUTHORIZATION_GRANT_STATUSES)[number],
    RuntimeAuthorizationGrantsStatus
  >
>
type _RuntimeAuthorizationGrantRetentionMatchesDb = Assert<
  IsEqual<
    (typeof RUNTIME_AUTHORIZATION_GRANT_RETENTIONS)[number],
    RuntimeAuthorizationGrantsRetention
  >
>
type _RuntimeAuthorizationRequestModeMatchesDb = Assert<
  IsEqual<
    (typeof RUNTIME_AUTHORIZATION_REQUEST_MODES)[number],
    RuntimeAuthorizationRequestMode
  >
>

export {}
