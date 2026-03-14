'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Radio, Search, Settings, Store, Wifi, WifiOff, Wrench } from 'lucide-react';

import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { AppCard, AppCardContent, AppCardHeader, AppCardTitle } from '@/components/app-card';
import { PluginIcon, getLocale, translate } from './plugin-ui';
import { usePluginStore } from '@/stores/plugin-store';
import { api } from '@/lib/api';
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
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';

type RelayRecord = {
  id: string;
  name: string;
  isConnected: boolean;
  lastConnectedAt?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

function getRelayEndpoint() {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/relay`;
}

export default function PluginsPage() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const { marketplace, installations, loadingMarketplace, loadMarketplace, loadInstallations } = usePluginStore();
  const [relays, setRelays] = useState<RelayRecord[]>([]);
  const [loadingRelays, setLoadingRelays] = useState(false);
  const [search, setSearch] = useState('');
  const [createRelayOpen, setCreateRelayOpen] = useState(false);
  const [newRelayName, setNewRelayName] = useState('');
  const [creatingRelay, setCreatingRelay] = useState(false);
  const [relayConfig, setRelayConfig] = useState<RelayRecord | null>(null);
  const [relayDraftName, setRelayDraftName] = useState('');
  const [savingRelay, setSavingRelay] = useState(false);
  const [tokenDialog, setTokenDialog] = useState<{ name: string; token: string } | null>(null);
  const locale = getLocale();

  useEffect(() => {
    void loadMarketplace();
  }, [loadMarketplace]);

  useEffect(() => {
    if (!workspaceId) return;
    void loadInstallations(workspaceId);
    void loadRelays();
  }, [loadInstallations, workspaceId]);

  async function loadRelays() {
    if (!workspaceId) return;
    setLoadingRelays(true);
    try {
      const data = await api.getRelays(workspaceId);
      setRelays(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to load relays:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to load relays');
    } finally {
      setLoadingRelays(false);
    }
  }

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
    const normalizedSearch = search.trim().toLowerCase();

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
  }, [locale, marketplace, search]);

  const filteredRelays = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    if (!normalizedSearch) return relays;
    return relays.filter((relay) => relay.name.toLowerCase().includes(normalizedSearch));
  }, [relays, search]);

  const configuredPlugins = useMemo(
    () => filteredPlugins.filter((plugin: any) => (pluginInstallationsByPluginId.get(plugin.id) || []).length > 0),
    [filteredPlugins, pluginInstallationsByPluginId],
  );

  const unconfiguredPlugins = useMemo(
    () => filteredPlugins.filter((plugin: any) => (pluginInstallationsByPluginId.get(plugin.id) || []).length === 0),
    [filteredPlugins, pluginInstallationsByPluginId],
  );

  async function handleCreateRelay() {
    if (!workspaceId || !newRelayName.trim()) return;
    setCreatingRelay(true);
    try {
      const result = await api.createRelay(workspaceId, { name: newRelayName.trim() });
      setCreateRelayOpen(false);
      setNewRelayName('');
      setTokenDialog({ name: result.name, token: result.token });
      await loadRelays();
      toast.success('Relay created');
    } catch (error) {
      console.error('Failed to create relay:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to create relay');
    } finally {
      setCreatingRelay(false);
    }
  }

  async function handleSaveRelay() {
    if (!workspaceId || !relayConfig || !relayDraftName.trim()) return;
    setSavingRelay(true);
    try {
      await api.updateRelay(workspaceId, relayConfig.id, { name: relayDraftName.trim() });
      setRelayConfig(null);
      await loadRelays();
      toast.success('Relay updated');
    } catch (error) {
      console.error('Failed to update relay:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update relay');
    } finally {
      setSavingRelay(false);
    }
  }

  async function handleRegenerateRelayToken() {
    if (!workspaceId || !relayConfig) return;
    setSavingRelay(true);
    try {
      const result = await api.regenerateRelayToken(workspaceId, relayConfig.id);
      setTokenDialog({ name: result.name, token: result.token });
      await loadRelays();
      toast.success('Relay token regenerated');
    } catch (error) {
      console.error('Failed to regenerate relay token:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to regenerate relay token');
    } finally {
      setSavingRelay(false);
    }
  }

  async function handleDeleteRelay() {
    if (!workspaceId || !relayConfig) return;
    if (!window.confirm(`Delete relay "${relayConfig.name}"?`)) return;

    setSavingRelay(true);
    try {
      await api.deleteRelay(workspaceId, relayConfig.id);
      setRelayConfig(null);
      await loadRelays();
      toast.success('Relay deleted');
    } catch (error) {
      console.error('Failed to delete relay:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to delete relay');
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
            placeholder="Search plugins and relays"
            className="pl-10"
          />
        </div>

        <Button type="button" onClick={() => setCreateRelayOpen(true)}>
          <Plus data-icon="inline-start" />
          Create Relay
        </Button>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading plugins...</div>
      ) : filteredPlugins.length === 0 && filteredRelays.length === 0 ? (
        <div className="rounded-[28px] border border-dashed border-border px-6 py-14 text-center">
          <div className="text-base font-medium text-foreground">No plugins found</div>
          <div className="mt-2 text-sm text-muted-foreground">
            Try a different search or add a relay for your own MCP servers.
          </div>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filteredRelays.map((relay) => (
            <AppCard
              key={relay.id}
              variant="interactive"
              size="sm"
              onClick={() => {
                setRelayDraftName(relay.name);
                setRelayConfig(relay);
              }}
            >
              <AppCardHeader className="gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex h-14 w-14 items-center justify-center rounded-[18px] border border-border/70 bg-muted/30">
                      <Radio className="size-6 text-foreground" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <AppCardTitle className="truncate text-sm">{relay.name}</AppCardTitle>
                        <Badge variant="outline">Relay</Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {relay.isConnected ? (
                          <span className="inline-flex items-center gap-1.5 text-emerald-600">
                            <Wifi className="size-4" />
                            Connected
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <WifiOff className="size-4" />
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
                      setRelayDraftName(relay.name);
                      setRelayConfig(relay);
                    }}
                  >
                    <Settings data-icon="inline-start" />
                    Configure
                  </Button>
                </div>
              </AppCardHeader>

              <AppCardContent className="flex flex-col gap-3">
                <div className="text-xs leading-5 text-muted-foreground">
                  Relay local MCP servers into this workspace.
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">User relay</Badge>
                  <Badge variant="outline">
                    {relay.lastConnectedAt ? `Last seen ${new Date(relay.lastConnectedAt).toLocaleString()}` : 'Never connected'}
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
                        containerClassName="h-14 w-14 rounded-[18px]"
                        className="h-6 w-6"
                      />
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <AppCardTitle className="truncate text-sm">{title}</AppCardTitle>
                        </div>
                        <div className="line-clamp-2 text-xs leading-5 text-muted-foreground">
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
            onClick={() => setCreateRelayOpen(true)}
          >
            <AppCardHeader className="gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-14 w-14 items-center justify-center rounded-[18px] border border-dashed border-border/80 bg-background/80">
                  <Plus className="size-6 text-foreground" />
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <AppCardTitle className="truncate text-sm">Create Relay</AppCardTitle>
                  <div className="text-xs leading-5 text-muted-foreground">
                    Add a relay card for local MCP servers and generate a new agent token.
                  </div>
                </div>
              </div>
            </AppCardHeader>

            <AppCardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">Relay</Badge>
                <Badge variant="outline">User managed</Badge>
              </div>
            </AppCardContent>
          </AppCard>
        </div>
      )}

      <Dialog open={createRelayOpen} onOpenChange={setCreateRelayOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Relay</DialogTitle>
            <DialogDescription>
              Add a relay card for local MCP servers and generate a connection token.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Input
              value={newRelayName}
              onChange={(event) => setNewRelayName(event.target.value)}
              placeholder="Relay name"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateRelayOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleCreateRelay()} disabled={creatingRelay || !newRelayName.trim()}>
              {creatingRelay ? 'Creating...' : 'Create Relay'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={relayConfig !== null} onOpenChange={(open) => !open && !savingRelay && setRelayConfig(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Relay Configuration</DialogTitle>
            <DialogDescription>
              Update the relay name, regenerate a new token, or remove this relay.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Input
              value={relayDraftName}
              onChange={(event) => setRelayDraftName(event.target.value)}
              placeholder="Relay name"
            />

            {relayConfig ? (
              <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                <div className="flex items-center gap-2 text-foreground">
                  <Wrench className="size-4" />
                  {relayConfig.name}
                </div>
                <div className="mt-2">
                  {relayConfig.isConnected ? 'Connected to workspace' : 'Not connected right now'}
                </div>
                {relayConfig.lastConnectedAt ? (
                  <div className="mt-1">Last seen {new Date(relayConfig.lastConnectedAt).toLocaleString()}</div>
                ) : null}
              </div>
            ) : null}
          </div>

          <Separator />

          <div className="flex flex-wrap justify-between gap-2">
            <Button type="button" variant="destructive" onClick={() => void handleDeleteRelay()} disabled={savingRelay}>
              Delete Relay
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void handleRegenerateRelayToken()} disabled={savingRelay}>
                Regenerate Token
              </Button>
              <Button type="button" onClick={() => void handleSaveRelay()} disabled={savingRelay || !relayDraftName.trim()}>
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={tokenDialog !== null} onOpenChange={(open) => !open && setTokenDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Relay Token</DialogTitle>
            <DialogDescription>
              Use this endpoint and token in your relay agent. Keep the token private.
            </DialogDescription>
          </DialogHeader>

          {tokenDialog ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
                <div className="text-sm font-medium text-foreground">{tokenDialog.name}</div>
                <div className="mt-2 text-xs text-muted-foreground">Endpoint</div>
                <div className="mt-1 break-all text-sm text-foreground">{getRelayEndpoint()}</div>
                <div className="mt-3 text-xs text-muted-foreground">Token</div>
                <div className="mt-1 break-all font-mono text-sm text-foreground">{tokenDialog.token}</div>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setTokenDialog(null)}>
              Done
            </Button>
            <Button
              type="button"
              onClick={async () => {
                if (!tokenDialog) return;
                await navigator.clipboard.writeText(tokenDialog.token);
                toast.success('Token copied');
              }}
            >
              Copy Token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
