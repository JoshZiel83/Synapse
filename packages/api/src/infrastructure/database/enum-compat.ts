import type {
  ActorDocVisibility,
  ActorRole,
  AuthClientType,
  AuthSessionPersistence,
  AuthTransport,
  InviteTrustLevel,
  MemoryCategory,
  MemoryRecallType,
  MemoryScope,
  MemoryStability,
  MemoryStatus,
  PluginAuthConnectionStatus,
  PluginAuthOwnerScope,
  PluginAuthSessionStatus,
  RelayCatalogRevisionStatus,
  RelayDeliveryStatus,
  RelayDeviceTrustStatus,
  RelayExposureRuntimeStatus,
  RelayExposureTransport,
  RelayOperationStatus,
  RelayPairingStatus,
  RelaySessionStatus,
  RelaySyncMode,
  RelaySyncSourceKind,
  RelaySyncStatus,
  RelayToolStatus,
  SessionChannelType,
  SessionInterruptType,
  SessionStatus,
  SessionWakeupSourceType,
  SessionWakeupStatus,
  TaskNoticeStatus,
} from '@synapse/shared';
import {
  AUTOMATION_COMPLETION_STATUSES,
  AUTOMATION_DELIVERY_MODES,
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
  CONVERSATION_GRANT_PERMISSIONS,
  MEMORY_SCOPES,
  MODEL_GROUP_GRANT_SCOPES,
  MODEL_GROUP_ROUTING_STRATEGIES,
  PLATFORM_ACCESS_KEYS,
  RELAY_MANAGEABLE_TRUST_STATUSES,
  TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES,
  TRANSPORT_ACCOUNT_OWNER_SCOPES,
  TRANSPORT_ACCOUNT_STATUSES,
  TRANSPORT_CONNECTION_MODES,
  TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES,
  TRANSPORT_KINDS,
  WORKSPACE_ACCESS_KEYS,
} from '@synapse/shared/constants';
import type {
  CatalogVersionFilesFileRole,
  ActorsRole,
  ActorVersionDocsVisibility,
  AutomationDeliveriesDeliveryMode,
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
  ConversationGrantsPermission,
  InteractionRequestsStatus,
  MemoryEntriesCategory,
  MemoryEntriesOwnerScope,
  MemoryEntriesStability,
  MemoryEntriesStatus,
  MemoryRecallRunsRecallType,
  ModelGroupGrantsGrantScope,
  ModelGroupsRoutingStrategy,
  PlatformAccessBindingsAccessKey,
  PluginAuthSessionsStatus,
  PluginConnectionsOwnerScope,
  PluginConnectionsStatus,
  RelayCatalogRevisionsStatus,
  RelationshipTargetType,
  RelayDeviceSessionsStatus,
  RelayDevicesTrustStatus,
  RelayExposuresRuntimeStatus,
  RelayExposuresTransport,
  RelayOperationDeliveriesStatus,
  RelayOperationsStatus,
  RelayPairingSessionsStatus,
  RelaySyncSourcesSourceKind,
  RelaySyncSourcesStatus,
  RelaySyncSourcesSyncMode,
  RelayToolsStatus,
  SessionInterruptsType,
  SessionsChannelType,
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
} from './generated/db.js';

type IsEqual<A, B> =
  [A] extends [B]
    ? ([B] extends [A] ? true : false)
    : false;

type Assert<T extends true> = T;

type _AuthClientTypeMatchesDb = Assert<IsEqual<AuthClientType, AuthSessionsClientType>>;
type _AuthTransportMatchesDb = Assert<IsEqual<AuthTransport, AuthSessionsTransport>>;
type _AuthSessionPersistenceMatchesDb = Assert<
  IsEqual<AuthSessionPersistence, AuthQrLoginRequestsApprovedSessionPersistence>
>;
type _InviteTrustLevelMatchesDb = Assert<IsEqual<InviteTrustLevel, WorkspaceInvitesTrustLevel>>;
type _PlatformAccessKeyMatchesDb = Assert<
  IsEqual<(typeof PLATFORM_ACCESS_KEYS)[number], PlatformAccessBindingsAccessKey>
>;
type _WorkspaceAccessKeyMatchesDb = Assert<
  IsEqual<(typeof WORKSPACE_ACCESS_KEYS)[number], WorkspaceAccessBindingsAccessKey>
>;
type _ModelGroupRoutingStrategyMatchesDb = Assert<
  IsEqual<(typeof MODEL_GROUP_ROUTING_STRATEGIES)[number], ModelGroupsRoutingStrategy>
