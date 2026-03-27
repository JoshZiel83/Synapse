'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type {
  AutomationEventSource,
  RelayDeviceDetailView,
  RelayDeviceSummaryView,
  RelayExposureView,
} from '@synapse/shared';
import { relayLifecycleEventDefinitions } from '@synapse/shared';
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Radio,
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
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
  const [draftName, setDraftName] = useState('');

  const exposureId = searchParams.get('exposureId');
  const relayAccessAdapter = useMemo(
    () => ({
      loadAccess: (targetWorkspaceId: string, targetExposureId: string) =>
        api.getRelayExposureAccess(targetWorkspaceId, relayId, targetExposureId),
      grantAccess: (
        targetWorkspaceId: string,
        targetExposureId: string,
        payload: {
          grantScope?: 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
          actorId?: string;
          conversationId?: string;
          userId?: string;
          permissions?: string[];
        },
      ) => api.grantRelayExposureAccess(targetWorkspaceId, relayId, targetExposureId, payload),
      revokeAccess: (
        targetWorkspaceId: string,
        targetExposureId: string,
        bindingId: string,
      ) => api.revokeRelayExposureAccess(targetWorkspaceId, relayId, targetExposureId, bindingId),
    }),
    [relayId],
  );

  const relayLifecycleSourceDefinitions = useMemo(
    () =>
      relayLifecycleEventDefinitions.map((definition) => ({
        definition,
        source: definition.buildSource({
          providerRef: relayDetail?.device.id || relayId,
          providerLabel: relayDetail?.device.displayName || draftName || relayId,
        }),
      })),
    [draftName, relayDetail?.device.displayName, relayDetail?.device.id, relayId],
  );

  const activeExposure = useMemo(() => {
    if (!relayDetail?.exposures.length) return null;
    return relayDetail.exposures.find((exposure) => exposure.id === exposureId) || relayDetail.exposures[0];
  }, [exposureId, relayDetail?.exposures]);

  async function loadRelayDetail() {
    if (!workspaceId || !relayId) return;

    setLoading(true);
    try {
      const detail = await api.getRelayDevice(workspaceId, relayId);
      setRelayDetail(detail);
      setDraftName(detail.device.displayName);
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

  async function handleSaveRelay() {
    if (!workspaceId || !relayDetail || !draftName.trim()) return;

    setSaving(true);
    try {
      await api.updateRelayDevice(workspaceId, relayDetail.device.id, { displayName: draftName.trim() });
      await loadRelayDetail();
      toast.success('Relay updated');
    } catch (error) {
      console.error('Failed to update relay device:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update relay');
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnectRelay() {
    if (!workspaceId || !relayDetail) return;
    if (!window.confirm(`Disconnect relay device "${relayDetail.device.displayName}"?`)) return;

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

  async function handleDeleteRelay() {
    if (!workspaceId || !relayDetail) return;
    if (!window.confirm(`Delete relay device "${relayDetail.device.displayName}"?`)) return;

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
    if (!window.confirm(`${actionLabel[0].toUpperCase()}${actionLabel.slice(1)} relay device "${relayDetail.device.displayName}"?`)) {
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
                  <AppCardTitle>{relayDetail.device.displayName}</AppCardTitle>
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
                    {relayDetail.device.clientKind}
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
