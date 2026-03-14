'use client';

import Link from 'next/link';
import QRCode from 'qrcode';
import type {
  RelayDashboardView,
  RelayDeviceDetailView,
  RelayDeviceSummaryView,
  RelayExposureView,
  RelayLocalDesktopStatusView,
  RelayPairingSessionView,
  RelaySyncSourceView,
} from '@synapse/shared';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  Copy,
  Link2,
  Monitor,
  MonitorUp,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings,
  Store,
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
import { PluginIcon, getLocale, translate } from './plugin-ui';
import { usePluginStore } from '@/stores/plugin-store';
import { api } from '@/lib/api';
import { buildRelayDesktopDeepLink, probeLocalRelayDesktop, sendPairingToLocalRelayDesktop } from '@/lib/relay-local';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

function formatDateTime(value?: string) {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}

function pairingStatusVariant(status: RelayPairingSessionView['status']) {
  switch (status) {
    case 'consumed':
      return 'secondary';
    case 'expired':
    case 'cancelled':
    case 'rejected':
      return 'destructive';
    default:
      return 'outline';
  }
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

function syncSourceVariant(status: RelaySyncSourceView['status']) {
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

type RelaySyncSourceSummary = {
  source: RelaySyncSourceView;
  linkedExposureCount: number;
  healthyExposureCount: number;
  linkedExposureNames: string[];
};

type RelayDashboardPayload = Partial<RelayDashboardView> & {
  pairings?: RelayPairingSessionView[];
};

function deriveRelaySocketUrl(serverBaseUrl: string) {
  const url = new URL(serverBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws/relay';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function normalizeRelayDashboard(dashboard?: RelayDashboardPayload | null): RelayDashboardView {
  return {
    devices: Array.isArray(dashboard?.devices) ? dashboard.devices : [],
    pendingPairings: Array.isArray(dashboard?.pendingPairings)
      ? dashboard.pendingPairings
      : Array.isArray(dashboard?.pairings)
        ? dashboard.pairings
        : [],
  };
}

async function copyText(text: string, label: string) {
  await navigator.clipboard.writeText(text);
  toast.success(`${label} copied`);
}

function PairingQrCode({ value }: { value: string }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void QRCode.toDataURL(value, {
      width: 220,
      margin: 1,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    }).then((nextImageUrl: string) => {
      if (!cancelled) {
        setImageUrl(nextImageUrl);
      }
    }).catch(() => {
      if (!cancelled) {
        setImageUrl(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [value]);

  return (
    <div className="flex min-h-60 items-center justify-center rounded-[28px] border border-border/70 bg-white p-4 shadow-sm">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt="Relay pairing QR code"
          className="size-[220px] rounded-[20px]"
        />
      ) : (
        <div className="text-sm text-slate-500">Generating QR code...</div>
      )}
    </div>
  );
}

export default function PluginsPage() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const { marketplace, installations, loadingMarketplace, loadMarketplace, loadInstallations } = usePluginStore();
  const [relayDashboard, setRelayDashboard] = useState<RelayDashboardView>(normalizeRelayDashboard());
  const [loadingRelays, setLoadingRelays] = useState(false);
  const [search, setSearch] = useState('');
  const [createPairingOpen, setCreatePairingOpen] = useState(false);
  const [pairingName, setPairingName] = useState('');
  const [creatingPairing, setCreatingPairing] = useState(false);
  const [activePairing, setActivePairing] = useState<RelayPairingSessionView | null>(null);
  const [selectedRelay, setSelectedRelay] = useState<RelayDeviceSummaryView | null>(null);
  const [relayDetail, setRelayDetail] = useState<RelayDeviceDetailView | null>(null);
  const [relayDetailLoading, setRelayDetailLoading] = useState(false);
  const [relayDraftName, setRelayDraftName] = useState('');
  const [savingRelay, setSavingRelay] = useState(false);
  const [localRelayDesktop, setLocalRelayDesktop] = useState<RelayLocalDesktopStatusView | null>(null);
  const [probingLocalRelayDesktop, setProbingLocalRelayDesktop] = useState(true);
  const [sendingToDesktop, setSendingToDesktop] = useState(false);
  const locale = getLocale();
  const deferredSearch = useDeferredValue(search);

  async function loadRelayDashboard() {
    if (!workspaceId) return;
    setLoadingRelays(true);
    try {
      const data = await api.getRelayDashboard(workspaceId);
      setRelayDashboard(normalizeRelayDashboard(data));
    } catch (error) {
      console.error('Failed to load relays:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to load relays');
    } finally {
      setLoadingRelays(false);
    }
  }

  useEffect(() => {
    void loadMarketplace();
  }, [loadMarketplace]);

  useEffect(() => {
    if (!workspaceId) return;

    void loadInstallations(workspaceId);
    void loadRelayDashboard();
  }, [loadInstallations, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !selectedRelay) {
      setRelayDetail(null);
      return;
    }

    let cancelled = false;
    setRelayDetailLoading(true);

    void api.getRelayDevice(workspaceId, selectedRelay.id)
      .then((detail) => {
        if (!cancelled) setRelayDetail(detail);
      })
      .catch((error) => {
        console.error('Failed to load relay detail:', error);
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Failed to load relay detail');
      })
      .finally(() => {
        if (!cancelled) setRelayDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRelay, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !activePairing) return;
    if (!['pending', 'confirmed'].includes(activePairing.status)) return;

    let cancelled = false;
    const interval = window.setInterval(() => {
      void api.getRelayPairingSession(workspaceId, activePairing.id)
        .then(({ pairing }) => {
          if (cancelled) return;
          setActivePairing(pairing);
          setRelayDashboard((current) => {
            const normalizedCurrent = normalizeRelayDashboard(current);
            return {
              ...normalizedCurrent,
              pendingPairings: normalizedCurrent.pendingPairings.map((item) => (item.id === pairing.id ? pairing : item)),
            };
          });
          if (pairing.status === 'consumed') {
            toast.success('Relay device paired');
            void loadRelayDashboard();
          }
        })
        .catch((error) => {
          if (!cancelled) console.error('Failed to refresh relay pairing:', error);
        });
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activePairing, workspaceId]);

  useEffect(() => {
    let cancelled = false;

    async function refreshLocalRelayDesktop() {
      const next = await probeLocalRelayDesktop();
      if (cancelled) return;
      setLocalRelayDesktop(next);
      setProbingLocalRelayDesktop(false);
    }

    void refreshLocalRelayDesktop();
    const interval = window.setInterval(() => {
      void refreshLocalRelayDesktop();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const pluginInstallationsByPluginId = useMemo(() => {
    const next = new Map<string, any[]>();

    for (const installation of installations) {
      const pluginId = installation.plugin_id;
      if (!pluginId) continue;
      const current = next.get(pluginId) || [];
      current.push(installation);
      next.set(pluginId, current);
    }

    return next;
  }, [installations]);

  const filteredPlugins = useMemo(() => {
    const normalizedSearch = deferredSearch.trim().toLowerCase();

    return marketplace.filter((plugin: any) => {
      if (!normalizedSearch) return true;
      const title =
        translate(plugin.display_name_i18n, locale, plugin.default_locale || 'en') || plugin.display_name || '';
      const summary =
        translate(plugin.summary_i18n || plugin.description_i18n, locale, plugin.default_locale || 'en') ||
        plugin.description ||
        '';
      const haystack = [
        title,
        summary,
        plugin.org_display_name || '',
        ...(plugin.tags || []),
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });
  }, [deferredSearch, locale, marketplace]);

  const filteredRelays = useMemo(() => {
    const normalizedSearch = deferredSearch.trim().toLowerCase();
    if (!normalizedSearch) return relayDashboard.devices;
    return relayDashboard.devices.filter((relay) =>
      [
        relay.displayName,
        relay.clientKind,
        relay.platform || '',
        relay.publicKeyFingerprint,
      ].join(' ').toLowerCase().includes(normalizedSearch),
    );
  }, [deferredSearch, relayDashboard.devices]);

  const filteredPairings = useMemo(() => {
    const normalizedSearch = deferredSearch.trim().toLowerCase();
    if (!normalizedSearch) return relayDashboard.pendingPairings;
    return relayDashboard.pendingPairings.filter((pairing) =>
      [
        pairing.requestedDisplayName || '',
        pairing.pairingCode,
        pairing.status,
      ].join(' ').toLowerCase().includes(normalizedSearch),
    );
  }, [deferredSearch, relayDashboard.pendingPairings]);

  const configuredPlugins = useMemo(
    () => filteredPlugins.filter((plugin: any) => (pluginInstallationsByPluginId.get(plugin.id) || []).length > 0),
    [filteredPlugins, pluginInstallationsByPluginId],
  );

  const unconfiguredPlugins = useMemo(
    () => filteredPlugins.filter((plugin: any) => (pluginInstallationsByPluginId.get(plugin.id) || []).length === 0),
    [filteredPlugins, pluginInstallationsByPluginId],
  );

  const relaySyncSources = useMemo<RelaySyncSourceSummary[]>(() => {
    if (!relayDetail) return [];

    const summaries = new Map<string, RelaySyncSourceSummary>();
    for (const source of relayDetail.syncSources) {
      summaries.set(source.id, {
        source,
        linkedExposureCount: 0,
        healthyExposureCount: 0,
        linkedExposureNames: [],
      });
    }

    for (const exposure of relayDetail.exposures) {
      if (!exposure.syncSource) continue;

      const current = summaries.get(exposure.syncSource.id) || {
        source: exposure.syncSource,
        linkedExposureCount: 0,
        healthyExposureCount: 0,
        linkedExposureNames: [],
      };
      current.linkedExposureCount += 1;
      if (exposure.runtimeStatus === 'healthy') {
        current.healthyExposureCount += 1;
      }
      current.linkedExposureNames.push(exposure.displayName);
      summaries.set(exposure.syncSource.id, current);
    }

    return [...summaries.values()].sort((left, right) => left.source.sourceKind.localeCompare(right.source.sourceKind));
  }, [relayDetail]);

  async function handleCreatePairing() {
    if (!workspaceId) return;
    setCreatingPairing(true);
    try {
      const result = await api.createRelayPairingSession(workspaceId, {
        displayName: pairingName.trim() || undefined,
      });
      setCreatePairingOpen(false);
      setPairingName('');
      setActivePairing(result.pairing);
      await loadRelayDashboard();
      toast.success('Relay pairing session created');
    } catch (error) {
      console.error('Failed to create relay pairing:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to create relay pairing');
    } finally {
      setCreatingPairing(false);
    }
  }

  async function handleCancelPairing() {
    if (!workspaceId || !activePairing) return;
    try {
      const result = await api.cancelRelayPairingSession(workspaceId, activePairing.id);
      setActivePairing(result.pairing);
      await loadRelayDashboard();
      toast.success('Relay pairing session cancelled');
    } catch (error) {
      console.error('Failed to cancel relay pairing:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to cancel relay pairing');
    }
  }

  async function handleRefreshLocalRelayDesktop() {
    setProbingLocalRelayDesktop(true);
    const next = await probeLocalRelayDesktop();
    setLocalRelayDesktop(next);
    setProbingLocalRelayDesktop(false);
  }

  async function handleSendPairingToDesktop() {
    if (!activePairing) return;

    setSendingToDesktop(true);
    try {
      const response = await sendPairingToLocalRelayDesktop({
        serverBaseUrl: activePairing.serverBaseUrl,
        pairingCode: activePairing.pairingCode,
        displayName: activePairing.requestedDisplayName,
      });
      toast.success(response.message || 'Pairing request sent to the local desktop client');
      await handleRefreshLocalRelayDesktop();
    } catch (error) {
      console.error('Failed to send pairing to local desktop client:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to send pairing to local desktop client');
    } finally {
      setSendingToDesktop(false);
    }
  }

  function handleOpenDesktopApp() {
    if (!activePairing) return;
    window.location.href = buildRelayDesktopDeepLink(activePairing);
  }

  async function handleSaveRelay() {
    if (!workspaceId || !selectedRelay || !relayDraftName.trim()) return;
    setSavingRelay(true);
    try {
      const updated = await api.updateRelayDevice(workspaceId, selectedRelay.id, { displayName: relayDraftName.trim() });
      setSelectedRelay(updated);
      setRelayDraftName(updated.displayName);
      const detail = await api.getRelayDevice(workspaceId, updated.id);
      setRelayDetail(detail);
      await loadRelayDashboard();
      toast.success('Relay device updated');
    } catch (error) {
      console.error('Failed to update relay device:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update relay device');
    } finally {
      setSavingRelay(false);
    }
  }

  async function handleDisconnectRelay() {
    if (!workspaceId || !selectedRelay) return;
    if (!window.confirm(`Disconnect relay device "${selectedRelay.displayName}"?`)) return;

    setSavingRelay(true);
    try {
      await api.disconnectRelayDevice(workspaceId, selectedRelay.id);
      await loadRelayDashboard();
      const detail = await api.getRelayDevice(workspaceId, selectedRelay.id);
      setRelayDetail(detail);
      setSelectedRelay(detail.device);
      toast.success('Disconnect requested');
    } catch (error) {
      console.error('Failed to disconnect relay device:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to disconnect relay device');
    } finally {
      setSavingRelay(false);
    }
  }

  async function handleDeleteRelay() {
    if (!workspaceId || !selectedRelay) return;
    if (!window.confirm(`Delete relay device "${selectedRelay.displayName}"?`)) return;

    setSavingRelay(true);
    try {
      await api.deleteRelayDevice(workspaceId, selectedRelay.id);
      setSelectedRelay(null);
      setRelayDetail(null);
      await loadRelayDashboard();
      toast.success('Relay device deleted');
    } catch (error) {
      console.error('Failed to delete relay device:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to delete relay device');
    } finally {
      setSavingRelay(false);
    }
  }

  async function handleUpdateRelayTrustStatus(nextTrustStatus: 'active' | 'revoked' | 'blocked') {
    if (!workspaceId || !selectedRelay) return;

    const actionLabel = nextTrustStatus === 'active' ? 'reactivate' : nextTrustStatus;
    if (!window.confirm(`${actionLabel[0].toUpperCase()}${actionLabel.slice(1)} relay device "${selectedRelay.displayName}"?`)) return;

    setSavingRelay(true);
    try {
      const result = await api.updateRelayTrustStatus(workspaceId, selectedRelay.id, nextTrustStatus);
      const detail = await api.getRelayDevice(workspaceId, result.device.id);
      setRelayDetail(detail);
      setSelectedRelay(detail.device);
      await loadRelayDashboard();
      toast.success(`Relay device ${actionLabel}d`);
    } catch (error) {
      console.error('Failed to update relay trust status:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update relay trust status');
    } finally {
      setSavingRelay(false);
    }
  }

  const loading = loadingMarketplace || loadingRelays;

  return (
    <div className="flex flex-col gap-6 pt-3 sm:pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search plugins, pairings, and relays"
            className="pl-10"
          />
        </div>

        <Button type="button" onClick={() => setCreatePairingOpen(true)}>
          <Plus data-icon="inline-start" />
          Bind Relay
        </Button>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading plugins...</div>
      ) : filteredPlugins.length === 0 && filteredRelays.length === 0 && filteredPairings.length === 0 ? (
        <div className="rounded-[28px] border border-dashed border-border px-6 py-14 text-center">
          <div className="text-base font-medium text-foreground">No plugins or relay devices found</div>
          <div className="mt-2 text-sm text-muted-foreground">
            Try a different search or create a relay pairing for a local MCP client.
          </div>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filteredPairings.map((pairing) => (
            <AppCard
              key={pairing.id}
              variant="interactive"
              size="sm"
              onClick={() => setActivePairing(pairing)}
            >
              <AppCardHeader className="gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-14 items-center justify-center rounded-[18px] border border-border/70 bg-muted/30">
                      <Monitor className="size-6 text-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <AppCardTitle className="truncate text-sm">
                          {pairing.requestedDisplayName || pairing.pairingCode}
                        </AppCardTitle>
                        <Badge variant="outline">Pairing</Badge>
                      </div>
                      <AppCardDescription className="mt-1 text-xs">
                        Code {pairing.pairingCode}
                      </AppCardDescription>
                    </div>
                  </div>

                  <Badge variant={pairingStatusVariant(pairing.status)}>{pairing.status}</Badge>
                </div>
              </AppCardHeader>

              <AppCardContent className="flex flex-col gap-3">
                <div className="text-xs leading-5 text-muted-foreground">
                  Expires {formatDateTime(pairing.expiresAt)}. Open to copy the code or verification link.
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">One-time code</Badge>
                  {pairing.deviceId ? <Badge variant="outline">Device claimed</Badge> : null}
                </div>
              </AppCardContent>
            </AppCard>
          ))}

          {filteredRelays.map((relay) => (
            <AppCard
              key={relay.id}
              variant="interactive"
              size="sm"
              onClick={() => {
                setRelayDraftName(relay.displayName);
                setSelectedRelay(relay);
              }}
            >
              <AppCardHeader className="gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-14 items-center justify-center rounded-[18px] border border-border/70 bg-muted/30">
                      <Radio className="size-6 text-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <AppCardTitle className="truncate text-sm">{relay.displayName}</AppCardTitle>
                        <Badge variant="outline">Relay</Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {relay.isConnected ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Wifi className="size-4 text-foreground" />
                            Connected
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <WifiOff className="size-4 text-muted-foreground" />
                            Offline
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <Button
                    type="button"
                    size="sm"
                    className="shrink-0"
                    onClick={(event) => {
                      event.stopPropagation();
                      setRelayDraftName(relay.displayName);
                      setSelectedRelay(relay);
                    }}
                  >
                    <Settings data-icon="inline-start" />
                    Configure
                  </Button>
                </div>
              </AppCardHeader>

              <AppCardContent className="flex flex-col gap-3">
                <div className="text-xs leading-5 text-muted-foreground">
                  {relay.clientKind}
                  {relay.platform ? ` on ${relay.platform}` : ''}. {relay.exposureCount} MCP exposure{relay.exposureCount === 1 ? '' : 's'} and {relay.toolCount} tool{relay.toolCount === 1 ? '' : 's'}.
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={relayTrustVariant(relay.trustStatus)}>{relay.trustStatus}</Badge>
                  <Badge variant="secondary">{relay.exposureCount} exposures</Badge>
                  <Badge variant="outline">
                    Last seen {relay.lastSeenAt ? formatDateTime(relay.lastSeenAt) : 'Never'}
                  </Badge>
                </div>
              </AppCardContent>
            </AppCard>
          ))}

          {[...configuredPlugins, ...unconfiguredPlugins].map((plugin: any) => {
            const title =
              translate(plugin.display_name_i18n, locale, plugin.default_locale || 'en') || plugin.display_name;
            const summary =
              translate(plugin.summary_i18n || plugin.description_i18n, locale, plugin.default_locale || 'en') ||
              plugin.description;
            const pluginInstallations = pluginInstallationsByPluginId.get(plugin.id) || [];
            const primaryInstallation = pluginInstallations[0];
            const actionHref = pluginInstallations.length > 1
              ? `/dashboard/plugins/${plugin.id}`
              : primaryInstallation
                ? `/dashboard/plugins/installations/${primaryInstallation.id}`
                : `/dashboard/plugins/${plugin.id}/install`;

            return (
              <AppCard
                key={plugin.id}
                variant="interactive"
                size="sm"
                onClick={() => router.push(`/dashboard/plugins/${plugin.id}`)}
              >
                <AppCardHeader className="gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <PluginIcon
                        iconUrl={plugin.icon_url}
                        title={title}
                        transport={plugin.transport}
                        verified={plugin.is_builtin}
                        containerClassName="size-14 rounded-[18px]"
                        className="size-6"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <AppCardTitle className="truncate text-sm">{title}</AppCardTitle>
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                          {summary || 'No description provided.'}
                        </div>
                      </div>
                    </div>

                    <Button
                      asChild
                      size="sm"
                      className="shrink-0"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Link href={actionHref}>{pluginInstallations.length > 0 ? 'Configure' : 'Install'}</Link>
                    </Button>
                  </div>
                </AppCardHeader>

                <AppCardContent className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    {plugin.org_display_name ? <Badge variant="secondary">{plugin.org_display_name}</Badge> : null}
                    {(plugin.categories || []).slice(0, 2).map((category: any) => (
                      <Badge key={category.slug} variant="secondary">
                        {translate(category.displayNameI18n, locale, category.defaultLocale || 'en') || category.displayName}
                      </Badge>
                    ))}
                    {pluginInstallations.length > 0 ? (
                      <Badge variant="outline">
                        {pluginInstallations.length} installation{pluginInstallations.length > 1 ? 's' : ''}
                      </Badge>
                    ) : null}
                  </div>
                </AppCardContent>
              </AppCard>
            );
          })}

          <AppCard
            variant="interactive-dashed"
            size="sm"
            onClick={() => setCreatePairingOpen(true)}
          >
            <AppCardHeader className="gap-3">
              <div className="flex items-start gap-3">
                <div className="flex size-14 items-center justify-center rounded-[18px] border border-dashed border-border/80 bg-background/80">
                  <Plus className="size-6 text-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <AppCardTitle className="truncate text-sm">Bind Relay</AppCardTitle>
                  <div className="mt-1 text-xs leading-5 text-muted-foreground">
                    Create a one-time pairing code for a desktop relay client.
                  </div>
                </div>
              </div>
            </AppCardHeader>

            <AppCardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">Pairing</Badge>
                <Badge variant="outline">No long-lived token</Badge>
              </div>
            </AppCardContent>
          </AppCard>
        </div>
      )}

      <Dialog open={createPairingOpen} onOpenChange={setCreatePairingOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Relay Pairing</DialogTitle>
            <DialogDescription>
              Generate a one-time code for a relay device. The client will claim the code and bind a device key instead of storing a long-lived token.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="relay-pairing-name">Display name</FieldLabel>
              <FieldContent>
                <Input
                  id="relay-pairing-name"
                  value={pairingName}
                  onChange={(event) => setPairingName(event.target.value)}
                  placeholder="My desktop relay"
                />
                <FieldDescription>Optional. The client can still override this name when it claims the pairing.</FieldDescription>
              </FieldContent>
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreatePairingOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleCreatePairing()} disabled={creatingPairing}>
              {creatingPairing ? 'Creating...' : 'Create Pairing'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={activePairing !== null} onOpenChange={(open) => !open && setActivePairing(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Relay Pairing</DialogTitle>
            <DialogDescription>
              Use this pairing code in the relay client. The client will exchange it for a trusted device binding.
            </DialogDescription>
          </DialogHeader>

          {activePairing ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium text-foreground">
                    {activePairing.requestedDisplayName || 'Unnamed relay pairing'}
                  </div>
                  <Badge variant={pairingStatusVariant(activePairing.status)}>{activePairing.status}</Badge>
                </div>
                <div className="mt-3 text-xs text-muted-foreground">Pairing code</div>
                <div className="mt-1 break-all font-mono text-lg text-foreground">{activePairing.pairingCode}</div>
                <div className="mt-3 text-xs text-muted-foreground">Verification URL</div>
                <div className="mt-1 break-all text-sm text-foreground">{activePairing.verificationUriComplete || activePairing.verificationUri}</div>
                <div className="mt-3 text-xs text-muted-foreground">Relay websocket endpoint</div>
                <div className="mt-1 break-all text-sm text-foreground">{deriveRelaySocketUrl(activePairing.serverBaseUrl)}</div>
              </div>

              <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium text-foreground">Local desktop client</div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={localRelayDesktop ? 'secondary' : 'outline'}>
                      {localRelayDesktop ? 'detected' : probingLocalRelayDesktop ? 'probing' : 'not detected'}
                    </Badge>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleRefreshLocalRelayDesktop()}
                      disabled={probingLocalRelayDesktop}
                    >
                      <RefreshCw data-icon="inline-start" />
                      Refresh
                    </Button>
                  </div>
                </div>

                {localRelayDesktop ? (
                  <div className="mt-3 flex flex-col gap-3 text-sm text-muted-foreground">
                    <div>
                      {localRelayDesktop.displayName || 'Unnamed desktop relay'} · version {localRelayDesktop.version}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant={localRelayDesktop.paired ? 'secondary' : 'outline'}>
                        {localRelayDesktop.paired ? 'paired' : 'unpaired'}
                      </Badge>
                      <Badge variant="outline">relay {localRelayDesktop.relay || 'unknown'}</Badge>
                      <Badge variant={localRelayDesktop.serverIdentityPinned ? 'secondary' : 'outline'}>
                        {localRelayDesktop.serverIdentityPinned ? 'server pinned' : 'server pin missing'}
                      </Badge>
                    </div>
                    {localRelayDesktop.serverBaseUrl ? (
                      <div className="break-all text-xs">
                        Current server: {localRelayDesktop.serverBaseUrl}
                      </div>
                    ) : null}
                    {localRelayDesktop.serverTlsPublicKeyPin ? (
                      <div className="break-all font-mono text-[11px] text-muted-foreground">
                        TLS pin: {localRelayDesktop.serverTlsPublicKeyPin}
                      </div>
                    ) : null}
                    {localRelayDesktop.authFailureMessage ? (
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                        Relay auth failed{localRelayDesktop.authFailurePermanent ? ' permanently' : ''}: {localRelayDesktop.authFailureMessage}
                      </div>
                    ) : null}
                    {localRelayDesktop.serverBaseUrl && localRelayDesktop.serverBaseUrl !== activePairing.serverBaseUrl ? (
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                        This client is currently configured for a different Synapse server. Sending the pairing request will still require user confirmation on the desktop app.
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-3 text-sm text-muted-foreground">
                    No desktop client responded on <code className="rounded bg-muted px-1 py-0.5 text-xs">127.0.0.1:21519</code>. You can still copy the code, use the verification link, or launch the desktop app via deep link.
                  </div>
                )}
              </div>

              <Tabs defaultValue={localRelayDesktop ? 'desktop' : 'scan'}>
                <TabsList variant="line">
                  <TabsTrigger value="desktop">
                    <MonitorUp data-icon="inline-start" />
                    This Computer
                  </TabsTrigger>
                  <TabsTrigger value="scan">
                    <Link2 data-icon="inline-start" />
                    Scan
                  </TabsTrigger>
                  <TabsTrigger value="manual">
                    <Copy data-icon="inline-start" />
                    Manual
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="desktop">
                  <div className="grid gap-4 rounded-2xl border border-border/70 bg-muted/10 p-4 lg:grid-cols-[1.25fr_0.75fr]">
                    <div className="flex flex-col gap-3">
                      <div className="text-sm font-medium text-foreground">Bind on this machine</div>
                      <div className="text-sm text-muted-foreground">
                        Best path when the browser and the desktop relay client are on the same computer.
                      </div>
                      <ol className="flex list-decimal flex-col gap-2 ps-5 text-sm text-muted-foreground">
                        <li>If a desktop client is detected, use <span className="font-medium text-foreground">Send To Desktop</span>.</li>
                        <li>If the app is installed but not detected, use <span className="font-medium text-foreground">Open Desktop App</span>.</li>
                        <li>The desktop app will still ask the user to confirm the pairing.</li>
                      </ol>
                    </div>
                    <div className="rounded-2xl border border-border/60 bg-background/80 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Local status</div>
                      <div className="mt-2 text-sm font-medium text-foreground">
                        {localRelayDesktop ? (localRelayDesktop.displayName || 'Desktop relay detected') : 'No desktop relay detected'}
                      </div>
                      <div className="mt-2 text-sm text-muted-foreground">
                        {localRelayDesktop
                          ? `Relay state: ${localRelayDesktop.relay || 'unknown'}`
                          : 'Start the desktop client to expose localhost pairing.'}
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => handleOpenDesktopApp()}
                        >
                          <MonitorUp data-icon="inline-start" />
                          Open Desktop App
                        </Button>
                        <Button
                          type="button"
                          onClick={() => void handleSendPairingToDesktop()}
                          disabled={!localRelayDesktop || sendingToDesktop}
                        >
                          <Send data-icon="inline-start" />
                          {sendingToDesktop ? 'Sending...' : 'Send To Desktop'}
                        </Button>
                      </div>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="scan">
                  <div className="grid gap-4 rounded-2xl border border-border/70 bg-muted/10 p-4 lg:grid-cols-[0.8fr_1.2fr]">
                    <PairingQrCode value={activePairing.verificationUriComplete || activePairing.verificationUri} />
                    <div className="flex flex-col gap-3">
                      <div className="text-sm font-medium text-foreground">Scan from another device</div>
                      <div className="text-sm text-muted-foreground">
                        Use this when the user is browsing the Web console on one device and pairing the relay client on another.
                      </div>
                      <ol className="flex list-decimal flex-col gap-2 ps-5 text-sm text-muted-foreground">
                        <li>Open the relay verification page by scanning the QR code.</li>
                        <li>The QR includes the pairing code, so the user does not need to type it manually.</li>
                        <li>After confirmation, the desktop client claims the pairing and stores only its local device key.</li>
                      </ol>
                      <div className="rounded-2xl border border-border/60 bg-background/80 px-4 py-3 text-sm text-muted-foreground">
                        <div className="text-xs uppercase tracking-wide">Encoded URL</div>
                        <div className="mt-2 break-all text-foreground">
                          {activePairing.verificationUriComplete || activePairing.verificationUri}
                        </div>
                      </div>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="manual">
                  <div className="grid gap-4 rounded-2xl border border-border/70 bg-muted/10 p-4 lg:grid-cols-[1fr_1fr]">
                    <div className="rounded-2xl border border-border/60 bg-background/80 px-4 py-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Pairing code</div>
                      <div className="mt-2 break-all font-mono text-2xl text-foreground">{activePairing.pairingCode}</div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button type="button" variant="outline" onClick={() => void copyText(activePairing.pairingCode, 'Pairing code')}>
                          <Copy data-icon="inline-start" />
                          Copy Code
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void copyText(activePairing.verificationUriComplete || activePairing.verificationUri, 'Verification link')}
                        >
                          <Link2 data-icon="inline-start" />
                          Copy Link
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-col gap-3">
                      <div className="text-sm font-medium text-foreground">Manual binding fallback</div>
                      <div className="text-sm text-muted-foreground">
                        Use this when auto-detection is unavailable or the relay client is running on a separate machine without QR scanning.
                      </div>
                      <ol className="flex list-decimal flex-col gap-2 ps-5 text-sm text-muted-foreground">
                        <li>Enter the server address in the relay client.</li>
                        <li>Paste or type the pairing code.</li>
                        <li>Approve the pairing on the desktop client if prompted.</li>
                      </ol>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>

              <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
                <Badge variant="outline">Expires {formatDateTime(activePairing.expiresAt)}</Badge>
                {activePairing.consumedAt ? <Badge variant="secondary">Consumed {formatDateTime(activePairing.consumedAt)}</Badge> : null}
              </div>
            </div>
          ) : null}

          <DialogFooter className="justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              {activePairing && ['pending', 'confirmed'].includes(activePairing.status) ? (
                <Button type="button" variant="outline" onClick={() => void handleCancelPairing()}>
                  <XCircle data-icon="inline-start" />
                  Cancel Pairing
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setActivePairing(null)}>
                Close
              </Button>
              {activePairing ? (
                <>
                  {['pending', 'confirmed'].includes(activePairing.status) ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleSendPairingToDesktop()}
                      disabled={!localRelayDesktop || sendingToDesktop}
                    >
                      <Send data-icon="inline-start" />
                      {sendingToDesktop ? 'Sending...' : 'Send To Desktop'}
                    </Button>
                  ) : null}
                  <Button type="button" variant="outline" onClick={() => void copyText(activePairing.pairingCode, 'Pairing code')}>
                    <Copy data-icon="inline-start" />
                    Copy Code
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void copyText(activePairing.verificationUriComplete || activePairing.verificationUri, 'Verification link')}
                  >
                    <Link2 data-icon="inline-start" />
                    Copy Link
                  </Button>
                </>
              ) : null}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={selectedRelay !== null} onOpenChange={(open) => !open && !savingRelay && setSelectedRelay(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Relay Device</DialogTitle>
            <DialogDescription>
              Review the bound device, inspect exposed MCP servers, and manage its lifecycle.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-5">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="relay-display-name">Display name</FieldLabel>
                <FieldContent>
                  <Input
                    id="relay-display-name"
                    value={relayDraftName}
                    onChange={(event) => setRelayDraftName(event.target.value)}
                    placeholder="Relay device name"
                  />
                  <FieldDescription>Used in the workspace UI and relay-derived plugin labels.</FieldDescription>
                </FieldContent>
              </Field>
            </FieldGroup>

            {relayDetailLoading ? (
              <div className="rounded-2xl border border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
                Loading relay device...
              </div>
            ) : relayDetail ? (
              <>
                <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2 text-foreground">
                        <Wrench className="size-4" />
                        <span className="font-medium">{relayDetail.device.displayName}</span>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {relayDetail.device.clientKind}
                        {relayDetail.device.platform ? ` on ${relayDetail.device.platform}` : ''}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant={relayTrustVariant(relayDetail.device.trustStatus)}>{relayDetail.device.trustStatus}</Badge>
                      <Badge variant={relayDetail.device.isConnected ? 'secondary' : 'outline'}>
                        {relayDetail.device.isConnected ? 'connected' : 'offline'}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2 text-sm text-muted-foreground">
                    <Badge variant="outline">Last seen {formatDateTime(relayDetail.device.lastSeenAt)}</Badge>
                    <Badge variant="outline">Last connected {formatDateTime(relayDetail.device.lastConnectedAt)}</Badge>
                    <Badge variant="outline">Fingerprint {relayDetail.device.publicKeyFingerprint}</Badge>
                  </div>
                </div>

                <Separator />

                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-foreground">Sync Sources</div>
                      <div className="text-sm text-muted-foreground">
                        {relaySyncSources.length} source{relaySyncSources.length === 1 ? '' : 's'} currently tracked for this device.
                      </div>
                    </div>
                  </div>

                  {relaySyncSources.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                      No external MCP sync sources have reported from this device yet.
                    </div>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                      {relaySyncSources.map(({ source, linkedExposureCount, healthyExposureCount, linkedExposureNames }) => (
                        <div key={source.id} className="rounded-2xl border border-border/70 px-4 py-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="flex flex-col gap-1">
                              <div className="font-medium text-foreground">{source.sourceKind}</div>
                              <div className="text-sm text-muted-foreground">{source.sourceKey}</div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Badge variant={syncSourceVariant(source.status)}>{source.status}</Badge>
                              <Badge variant="outline">{source.syncMode}</Badge>
                            </div>
                          </div>

                          <div className="mt-3 flex flex-wrap gap-2 text-sm text-muted-foreground">
                            <Badge variant="outline">{linkedExposureCount} linked MCPs</Badge>
                            <Badge variant="outline">{healthyExposureCount} healthy</Badge>
                            <Badge variant="outline">Last sync {formatDateTime(source.lastSyncedAt)}</Badge>
                          </div>

                          {source.configPath ? (
                            <div className="mt-3 truncate text-sm text-muted-foreground">
                              {source.configPath}
                            </div>
                          ) : null}

                          {source.lastError ? (
                            <div className="mt-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                              {source.lastError}
                            </div>
                          ) : null}

                          {linkedExposureNames.length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {linkedExposureNames.map((name) => (
                                <Badge key={`${source.id}:${name}`} variant="secondary">
                                  {name}
                                </Badge>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <Separator />

                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-foreground">MCP Exposures</div>
                      <div className="text-sm text-muted-foreground">
                        {relayDetail.exposures.length} exposure{relayDetail.exposures.length === 1 ? '' : 's'} currently registered.
                      </div>
                    </div>
                  </div>

                  {relayDetail.exposures.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                      No MCP exposures have synced from this device yet.
                    </div>
                  ) : (
                    <ScrollArea className="max-h-[22rem] pr-4">
                      <div className="flex flex-col gap-3">
                        {relayDetail.exposures.map((exposure) => (
                          <div key={exposure.id} className="rounded-2xl border border-border/70 px-4 py-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="flex flex-col gap-1">
                                <div className="font-medium text-foreground">{exposure.displayName}</div>
                                <div className="text-sm text-muted-foreground">
                                  {exposure.transport} · {exposure.managementMode}
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Badge variant={exposureVariant(exposure.runtimeStatus)}>{exposure.runtimeStatus}</Badge>
                                <Badge variant="outline">{exposure.tools.length} tools</Badge>
                              </div>
                            </div>

                            {exposure.syncSource ? (
                              <div className="mt-3 flex flex-wrap gap-2 text-sm text-muted-foreground">
                                <Badge variant="outline">{exposure.syncSource.sourceKind}</Badge>
                                <Badge variant="outline">{exposure.syncSource.syncMode}</Badge>
                                <Badge variant="outline">{exposure.syncSource.sourceKey}</Badge>
                              </div>
                            ) : null}

                            <div className="mt-3 flex flex-wrap gap-2">
                              {exposure.tools.map((tool) => (
                                <Badge key={tool.id} variant="secondary">
                                  {tool.currentName}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </div>
              </>
            ) : (
              <div className="rounded-2xl border border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
                Relay device details unavailable.
              </div>
            )}
          </div>

          <DialogFooter className="justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="destructive" onClick={() => void handleDeleteRelay()} disabled={savingRelay}>
                Delete Relay
              </Button>
              {relayDetail?.device.trustStatus === 'active' ? (
                <Button type="button" variant="outline" onClick={() => void handleUpdateRelayTrustStatus('revoked')} disabled={savingRelay}>
                  <XCircle data-icon="inline-start" />
                  Revoke
                </Button>
              ) : (
                <Button type="button" variant="outline" onClick={() => void handleUpdateRelayTrustStatus('active')} disabled={savingRelay}>
                  <CheckCircle2 data-icon="inline-start" />
                  Reactivate
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void handleDisconnectRelay()} disabled={savingRelay || !selectedRelay}>
                <Unplug data-icon="inline-start" />
                Disconnect
              </Button>
              <Button type="button" onClick={() => void handleSaveRelay()} disabled={savingRelay || !relayDraftName.trim() || !selectedRelay}>
                Save
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
