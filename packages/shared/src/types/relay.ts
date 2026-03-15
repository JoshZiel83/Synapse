export type RelayProtocolVersion = 2;

export type RelayDeviceTrustStatus =
  | 'pending'
  | 'active'
  | 'revoked'
  | 'blocked';

export type RelayPairingStatus =
  | 'pending'
  | 'confirmed'
  | 'consumed'
  | 'expired'
  | 'cancelled'
  | 'rejected';

export type RelaySessionStatus =
  | 'connecting'
  | 'active'
  | 'closing'
  | 'closed'
  | 'rejected';

export type RelaySyncSourceKind =
  | 'manual'
  | 'claude_code'
  | 'claude_desktop'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'custom';

export type RelaySyncMode =
  | 'import_only'
  | 'observe'
  | 'mirror'
  | 'managed'
  | 'detached';

export type RelaySyncStatus =
  | 'unknown'
  | 'idle'
  | 'syncing'
  | 'error'
  | 'disabled';

export type RelayExposureRuntimeStatus =
  | 'discovered'
  | 'starting'
  | 'healthy'
  | 'degraded'
  | 'failed'
  | 'quarantined'
  | 'offline';

export type RelayExposureTransport =
  | 'stdio'
  | 'http'
  | 'sse'
  | 'custom';

export type RelayExposureManagementMode =
  | 'manual'
  | 'imported'
  | 'mirrored'
  | 'managed';

export type RelayCatalogRevisionStatus =
  | 'active'
  | 'superseded';

export type RelayToolStatus =
  | 'active'
  | 'removed';

export type RelayOperationStatus =
  | 'created'
  | 'dispatched'
  | 'received'
  | 'started'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'expired';

export type RelayDeliveryStatus =
  | 'queued'
  | 'sent'
  | 'acked'
  | 'nacked'
  | 'timed_out'
  | 'cancelled';

export type RelayOperationErrorCode =
  | 'mcp_unavailable'
  | 'tool_removed'
  | 'tool_definition_changed'
  | 'tool_execution_failed'
  | 'delivery_timed_out'
  | 'delivery_rejected'
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
  requestedBy?: string;
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

export interface RelayDerivedInstallationView {
  installationId: string;
  pluginId: string;
  pluginSlug: string;
  pluginDisplayName: string;
}

export interface RelayExposureView {
  id: string;
  stableKey: string;
  displayName: string;
  transport: RelayExposureTransport;
  runtimeStatus: RelayExposureRuntimeStatus;
  managementMode: RelayExposureManagementMode;
  lastSeenAt?: string;
  lastHealthyAt?: string;
  lastError?: string;
  metadata: Record<string, unknown>;
  syncSource?: RelaySyncSourceView;
  derivedInstallation?: RelayDerivedInstallationView;
  tools: RelayToolView[];
  createdAt: string;
  updatedAt: string;
}

export interface RelayDeviceSummaryView {
  id: string;
  workspaceId: string;
  ownerUserId?: string;
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
