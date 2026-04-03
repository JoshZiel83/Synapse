'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type {
  AutomationEventSource,
  RelayDeviceDetailView,
  RelayDeviceSummaryView,
  RelayExposureView,
} from '@synapse/shared';
import type {
  ConversationTypeKey,
  RuntimeGrantEffect,
  RuntimeGrantView,
} from '@synapse/shared/types';
import {
  CONVERSATION_TYPE_MASK_PRESETS,
  conversationTypeKeysToMask,
  conversationTypeMaskToKeys,
  relayLifecycleEventDefinitions,
} from '@synapse/shared';
import {
  ArrowLeft,
  CheckCircle2,
  FolderOpen,
  Globe,
  Loader2,
  MousePointerClick,
  Radio,
  Shield,
  Terminal,
  Unplug,
  Wifi,
  WifiOff,
  Wrench,
  XCircle,
} from 'lucide-react';

import { useWorkspace } from '@/app/dashboard/workspace-provider';
import {
  AppCard,
  AppCardContent,
  AppCardDescription,
  AppCardHeader,
  AppCardTitle,
} from '@/components/app-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  FieldDescription,
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import PluginAccessStep from '../../plugin-access-step';

function formatDateTime(value?: string) {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}

const conversationTypeOptions: Array<{
  key: ConversationTypeKey;
  label: string;
  description: string;
}> = [
  {
    key: 'internal_private',
    label: 'Internal private',
    description: 'Private conversations inside the workspace graph.',
  },
  {
    key: 'internal_group',
    label: 'Internal group',
    description: 'Workspace-local group conversations.',
  },
  {
    key: 'external_private',
    label: 'External private',
    description: 'Cross-workspace private conversations.',
  },
  {
    key: 'external_group',
    label: 'External group',
    description: 'Cross-workspace group conversations.',
  },
  {
    key: 'virtual',
    label: 'Virtual',
    description: 'Virtual or synthetic conversations.',
  },
];

const conversationTypePresets = [
  { label: 'All', value: CONVERSATION_TYPE_MASK_PRESETS.ALL },
  { label: 'Internal only', value: CONVERSATION_TYPE_MASK_PRESETS.INTERNAL_ONLY },
  { label: 'External only', value: CONVERSATION_TYPE_MASK_PRESETS.EXTERNAL_ONLY },
  { label: 'Group only', value: CONVERSATION_TYPE_MASK_PRESETS.GROUP_ONLY },
  { label: 'Private only', value: CONVERSATION_TYPE_MASK_PRESETS.PRIVATE_ONLY },
] as const;

function formatConversationTypeKeys(keys: ConversationTypeKey[]) {
  return keys
    .map((key) => conversationTypeOptions.find((option) => option.key === key)?.label || key)
    .join(', ');
}

function narrowPresetConversationTypeKeys(
  parentConversationTypeMask: number,
  presetConversationTypeMask: number,
) {
  const allowedKeys = new Set(conversationTypeMaskToKeys(parentConversationTypeMask));
  const narrowedKeys = conversationTypeMaskToKeys(presetConversationTypeMask).filter((key) =>
    allowedKeys.has(key),
  );
  if (narrowedKeys.length > 0) {
    return narrowedKeys;
  }
  return conversationTypeMaskToKeys(parentConversationTypeMask);
}

function relayTrustVariant(trustStatus: RelayDeviceSummaryView['trustStatus']) {
  switch (trustStatus) {
    case 'active':
      return 'secondary';
    case 'blocked':
    case 'revoked':
      return 'destructive';
    default:
      return 'outline';
  }
}

function exposureVariant(runtimeStatus: RelayExposureView['runtimeStatus']) {
  switch (runtimeStatus) {
    case 'healthy':
      return 'secondary';
    case 'degraded':
    case 'starting':
      return 'outline';
    default:
      return 'destructive';
  }
}

function syncSourceVariant(status: NonNullable<RelayExposureView['syncSource']>['status']) {
  switch (status) {
    case 'idle':
      return 'secondary';
    case 'syncing':
      return 'outline';
    case 'error':
      return 'destructive';
    default:
      return 'outline';
  }
}

