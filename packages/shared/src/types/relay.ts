import {
  RELAY_CATALOG_REVISION_STATUSES,
  RELAY_DELIVERY_STATUSES,
  RELAY_DEVICE_TRUST_STATUSES,
  RELAY_EXPOSURE_RUNTIME_STATUSES,
  RELAY_EXPOSURE_TRANSPORTS,
  RELAY_OPERATION_STATUSES,
  RELAY_PAIRING_STATUSES,
  RELAY_SESSION_STATUSES,
  RELAY_SYNC_MODES,
  RELAY_SYNC_SOURCE_KINDS,
  RELAY_SYNC_STATUSES,
  RELAY_TOOL_STATUSES,
} from '../constants/enums.js';

export type RelayProtocolVersion = 2;

export type RelayDeviceTrustStatus = typeof RELAY_DEVICE_TRUST_STATUSES[number];

export type RelayPairingStatus = typeof RELAY_PAIRING_STATUSES[number];

export type RelaySessionStatus = typeof RELAY_SESSION_STATUSES[number];

export type RelaySyncSourceKind = typeof RELAY_SYNC_SOURCE_KINDS[number];

export type RelaySyncMode = typeof RELAY_SYNC_MODES[number];

export type RelaySyncStatus = typeof RELAY_SYNC_STATUSES[number];

export type RelayExposureRuntimeStatus = typeof RELAY_EXPOSURE_RUNTIME_STATUSES[number];

export type RelayExposureTransport = typeof RELAY_EXPOSURE_TRANSPORTS[number];

export type RelayCatalogRevisionStatus = typeof RELAY_CATALOG_REVISION_STATUSES[number];

export type RelayToolStatus = typeof RELAY_TOOL_STATUSES[number];

export type RelayOperationStatus = typeof RELAY_OPERATION_STATUSES[number];

export type RelayDeliveryStatus = typeof RELAY_DELIVERY_STATUSES[number];

export type RelayOperationErrorCode =
  | 'mcp_unavailable'
  | 'tool_removed'
  | 'tool_definition_changed'
  | 'tool_execution_failed'
  | 'authorization_required'
  | 'delivery_timed_out'
  | 'delivery_rejected'
  | 'operation_cancelled'
  | 'operation_expired';

export interface RelayVisibleToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RelayHiddenToolBinding {
  exposureId: string;
  catalogRevisionId: string;
  toolId: string;
  toolRevisionId: string;
}

export interface RelayCatalogToolSnapshot {
  binding: RelayHiddenToolBinding;
  visible: RelayVisibleToolDefinition;
  definitionHash: string;
}

export interface RelayOperationTarget {
  deviceId: string;
  exposureId: string;
  catalogRevisionId: string;
  toolId: string;
  toolRevisionId: string;
  visibleToolName: string;
}

export interface RelayOperationError {
  code: RelayOperationErrorCode;
  message: string;
  retryable: boolean;
  requiresReplan?: boolean;
  currentToolRevisionId?: string;
}

export interface RelayDispatchEnvelope<TPayload = Record<string, unknown>> {
  protocolVersion: RelayProtocolVersion;
  sessionId: string;
  operationId: string;
  deliveryId: string;
  payload: TPayload;
}

export interface RelayPairingSessionView {
  id: string;
  workspaceId: string;
  requestedByWorkspaceMemberId?: string;
  deviceId?: string;
  serverBaseUrl: string;
  requestedDisplayName?: string;
  pairingCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  status: RelayPairingStatus;
  expiresAt: string;
  confirmedAt?: string;
  consumedAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RelaySyncSourceView {
  id: string;
  sourceKind: RelaySyncSourceKind;
  sourceKey: string;
  configPath?: string;
  syncMode: RelaySyncMode;
  status: RelaySyncStatus;
  lastSyncedAt?: string;
  lastError?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RelayToolView {
  id: string;
  stableKey: string;
  currentName: string;
  status: RelayToolStatus;
  latestRevisionId?: string;
  catalogRevisionId?: string;
  catalogRevisionSeq?: number;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  definitionHash?: string;
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RelayExposureView {
  id: string;
  stableKey: string;
  displayName: string;
  transport: RelayExposureTransport;
  runtimeStatus: RelayExposureRuntimeStatus;
  workspaceConversationTypeMask: number;
  conversationTypeMaskOverride?: number | null;
  effectiveConversationTypeMask: number;
  lastSeenAt?: string;
  lastHealthyAt?: string;
  lastError?: string;
  metadata: Record<string, unknown>;
  syncSource?: RelaySyncSourceView;
  tools: RelayToolView[];
  createdAt: string;
  updatedAt: string;
}

export interface RelayDeviceSummaryView {
  id: string;
  workspaceId: string;
  ownerWorkspaceMemberId?: string;
  displayName: string;
  clientKind: string;
  platform?: string;
  publicKeyFingerprint: string;
  trustStatus: RelayDeviceTrustStatus;
  isConnected: boolean;
  exposureCount: number;
  healthyExposureCount: number;
  degradedExposureCount: number;
  failedExposureCount: number;
  offlineExposureCount: number;
  toolCount: number;
  syncSourceCount: number;
  lastSeenAt?: string;
  lastConnectedAt?: string;
  lastCatalogChangedAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RelayDeviceDetailView {
  device: RelayDeviceSummaryView;
  pairings: RelayPairingSessionView[];
  syncSources: RelaySyncSourceView[];
  exposures: RelayExposureView[];
}

export interface RelayDashboardView {
  devices: RelayDeviceSummaryView[];
  pendingPairings: RelayPairingSessionView[];
}

export interface RelayLocalDesktopStatusView {
  status: string;
  version: string;
  relay?: string;
  paired: boolean;
  serverIdentityPinned?: boolean;
  authFailureCode?: string;
  authFailureMessage?: string;
  authFailurePermanent?: boolean;
  deviceId?: string;
  displayName?: string;
  serverBaseUrl?: string;
  websocketUrl?: string;
  publicKeyFingerprint?: string;
  serverTlsPublicKeyPin?: string;
}

export interface RelayLocalDesktopPairingResponse {
  accepted: boolean;
  message?: string;
}