>;
type _ModelGroupGrantScopeMatchesDb = Assert<
  IsEqual<(typeof MODEL_GROUP_GRANT_SCOPES)[number], ModelGroupGrantsGrantScope>
>;
type _ActorRoleMatchesDb = Assert<IsEqual<ActorRole, ActorsRole>>;
type _ActorDocVisibilityMatchesDb = Assert<IsEqual<ActorDocVisibility, ActorVersionDocsVisibility>>;
type _ResourceScopeMatchesMemoryScopeDb = Assert<
  IsEqual<(typeof MEMORY_SCOPES)[number], MemoryEntriesOwnerScope>
>;
type _ContactTargetTypeMatchesDb = Assert<
  IsEqual<(typeof CONTACT_TARGET_TYPES)[number], RelationshipTargetType>
>;
type _ConversationGrantPermissionMatchesDb = Assert<
  IsEqual<(typeof CONVERSATION_GRANT_PERMISSIONS)[number], ConversationGrantsPermission>
>;
type _AutomationTriggerKindMatchesDb = Assert<
  IsEqual<(typeof AUTOMATION_TRIGGER_KINDS)[number], AutomationTriggersTriggerKind>
>;
type _AutomationTriggerSourceKindMatchesDb = Assert<
  IsEqual<(typeof AUTOMATION_TRIGGER_SOURCE_KINDS)[number], AutomationTriggersSourceKind>
>;
type _AutomationScheduleKindMatchesDb = Assert<
  IsEqual<(typeof AUTOMATION_SCHEDULE_KINDS)[number], AutomationTriggersScheduleKind>
>;
type _AutomationCompletionStatusMatchesDb = Assert<
  IsEqual<(typeof AUTOMATION_COMPLETION_STATUSES)[number], AutomationPoliciesCompletionStatus>
>;
type _AutomationDeliveryModeMatchesDb = Assert<
  IsEqual<(typeof AUTOMATION_DELIVERY_MODES)[number], AutomationDeliveriesDeliveryMode>
>;
type _AutomationTargetPolicyMatchesDb = Assert<
  IsEqual<(typeof AUTOMATION_TARGET_POLICIES)[number], AutomationDeliveriesTargetPolicy>
>;
type _AutomationRuleStatusMatchesDb = Assert<
  IsEqual<(typeof AUTOMATION_RULE_STATUSES)[number], AutomationRulesStatus>
>;
type _AutomationIntegrationProviderMatchesDb = Assert<
  IsEqual<(typeof AUTOMATION_INTEGRATION_PROVIDERS)[number], AutomationIntegrationBindingsProvider>
>;
type _AutomationIntegrationIngressKindMatchesDb = Assert<
  IsEqual<(typeof AUTOMATION_INTEGRATION_INGRESS_KINDS)[number], AutomationIntegrationBindingsIngressKind>
>;
type _AutomationIntegrationTargetKindMatchesDb = Assert<
  IsEqual<(typeof AUTOMATION_INTEGRATION_TARGET_KINDS)[number], AutomationIntegrationBindingsTargetKind>
>;
type _AutomationEventSourceProviderKindMatchesDb = Assert<
  IsEqual<(typeof AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS)[number], AutomationEventSourcesProviderKind>
>;
type _AutomationEventSourceStatusMatchesDb = Assert<
  IsEqual<(typeof AUTOMATION_EVENT_SOURCE_STATUSES)[number], AutomationEventSourcesStatus>
>;
type _MemoryScopeMatchesDb = Assert<IsEqual<MemoryScope, MemoryEntriesOwnerScope>>;
type _MemoryCategoryMatchesDb = Assert<IsEqual<MemoryCategory, MemoryEntriesCategory>>;
type _MemoryStatusMatchesDb = Assert<IsEqual<MemoryStatus, MemoryEntriesStatus>>;
type _MemoryStabilityMatchesDb = Assert<IsEqual<MemoryStability, MemoryEntriesStability>>;
type _MemoryRecallTypeMatchesDb = Assert<IsEqual<MemoryRecallType, MemoryRecallRunsRecallType>>;
type _SessionStatusMatchesDb = Assert<IsEqual<SessionStatus, SessionsStatus>>;
type _SessionChannelMatchesDb = Assert<IsEqual<SessionChannelType, SessionsChannelType>>;
type _SessionInterruptTypeMatchesDb = Assert<IsEqual<SessionInterruptType, SessionInterruptsType>>;
type _SessionWakeupSourceTypeMatchesDb = Assert<
  IsEqual<SessionWakeupSourceType, SessionWakeupsSourceType>
