import type {
  ActorDocVisibility,
  ActorRole,
  InviteTrustLevel,
  MemoryCategory,
  MemoryIndexStatus,
  MemoryRecallType,
  MemorySpaceType,
  MemoryItemState,
  PluginAuthConnectionStatus,
  PluginAuthSessionStatus,
  SessionInterruptType,
  SessionStatus,
  SessionWakeupSourceType,
  SessionWakeupStatus,
  TaskNoticeStatus,
  WorkspaceAppGrantPermission,
  WorkspaceAppGrantRequestStatus,
  WorkspaceAppGrantSource,
  WorkspaceAppGrantStatus,
  WorkspaceAppKind,
  WorkspaceAppStatus,
} from "@synapse/shared"
import {
  ACCESS_BINDABLE_RESOURCE_TYPES,
  ACCESS_BINDING_SOURCES,
  ACCESS_BINDING_STATUSES,
  SUBJECT_KINDS,
  TOOL_SOURCE_KINDS,
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
  CONTACT_TARGET_TYPES,
  MEMORY_SPACE_TYPES,
  MODEL_GROUP_GRANT_SCOPES,
  MODEL_GROUP_ROUTING_STRATEGIES,
  PLATFORM_ACCESS_KEYS,
  RELATIONSHIP_APPROVAL_MODES,
  RELATIONSHIP_REQUEST_STATUSES,
  RUNTIME_AUTHORIZATION_GRANT_RETENTIONS,
  RUNTIME_AUTHORIZATION_GRANT_STATUSES,
  RUNTIME_AUTHORIZATION_REQUEST_MODES,
  PLUGIN_SPEC_TRANSPORTS,
  DEVICE_EXPOSURE_TRANSPORTS,
  TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES,
  TRANSPORT_ACCOUNT_OWNER_SCOPES,
  TRANSPORT_ACCOUNT_STATUSES,
  TRANSPORT_CONNECTION_MODES,
  TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES,
  TRANSPORT_KINDS,
  WORKSPACE_ACCESS_KEYS,
} from "@synapse/shared/constants"
import type { DeviceExposureTransport as DeviceProtocolExposureTransport } from "@synapse/device-protocol"
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
  MemoryItemsCategory,
  MemoryItemsIndexStatus,
  MemoryItemsState,
  MemoryRecallRunsRecallType,
  ModelGroupsRoutingStrategy,
  PlatformAccessBindingsAccessKey,
  PluginAuthSessionsStatus,
  PluginConnectionsStatus,
  RuntimeAuthorizationGrantsRetention,
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
  ToolCallTasksLifecycleStatus,
  PluginPackageVersionSpecsTransport,
  TransportAccountsConnectionMode,
  TransportAccountsInboundActorMode,
  TransportAccountsOwnerScope,
  TransportAccountsStatus,
  TransportAccountsTransportKind,
  ConversationTransportBindingsInboundActorMode,
  WorkspaceAccessBindingsAccessKey,
  WorkspaceAppGrantPermission as DbWorkspaceAppGrantPermission,
  WorkspaceAppGrantRequestsStatus as DbWorkspaceAppGrantRequestsStatus,
  WorkspaceAppGrantsSource as DbWorkspaceAppGrantsSource,
  WorkspaceAppGrantsStatus as DbWorkspaceAppGrantsStatus,
  WorkspaceAppsKind as DbWorkspaceAppsKind,
  WorkspaceAppsStatus as DbWorkspaceAppsStatus,
  WorkspaceInvitesTrustLevel,
  ToolCallsSourceKind,
} from "./generated/db.js"

type IsEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type Assert<T extends true> = T

type _InviteTrustLevelMatchesDb = Assert<
  IsEqual<InviteTrustLevel, WorkspaceInvitesTrustLevel>
>
// Plugin catalog spec transport set must equal the DB enum
// (plugin_package_version_specs.transport). Adding "sse" to the shared tuple
// and the schema.sql ENUM keeps these in lockstep.
type _PluginSpecTransportMatchesDb = Assert<
  IsEqual<
    (typeof PLUGIN_SPEC_TRANSPORTS)[number],
    PluginPackageVersionSpecsTransport
  >
>
// The device-exposure transport tuple is duplicated across the @synapse/shared
// and @synapse/device-protocol package boundaries; assert they never drift.
type _DeviceExposureTransportSharedMatchesProtocol = Assert<
  IsEqual<
    (typeof DEVICE_EXPOSURE_TRANSPORTS)[number],
    DeviceProtocolExposureTransport
  >
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
// subject-scope-refactor: MemorySpacesSpaceType DB enum dropped at cutover;
// memory_spaces now keyed by (owner_subject_id, scope_subject_id?, namespace_key).
// MEMORY_SPACE_TYPES tuple remains in shared as a pure UI taxonomy / legacy
// label set with no DB-side counterpart to assert equality against.
// type _MemorySpaceTypeListMatchesDb removed.
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
// type _MemorySpaceTypeMatchesDb removed (see comment above).
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
    Extract<ToolCallTasksLifecycleStatus, "completed" | "failed" | "cancelled">
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

// ============ Access / authorization enum alignment (P5) ============

type _SubjectKindMatchesDb = Assert<
  IsEqual<(typeof SUBJECT_KINDS)[number], SubjectKind>
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
type _WorkspaceAppKindMatchesDb = Assert<
  IsEqual<WorkspaceAppKind, DbWorkspaceAppsKind>
>
type _WorkspaceAppStatusMatchesDb = Assert<
  IsEqual<WorkspaceAppStatus, DbWorkspaceAppsStatus>
>
type _WorkspaceAppGrantPermissionMatchesDb = Assert<
  IsEqual<WorkspaceAppGrantPermission, DbWorkspaceAppGrantPermission>
>
type _WorkspaceAppGrantStatusMatchesDb = Assert<
  IsEqual<WorkspaceAppGrantStatus, DbWorkspaceAppGrantsStatus>
>
type _WorkspaceAppGrantSourceMatchesDb = Assert<
  IsEqual<WorkspaceAppGrantSource, DbWorkspaceAppGrantsSource>
>
type _WorkspaceAppGrantRequestStatusMatchesDb = Assert<
  IsEqual<WorkspaceAppGrantRequestStatus, DbWorkspaceAppGrantRequestsStatus>
>
// external-first-class-subject: conversation_participants.participant_type
// column + the conversation_participants_type DB enum have been dropped. The
// participant type is now derived from the joined access_subjects.kind via
// subjectKindToParticipantType. CONVERSATION_PARTICIPANT_TYPES remains a pure
// application/API-layer enum (the API still exposes a derived participantType).
// Note: the historical actor/remote-agent access-policy enum + columns have
// been dropped (P2). Contact approval now travels as a boolean
// `requiresContactApproval` field instead of an application enum.
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
// subject-scope-refactor: RuntimeAuthorizationGrantsScope DB enum dropped at cutover.
// scope is now expressed via runtime_authorization_grants.subject_id + scope_subject_id.
// type _RuntimeAuthorizationGrantScopeMatchesDb deleted with the enum.
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
// Tool provenance & routing: routed source family must equal the DB enum
// (tool_calls.source_kind).
type _ToolSourceKindMatchesDb = Assert<
  IsEqual<(typeof TOOL_SOURCE_KINDS)[number], ToolCallsSourceKind>
>

export {}