function formatRuntimeGrantScope(scope: RuntimeGrantView['scope']) {
  switch (scope) {
    case 'once':
      return 'Allow once';
    case 'actor':
      return 'Allow this actor';
    case 'conversation':
      return 'Allow this conversation';
    case 'workspace':
      return 'Always allow';
    default:
      return scope;
  }
}

function describeRuntimeGrantEffect(effect: RuntimeGrantEffect) {
  if (effect.capability === 'filesystem') {
    return {
      icon: FolderOpen,
      summary:
        effect.access === 'read_write'
          ? 'Filesystem read and write'
          : effect.access === 'write'
            ? 'Filesystem write'
            : 'Filesystem read',
      detail: effect.path,
    };
  }
  if (effect.capability === 'commandline') {
    return {
      icon: Terminal,
      summary: `Command line: ${effect.executor}`,
      detail: effect.cwdPrefix || 'Any working directory',
    };
  }
  if (effect.capability === 'browser') {
    return {
      icon: Globe,
      summary: 'Browser automation',
      detail: 'Chrome DevTools MCP',
    };
  }
  return {
    icon: MousePointerClick,
    summary: 'Computer control',
    detail: 'CUA automation',
  };
}

export default function RelayDevicePage() {
  const params = useParams<{ relayId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { workspaceId } = useWorkspace();
  const relayId = params.relayId;

  const [relayDetail, setRelayDetail] = useState<RelayDeviceDetailView | null>(null);
  const [relayEventSources, setRelayEventSources] = useState<AutomationEventSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingRelayEventSources, setLoadingRelayEventSources] = useState(true);
  const [togglingRelaySourceKey, setTogglingRelaySourceKey] = useState<string | null>(null);
  const [runtimeGrants, setRuntimeGrants] = useState<RuntimeGrantView[]>([]);
  const [loadingRuntimeGrants, setLoadingRuntimeGrants] = useState(false);
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [savingDevicePolicy, setSavingDevicePolicy] = useState(false);
  const [deviceConversationTypeKeys, setDeviceConversationTypeKeys] = useState<ConversationTypeKey[]>(
    conversationTypeMaskToKeys(CONVERSATION_TYPE_MASK_PRESETS.ALL),
  );

  const exposureId = searchParams.get('exposureId');
  const relayAccessAdapter = useMemo(
    () => ({
      loadAccess: (targetWorkspaceId: string, targetExposureId: string) =>
        api.getRelayExposureAccess(targetWorkspaceId, relayId, targetExposureId),
      grantAccess: (
        targetWorkspaceId: string,
        targetExposureId: string,
        payload: {
          accessTarget?: {
            type: 'workspace' | 'conversation' | 'actor' | 'actor_in_conversation';
            actorId?: string;
            conversationId?: string;
          };
          conversationTypeMaskOverride?: number | null;
          permissions?: string[];
        },
      ) => api.grantRelayExposureAccess(targetWorkspaceId, relayId, targetExposureId, payload),
      revokeAccess: (
        targetWorkspaceId: string,
        targetExposureId: string,
        bindingId: string,
      ) => api.revokeRelayExposureAccess(targetWorkspaceId, relayId, targetExposureId, bindingId),
      updateGrant: (
        targetWorkspaceId: string,
        targetExposureId: string,
        bindingId: string,
        payload: {
          conversationTypeMaskOverride?: number | null;
        },
      ) =>
        api.updateRelayExposureAccessGrant(
          targetWorkspaceId,
          relayId,
          targetExposureId,
          bindingId,
          payload,
        ),
      updatePolicy: (
        targetWorkspaceId: string,
        targetExposureId: string,
        payload: {
          conversationTypeMaskOverride?: number | null;
        },
      ) => api.updateRelayExposure(targetWorkspaceId, relayId, targetExposureId, payload),
    }),
    [relayId],
  );

  const relayLifecycleSourceDefinitions = useMemo(
    () =>
      relayLifecycleEventDefinitions.map((definition) => ({
        definition,
        source: definition.buildSource({
          providerRef: relayDetail?.device.id || relayId,
          providerLabel: relayDetail?.device.title || draftName || relayId,
        }),
      })),
    [draftName, relayDetail?.device.title, relayDetail?.device.id, relayId],
  );

  const activeExposure = useMemo(() => {
    if (!relayDetail?.exposures.length) return null;
    return relayDetail.exposures.find((exposure) => exposure.id === exposureId) || relayDetail.exposures[0];
  }, [exposureId, relayDetail?.exposures]);

  const deviceWorkspaceConversationTypeMask = useMemo(
    () => relayDetail?.device.workspaceConversationTypeMask ?? CONVERSATION_TYPE_MASK_PRESETS.ALL,
    [relayDetail?.device.workspaceConversationTypeMask],
  );
  const deviceEffectiveConversationTypeMask = useMemo(
    () => relayDetail?.device.effectiveConversationTypeMask ?? deviceWorkspaceConversationTypeMask,
    [deviceWorkspaceConversationTypeMask, relayDetail?.device.effectiveConversationTypeMask],
  );
  const deviceAllowedConversationTypeKeys = useMemo(
    () => new Set(conversationTypeMaskToKeys(deviceWorkspaceConversationTypeMask)),
    [deviceWorkspaceConversationTypeMask],
  );
  const currentDeviceConversationTypeMask = useMemo(
    () =>
      conversationTypeKeysToMask(
        deviceConversationTypeKeys,
        deviceEffectiveConversationTypeMask,
      ),
    [deviceConversationTypeKeys, deviceEffectiveConversationTypeMask],
  );
  const nextDeviceConversationTypeMaskOverride = useMemo(
    () =>
      currentDeviceConversationTypeMask === deviceWorkspaceConversationTypeMask
        ? null
        : currentDeviceConversationTypeMask,
    [currentDeviceConversationTypeMask, deviceWorkspaceConversationTypeMask],
  );
  const hasDeviceConversationTypeChanges =
    currentDeviceConversationTypeMask !== deviceEffectiveConversationTypeMask;
  const selectedDeviceConversationTypeLabels = useMemo(
    () => formatConversationTypeKeys(deviceConversationTypeKeys),
    [deviceConversationTypeKeys],
  );

  async function loadRelayDetail() {
    if (!workspaceId || !relayId) return;

    setLoading(true);
    try {
      const detail = await api.getRelayDevice(workspaceId, relayId);
      setRelayDetail(detail);
      setDraftName(detail.device.title);
    } catch (error) {
      console.error('Failed to load relay detail:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to load relay');
    } finally {
      setLoading(false);
    }
  }

  async function loadRelayEventSources() {
    if (!workspaceId || !relayId) return;

    setLoadingRelayEventSources(true);
    try {
      const sources = await api.getAutomationEventSources(workspaceId, {
        providerKind: 'relay',
        providerRef: relayId,
      });
      setRelayEventSources(sources);
    } catch (error) {
      console.error('Failed to load relay automation event sources:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to load relay event sources');
    } finally {
      setLoadingRelayEventSources(false);
    }
  }

  async function loadRuntimeGrants(targetExposureId: string) {
    if (!workspaceId || !relayId || !targetExposureId) return;

    setLoadingRuntimeGrants(true);
    try {
      const result = await api.listRelayRuntimeGrants(workspaceId, relayId, targetExposureId);
      setRuntimeGrants(result.grants);
    } catch (error) {
      console.error('Failed to load relay runtime grants:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to load runtime grants');
    } finally {
      setLoadingRuntimeGrants(false);
    }
  }

  useEffect(() => {
    void loadRelayDetail();
  }, [relayId, workspaceId]);

  useEffect(() => {
    void loadRelayEventSources();
  }, [relayId, workspaceId]);

  useEffect(() => {
    if (!activeExposure || !relayDetail) return;
    if (exposureId === activeExposure.id) return;

    const next = new URLSearchParams(searchParams.toString());
    next.set('exposureId', activeExposure.id);
    router.replace(`/dashboard/plugins/relays/${relayId}?${next.toString()}`, { scroll: false });
  }, [activeExposure, exposureId, relayDetail, relayId, router, searchParams]);

  useEffect(() => {
    if (!activeExposure?.id) {
      setRuntimeGrants([]);
      return;
    }
    void loadRuntimeGrants(activeExposure.id);
  }, [activeExposure?.id, relayId, workspaceId]);

  useEffect(() => {
    if (!relayDetail?.device) return;
    setDeviceConversationTypeKeys(
      conversationTypeMaskToKeys(relayDetail.device.effectiveConversationTypeMask),
    );
  }, [relayDetail?.device]);

  async function handleSaveRelay() {
    if (!workspaceId || !relayDetail || !draftName.trim()) return;

    setSaving(true);
    try {
      await api.updateRelayDevice(workspaceId, relayDetail.device.id, { title: draftName.trim() });
      await loadRelayDetail();
      toast.success('Relay updated');
    } catch (error) {
      console.error('Failed to update relay device:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update relay');
    } finally {
      setSaving(false);
    }
  }

  function toggleDeviceConversationTypeKey(key: ConversationTypeKey) {
    if (!deviceAllowedConversationTypeKeys.has(key)) {
      return;
    }
    setDeviceConversationTypeKeys((current) => {
      const exists = current.includes(key);
      if (exists && current.length === 1) {
        return current;
      }
      return exists
        ? current.filter((item) => item !== key)
        : [...current, key];
    });
  }

  function applyDeviceConversationTypePreset(mask: number) {
    setDeviceConversationTypeKeys(
      narrowPresetConversationTypeKeys(deviceWorkspaceConversationTypeMask, mask),
    );
  }

  function resetDeviceConversationTypePolicy() {
    setDeviceConversationTypeKeys(
      conversationTypeMaskToKeys(deviceWorkspaceConversationTypeMask),
    );
  }

  async function saveDeviceConversationTypePolicy() {
    if (!workspaceId || !relayDetail || !hasDeviceConversationTypeChanges) return;

    setSavingDevicePolicy(true);
    try {
      await api.updateRelayDevice(workspaceId, relayDetail.device.id, {
        conversationTypeMaskOverride: nextDeviceConversationTypeMaskOverride,
      });
      await loadRelayDetail();
      toast.success('Device conversation policy updated');
    } catch (error) {
      console.error('Failed to update relay device policy:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update device policy');
    } finally {
      setSavingDevicePolicy(false);
    }
  }

  async function handleDisconnectRelay() {
    if (!workspaceId || !relayDetail) return;
    if (!window.confirm(`Disconnect relay device "${relayDetail.device.title}"?`)) return;

    setSaving(true);
    try {
      await api.disconnectRelayDevice(workspaceId, relayDetail.device.id);
      await loadRelayDetail();
      toast.success('Disconnect requested');
    } catch (error) {
      console.error('Failed to disconnect relay device:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to disconnect relay');
    } finally {
      setSaving(false);
    }
  }

  async function handleRevokeRuntimeGrant(grantId: string) {
    if (!workspaceId || !activeExposure) return;
    if (!window.confirm('Revoke this runtime grant?')) return;

    setRevokingGrantId(grantId);
    try {
      await api.revokeRelayRuntimeGrant(
        workspaceId,
        relayId,
        activeExposure.id,
        grantId,
      );
      await loadRuntimeGrants(activeExposure.id);
      toast.success('Runtime grant revoked');
    } catch (error) {
      console.error('Failed to revoke runtime grant:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to revoke runtime grant');
    } finally {
      setRevokingGrantId(null);
    }
  }

  async function handleDeleteRelay() {
    if (!workspaceId || !relayDetail) return;
    if (!window.confirm(`Delete relay device "${relayDetail.device.title}"?`)) return;

    setSaving(true);
    try {
      await api.deleteRelayDevice(workspaceId, relayDetail.device.id);
      toast.success('Relay deleted');
      router.push('/dashboard/plugins');
    } catch (error) {
      console.error('Failed to delete relay device:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to delete relay');
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdateRelayTrustStatus(nextTrustStatus: 'active' | 'revoked' | 'blocked') {
    if (!workspaceId || !relayDetail) return;

    const actionLabel = nextTrustStatus === 'active' ? 'reactivate' : nextTrustStatus;
    if (!window.confirm(`${actionLabel[0].toUpperCase()}${actionLabel.slice(1)} relay device "${relayDetail.device.title}"?`)) {
      return;
    }

    setSaving(true);
    try {
      await api.updateRelayTrustStatus(workspaceId, relayDetail.device.id, nextTrustStatus);
      await loadRelayDetail();
      toast.success(`Relay ${actionLabel}d`);
    } catch (error) {
      console.error('Failed to update relay trust status:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update trust status');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleRelayEventSource(sourceKey: string, enabled: boolean) {
    if (!workspaceId || !relayDetail) return;

    const entry = relayLifecycleSourceDefinitions.find((candidate) => candidate.source.sourceKey === sourceKey);
    if (!entry) return;

    const existingSource = relayEventSources.find((source) => source.sourceKey === sourceKey);
    setTogglingRelaySourceKey(sourceKey);
    try {
      if (enabled) {
        await api.createAutomationEventSource(workspaceId, {
          providerKind: 'relay',
          providerRef: relayDetail.device.id,
          sourceKey: entry.source.sourceKey,
          name: entry.source.name,
          description: entry.source.description,
          payloadSchema: entry.source.payloadSchema,
          examplePayload: entry.source.examplePayload,
          status: 'active',
          metadata: entry.source.metadata,
        });
        toast.success(`${entry.source.name} enabled`);
      } else if (existingSource) {
        await api.archiveAutomationEventSource(workspaceId, existingSource.id);
        toast.success(`${entry.source.name} disabled`);
      }

      await loadRelayEventSources();
    } catch (error) {
      console.error('Failed to update relay automation event source:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update relay event source');
    } finally {
      setTogglingRelaySourceKey(null);
    }
  }

  if (loading) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Loading relay...</div>;
  }

  if (!relayDetail) {
    return (
      <div className="flex flex-col gap-4 px-4 pb-6 pt-6 lg:px-6">
        <Button type="button" variant="outline" size="sm" onClick={() => router.push('/dashboard/plugins')}>
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
        <div className="rounded-3xl border border-dashed border-border px-6 py-14 text-center text-sm text-muted-foreground">
          Relay device not found.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-6 lg:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => router.push('/dashboard/plugins')}>
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
      </div>

      <AppCard variant="panel">
        <AppCardHeader className="gap-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 items-start gap-4">
              <div className="flex size-16 items-center justify-center rounded-[20px] border border-border/70 bg-muted/30">
                <Radio className="size-7 text-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <AppCardTitle>{relayDetail.device.title}</AppCardTitle>
                  <Badge variant={relayTrustVariant(relayDetail.device.trustStatus)}>
                    {relayDetail.device.trustStatus}
                  </Badge>
                  <Badge variant={relayDetail.device.isConnected ? 'secondary' : 'outline'}>
                    {relayDetail.device.isConnected ? 'connected' : 'offline'}
                  </Badge>
                </div>
                <AppCardDescription className="mt-2 flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center gap-1.5">
                    <Wrench className="size-4" />
                    {relayDetail.device.deviceType}
                    {relayDetail.device.authorizationMode ? ` · ${relayDetail.device.authorizationMode}` : ''}
                    {relayDetail.device.platform ? ` on ${relayDetail.device.platform}` : ''}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    {relayDetail.device.isConnected ? (
                      <Wifi className="size-4" />
                    ) : (
                      <WifiOff className="size-4" />
                    )}
                    Last seen {formatDateTime(relayDetail.device.lastSeenAt)}
                  </span>
                </AppCardDescription>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void handleDisconnectRelay()} disabled={saving}>
                <Unplug data-icon="inline-start" />
                Disconnect
              </Button>
              {relayDetail.device.trustStatus === 'active' ? (
                <Button type="button" variant="outline" onClick={() => void handleUpdateRelayTrustStatus('revoked')} disabled={saving}>
                  <XCircle data-icon="inline-start" />
                  Revoke
                </Button>
              ) : (
                <Button type="button" variant="outline" onClick={() => void handleUpdateRelayTrustStatus('active')} disabled={saving}>
                  <CheckCircle2 data-icon="inline-start" />
                  Reactivate
                </Button>
              )}
              <Button type="button" variant="destructive" onClick={() => void handleDeleteRelay()} disabled={saving}>
                Delete
              </Button>
            </div>
          </div>
        </AppCardHeader>

        <AppCardContent className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="relay-device-name">Relay name</FieldLabel>
              <FieldContent>
                <div className="flex flex-col gap-3 lg:flex-row">
                  <Input
                    id="relay-device-name"
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    placeholder="Relay name"
                  />
                  <Button type="button" onClick={() => void handleSaveRelay()} disabled={saving || !draftName.trim()}>
                    Save
                  </Button>
                </div>
              </FieldContent>
            </Field>
          </FieldGroup>

          <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">Fingerprint {relayDetail.device.publicKeyFingerprint}</Badge>
            <Badge variant="outline">Last connected {formatDateTime(relayDetail.device.lastConnectedAt)}</Badge>
            <Badge variant="outline">{relayDetail.device.exposureCount} MCPs</Badge>
            <Badge variant="outline">{relayDetail.device.toolCount} tools</Badge>
          </div>
        </AppCardContent>
      </AppCard>

      <AppCard variant="panel">
        <AppCardHeader className="gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <AppCardTitle>Device Conversation Policy</AppCardTitle>
              <AppCardDescription className="mt-2">
                Limit which conversation topologies can surface tools from this device. Runtime visibility follows the
                workspace default, then this device override, then each exposure override, then each matching grant.
              </AppCardDescription>
            </div>
            <Badge
              variant={
                relayDetail.device.conversationTypeMaskOverride ? 'secondary' : 'outline'
              }
            >
              {relayDetail.device.conversationTypeMaskOverride
                ? 'Override active'
                : 'Follow workspace'}
            </Badge>
          </div>
        </AppCardHeader>
        <AppCardContent className="flex flex-col gap-5">
          <div className="flex flex-wrap gap-2">
            {conversationTypePresets.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                variant={
                  currentDeviceConversationTypeMask === preset.value ? 'default' : 'outline'
                }
                size="sm"
                onClick={() => applyDeviceConversationTypePreset(preset.value)}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          <FieldGroup>
            {conversationTypeOptions.map((option) => (
              <Field key={option.key} orientation="horizontal">
                <FieldContent>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={deviceConversationTypeKeys.includes(option.key)}
                      disabled={!deviceAllowedConversationTypeKeys.has(option.key)}
                      onCheckedChange={() => toggleDeviceConversationTypeKey(option.key)}
                    />
                    <div className="space-y-1">
                      <FieldLabel>{option.label}</FieldLabel>
                      <FieldDescription>{option.description}</FieldDescription>
                    </div>
                  </div>
                </FieldContent>
              </Field>
            ))}
          </FieldGroup>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-border bg-muted/20 p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Workspace
              </div>
              <div className="mt-2 text-sm font-medium text-foreground">
                {deviceWorkspaceConversationTypeMask}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {formatConversationTypeKeys(
                  conversationTypeMaskToKeys(deviceWorkspaceConversationTypeMask),
                )}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-muted/20 p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Effective Device
              </div>
              <div className="mt-2 text-sm font-medium text-foreground">
                {deviceEffectiveConversationTypeMask}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {formatConversationTypeKeys(
                  conversationTypeMaskToKeys(deviceEffectiveConversationTypeMask),
                )}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-muted/20 p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Draft
              </div>
              <div className="mt-2 text-sm font-medium text-foreground">
                {currentDeviceConversationTypeMask}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {selectedDeviceConversationTypeLabels}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-muted/20 p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Override Payload
              </div>
              <div className="mt-2 text-sm font-medium text-foreground">
                {nextDeviceConversationTypeMaskOverride ?? 'follow workspace'}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                Exposure policies can only narrow this result further.
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={resetDeviceConversationTypePolicy}
              disabled={savingDevicePolicy}
            >
              Follow workspace
            </Button>
            <Button
              type="button"
              onClick={() => void saveDeviceConversationTypePolicy()}
              disabled={!hasDeviceConversationTypeChanges || savingDevicePolicy}
            >
              {savingDevicePolicy ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <Shield data-icon="inline-start" />
              )}
              Save device policy
            </Button>
          </div>
        </AppCardContent>
      </AppCard>

      <AppCard variant="panel">
        <AppCardHeader className="gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <AppCardTitle>Relay Lifecycle Event Sources</AppCardTitle>
              <AppCardDescription className="mt-2">
                Register durable online/offline event sources for this relay. Re-enabling a source reuses the same
                registration instead of creating duplicates.
              </AppCardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadRelayEventSources()}
              disabled={loadingRelayEventSources}
            >
              {loadingRelayEventSources ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <Radio data-icon="inline-start" />
              )}
              Refresh Sources
            </Button>
          </div>
        </AppCardHeader>
        <AppCardContent className="grid gap-4 lg:grid-cols-2">
          {relayLifecycleSourceDefinitions.map(({ definition, source: template }) => {
            const source = relayEventSources.find((entry) => entry.sourceKey === template.sourceKey);
            const enabled = source ? source.status === 'active' || source.status === 'deprecated' : false;
            const pending = togglingRelaySourceKey === template.sourceKey;

            return (
              <div
                key={template.sourceKey}
                className="rounded-[22px] border border-border/70 bg-muted/20 px-4 py-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-medium text-foreground">{template.name}</div>
                      <Badge variant={enabled ? 'secondary' : 'outline'}>
                        {enabled ? 'enabled' : 'disabled'}
                      </Badge>
                      {definition.graceWindowMs ? (
                        <Badge variant="outline">grace {Math.round(definition.graceWindowMs / 1000)}s</Badge>
                      ) : null}
                      {source ? <Badge variant="outline">{source.status}</Badge> : null}
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{template.description}</p>
                  </div>
                  <Switch
                    checked={enabled}
                    disabled={pending}
                    onCheckedChange={(checked) => void handleToggleRelayEventSource(template.sourceKey, checked)}
                    aria-label={`Toggle ${template.name}`}
                  />
                </div>
                <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>Key {template.sourceKey}</span>
                  <span>Last event {formatDateTime(source?.lastTriggeredAt)}</span>
                  {source?.id ? <span>Source {source.id.slice(0, 8)}</span> : null}
                </div>
              </div>
            );
          })}
        </AppCardContent>
      </AppCard>

      <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <AppCard variant="panel" className="min-h-0">
          <AppCardHeader>
            <AppCardTitle>MCP Exposures</AppCardTitle>
            <AppCardDescription>
              Each exposure is authorized directly through relay exposure access, without a mirrored plugin layer.
            </AppCardDescription>
          </AppCardHeader>
          <AppCardContent className="min-h-0 p-0">
            {relayDetail.exposures.length === 0 ? (
              <div className="px-6 pb-6 text-sm text-muted-foreground">
                No MCP exposures have synced from this relay yet.
              </div>
            ) : (
              <ScrollArea className="h-[28rem]">
                <div className="flex flex-col gap-2 px-3 pb-3">
                  {relayDetail.exposures.map((exposure) => {
                    const selected = activeExposure?.id === exposure.id;
                    return (
                      <button
                        key={exposure.id}
                        type="button"
                        onClick={() => {
                          const next = new URLSearchParams(searchParams.toString());
                          next.set('exposureId', exposure.id);
                          router.replace(`/dashboard/plugins/relays/${relayId}?${next.toString()}`, { scroll: false });
                        }}
                        className={cn(
                          'flex flex-col gap-3 rounded-[22px] px-4 py-4 text-left transition-colors',
                          selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60',
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-sm font-medium text-foreground">{exposure.displayName}</div>
                          <Badge variant={exposureVariant(exposure.runtimeStatus)}>{exposure.runtimeStatus}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {exposure.transport}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="outline">{exposure.tools.length} tools</Badge>
                          <Badge variant="secondary">Direct authorization</Badge>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </AppCardContent>
        </AppCard>

        <div className="flex min-w-0 flex-col gap-6">
          {activeExposure ? (
            <>
              <AppCard variant="panel">
                <AppCardHeader className="gap-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <AppCardTitle>{activeExposure.displayName}</AppCardTitle>
                        <Badge variant={exposureVariant(activeExposure.runtimeStatus)}>
                          {activeExposure.runtimeStatus}
                        </Badge>
                      </div>
                      <AppCardDescription className="mt-2">
                        {activeExposure.transport} transport
                      </AppCardDescription>
                    </div>
                  </div>
                </AppCardHeader>
                <AppCardContent className="flex flex-col gap-4">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">Last seen {formatDateTime(activeExposure.lastSeenAt)}</Badge>
                    {activeExposure.syncSource ? (
                      <>
                        <Badge variant={syncSourceVariant(activeExposure.syncSource.status)}>
                          {activeExposure.syncSource.sourceKind}
                        </Badge>
                        <Badge variant="outline">{activeExposure.syncSource.syncMode}</Badge>
                      </>
                    ) : null}
                    <Badge variant="outline">Exposure ID {activeExposure.id.slice(0, 8)}</Badge>
                  </div>

                  {activeExposure.lastError ? (
                    <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                      {activeExposure.lastError}
                    </div>
                  ) : null}

                  <div className="flex flex-col gap-2">
                    <div className="text-sm font-medium text-foreground">Tools</div>
                    <div className="flex flex-wrap gap-2">
                      {activeExposure.tools.length > 0 ? (
                        activeExposure.tools.map((tool) => (
                          <Badge key={tool.id} variant="secondary">
                            {tool.currentName}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-sm text-muted-foreground">No tools reported yet.</span>
                      )}
                    </div>
                  </div>
                </AppCardContent>
              </AppCard>

              <Separator />

              <PluginAccessStep
                installation={null}
                resourceId={activeExposure.id}
                accessAdapter={relayAccessAdapter}
                resourceLabel="relay exposure"
                title="Authorization"
                description="Choose who can invoke this relay exposure. Device ownership and trust stay on the relay."
                addAccessLabel="Add Authorization"
                emptyMessage="This relay exposure is not available yet."
                dialogTitle="Add relay exposure access"
                dialogDescription="Choose who can invoke this relay exposure."
                noAccessMessage="No one can invoke this relay exposure yet."
              />

              <AppCard variant="panel">
                <AppCardHeader>
                  <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-primary" />
                    <AppCardTitle>Runtime Grants</AppCardTitle>
                  </div>
                  <AppCardDescription>
                    Fine-grained approvals for special relay MCP actions. These grants are independent from MCP session lifecycle and stay active until consumed or revoked.
                  </AppCardDescription>
                </AppCardHeader>
                <AppCardContent className="space-y-3">
                  {loadingRuntimeGrants ? (
                    <div className="flex items-center gap-2 rounded-2xl border border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading runtime grants...
                    </div>
                  ) : runtimeGrants.length > 0 ? (
                    runtimeGrants.map((grant) => {
                      const effect = describeRuntimeGrantEffect(grant.effect);
                      const EffectIcon = effect.icon;
                      const isRevoking = revokingGrantId === grant.id;
                      return (
                        <div
                          key={grant.id}
                          className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-4"
                        >
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div className="min-w-0 space-y-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="secondary">{formatRuntimeGrantScope(grant.scope)}</Badge>
                                <Badge variant="outline">{grant.relayToolStableKey}</Badge>
                                <Badge variant="outline">{grant.status}</Badge>
                              </div>
                              <div className="flex items-start gap-2">
                                <EffectIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-foreground">{effect.summary}</div>
                                  <div className="text-xs break-all text-muted-foreground">{effect.detail}</div>
                                </div>
                              </div>
                              <div className="text-xs text-muted-foreground">
                                Created {formatDateTime(grant.createdAt)}
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void handleRevokeRuntimeGrant(grant.id)}
                              disabled={isRevoking}
                            >
                              {isRevoking ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <XCircle className="mr-2 h-4 w-4" />
                              )}
                              Revoke
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="rounded-2xl border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground">
                      No active runtime grants for this exposure.
                    </div>
                  )}
                </AppCardContent>
              </AppCard>
            </>
          ) : (
            <AppCard variant="panel">
              <AppCardContent className="py-12 text-center text-sm text-muted-foreground">
                No MCP exposure is available for this relay yet.
              </AppCardContent>
            </AppCard>
          )}
        </div>
      </div>
    </div>
  );
}