>;
type _SessionWakeupStatusMatchesDb = Assert<IsEqual<SessionWakeupStatus, SessionWakeupsStatus>>;
type _TransportAccountOwnerScopeMatchesDb = Assert<
  IsEqual<(typeof TRANSPORT_ACCOUNT_OWNER_SCOPES)[number], TransportAccountsOwnerScope>
>;
type _TransportAccountInboundActorModeMatchesDb = Assert<
  IsEqual<(typeof TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES)[number], TransportAccountsInboundActorMode>
>;
type _TransportConversationInboundActorModeMatchesDb = Assert<
  IsEqual<
    (typeof TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES)[number],
    ConversationTransportBindingsInboundActorMode
  >
>;
type _TransportKindMatchesDb = Assert<
  IsEqual<(typeof TRANSPORT_KINDS)[number], TransportAccountsTransportKind>
>;
type _TransportConnectionModeMatchesDb = Assert<
  IsEqual<(typeof TRANSPORT_CONNECTION_MODES)[number], TransportAccountsConnectionMode>
>;
type _TransportAccountStatusMatchesDb = Assert<
  IsEqual<(typeof TRANSPORT_ACCOUNT_STATUSES)[number], TransportAccountsStatus>
>;
type _PluginAuthOwnerScopeMatchesDb = Assert<
  IsEqual<PluginAuthOwnerScope, PluginConnectionsOwnerScope>
>;
type _PluginAuthSessionStatusMatchesDb = Assert<
  IsEqual<PluginAuthSessionStatus, PluginAuthSessionsStatus>
>;
type _PluginAuthConnectionStatusMatchesDb = Assert<
  IsEqual<PluginAuthConnectionStatus, PluginConnectionsStatus>
>;
type _RelayDeviceTrustStatusMatchesDb = Assert<
  IsEqual<RelayDeviceTrustStatus, RelayDevicesTrustStatus>
>;
type _RelayManageableTrustStatusesAreDbSubset = Assert<
  IsEqual<
    (typeof RELAY_MANAGEABLE_TRUST_STATUSES)[number],
    Extract<RelayDevicesTrustStatus, 'active' | 'revoked' | 'blocked'>
  >
>;
type _RelayPairingStatusMatchesDb = Assert<IsEqual<RelayPairingStatus, RelayPairingSessionsStatus>>;
type _RelaySessionStatusMatchesDb = Assert<IsEqual<RelaySessionStatus, RelayDeviceSessionsStatus>>;
type _RelaySyncSourceKindMatchesDb = Assert<
  IsEqual<RelaySyncSourceKind, RelaySyncSourcesSourceKind>
>;
type _RelaySyncModeMatchesDb = Assert<IsEqual<RelaySyncMode, RelaySyncSourcesSyncMode>>;
type _RelaySyncStatusMatchesDb = Assert<IsEqual<RelaySyncStatus, RelaySyncSourcesStatus>>;
type _RelayExposureRuntimeStatusMatchesDb = Assert<
  IsEqual<RelayExposureRuntimeStatus, RelayExposuresRuntimeStatus>
>;
type _RelayExposureTransportMatchesDb = Assert<
  IsEqual<RelayExposureTransport, RelayExposuresTransport>
>;
type _RelayCatalogRevisionStatusMatchesDb = Assert<
  IsEqual<RelayCatalogRevisionStatus, RelayCatalogRevisionsStatus>
>;
type _RelayToolStatusMatchesDb = Assert<IsEqual<RelayToolStatus, RelayToolsStatus>>;
type _RelayOperationStatusMatchesDb = Assert<IsEqual<RelayOperationStatus, RelayOperationsStatus>>;
type _RelayDeliveryStatusMatchesDb = Assert<IsEqual<RelayDeliveryStatus, RelayOperationDeliveriesStatus>>;
type _TaskNoticeStatusMatchesTerminalToolTaskStatuses = Assert<
  IsEqual<TaskNoticeStatus, Extract<ToolCallTasksStatus, 'completed' | 'failed' | 'cancelled'>>
>;
type _CatalogFileRoleMatchesDb = Assert<
  IsEqual<
    Extract<
      CatalogVersionFilesFileRole,
      'document' | 'reference' | 'script' | 'image' | 'json' | 'binary'
    >,
    CatalogVersionFilesFileRole
  >
>;
type _InteractionRequestStatusHasAppTerminalStates = Assert<
  IsEqual<
    Extract<
      InteractionRequestsStatus,
      'pending' | 'answered' | 'approved_pending_apply' | 'applied' | 'rejected' | 'cancelled' | 'expired' | 'apply_failed'
    >,
    InteractionRequestsStatus
  >
>;

export {};
