'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Plus, Trash2, RefreshCw, Copy, Check, ChevronDown, ChevronRight,
  Radio, Wifi, WifiOff, Server, KeyRound, Wrench, Monitor, ExternalLink, Clipboard, Shield,
} from 'lucide-react';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { useAuthStore } from '@/stores/auth-store';
import { api } from '@/lib/api';

const LOCAL_CLIENT_PORT = 21519;

const scopeColors: Record<string, string> = {
  workspace: 'border-blue-500/30 text-blue-400',
  user: 'border-purple-500/30 text-purple-400',
  actor: 'border-green-500/30 text-green-400',
  group: 'border-orange-500/30 text-orange-400',
};

const scopeLabels: Record<string, string> = {
  workspace: 'Workspace',
  user: 'User',
  actor: 'Actor',
  group: 'Group',
};

const lifecycleOptionsForScope: Record<string, string[]> = {
  workspace: ['workspace', 'group', 'actor', 'session'],
  user: ['user', 'actor', 'session'],
  actor: ['actor', 'session'],
  group: ['group', 'actor', 'session'],
};

interface Relay {
  id: string;
  name: string;
  isConnected: boolean;
  lastConnectedAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface RelayServer {
  id: string;
  name: string;
  transport: string;
  toolsManifest: any[];
  isEnabled: boolean;
  createdAt: string;
  installId: string | null;
  scopeType: string | null;
  scopeId: string | null;
  lifecycleScope: string | null;
  installEnabled: boolean | null;
}

function getRelayEndpoint(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/relay`;
}

export default function RelayList() {
  const { workspaceId } = useWorkspace();
  const user = useAuthStore((s) => s.user);
  const [relays, setRelays] = useState<Relay[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createdToken, setCreatedToken] = useState<{ name: string; token: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [expandedRelay, setExpandedRelay] = useState<string | null>(null);
  const [relayServers, setRelayServers] = useState<Record<string, RelayServer[]>>({});
  const [copiedToken, setCopiedToken] = useState(false);
  const [regeneratedToken, setRegeneratedToken] = useState<{ relayId: string; name: string; token: string } | null>(null);

  // Scope selection resources
  const [actors, setActors] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [scopeResourcesLoaded, setScopeResourcesLoaded] = useState(false);

  // Client detection state
  const [clientDetected, setClientDetected] = useState(false);
  const [clientSending, setClientSending] = useState(false);
  const [clientResult, setClientResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [copiedConfig, setCopiedConfig] = useState(false);

  // Probe local client on mount and periodically
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${LOCAL_CLIENT_PORT}/ping`, {
          signal: AbortSignal.timeout(2000),
        });
        if (!cancelled && res.ok) setClientDetected(true);
      } catch {
        if (!cancelled) setClientDetected(false);
      }
    };
    probe();
    const interval = setInterval(probe, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const loadRelays = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const data = await api.getRelays(workspaceId);
      setRelays(data);
    } catch (err) {
      console.error('Failed to load relays:', err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadRelays();
  }, [loadRelays]);

  const handleCreate = async () => {
    if (!workspaceId || !newName.trim()) return;
    setCreating(true);
    try {
      const result = await api.createRelay(workspaceId, { name: newName.trim() });
      setCreatedToken({ name: result.name, token: result.token });
      setShowCreate(false);
      setNewName('');
      setClientResult(null);
      setCopiedConfig(false);
      await loadRelays();
    } catch (err) {
      console.error('Failed to create relay:', err);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (relayId: string) => {
    if (!workspaceId) return;
    if (!confirm('Delete this relay? Any connected agent will be disconnected.')) return;
    try {
      await api.deleteRelay(workspaceId, relayId);
      setRelays(relays.filter(r => r.id !== relayId));
    } catch (err) {
      console.error('Failed to delete relay:', err);
    }
  };

  const handleRegenerate = async (relay: Relay) => {
    if (!workspaceId) return;
    if (!confirm('Regenerate token? The current token will be invalidated and the agent will disconnect.')) return;
    try {
      const result = await api.regenerateRelayToken(workspaceId, relay.id);
      setRegeneratedToken({ relayId: relay.id, name: result.name, token: result.token });
      setClientResult(null);
      setCopiedConfig(false);
      await loadRelays();
    } catch (err) {
      console.error('Failed to regenerate token:', err);
    }
  };

  const toggleExpand = async (relayId: string) => {
    if (expandedRelay === relayId) {
      setExpandedRelay(null);
      return;
    }
    setExpandedRelay(relayId);
    if (!relayServers[relayId] && workspaceId) {
      try {
        const servers = await api.getRelayServers(workspaceId, relayId);
        setRelayServers(prev => ({ ...prev, [relayId]: servers }));
      } catch (err) {
        console.error('Failed to load relay servers:', err);
      }
    }
    // Load actors/groups for scope selection
    if (!scopeResourcesLoaded && workspaceId) {
      setScopeResourcesLoaded(true);
      Promise.all([
        api.getActors(workspaceId).catch(() => []),
        api.getGroups(workspaceId).then((r: any) => r.groups || []).catch(() => []),
      ]).then(([a, g]) => { setActors(a); setGroups(g); });
    }
  };

  const handleUpdateServerScope = async (relayId: string, server: RelayServer, scopeType: string, scopeId: string, lifecycleScope?: string) => {
    if (!workspaceId || !server.installId) return;
    try {
      const data: any = { scopeType, scopeId };
      // Auto-adjust lifecycle if current one is invalid for new scope
      const validLifecycles = lifecycleOptionsForScope[scopeType] || ['session'];
      const currentLifecycle = lifecycleScope || server.lifecycleScope || 'session';
      if (!validLifecycles.includes(currentLifecycle)) {
        data.lifecycleScope = validLifecycles[0];
      } else if (lifecycleScope) {
        data.lifecycleScope = lifecycleScope;
      }
      await api.updateInstallation(workspaceId, server.installId, data);
      // Refresh servers
      const servers = await api.getRelayServers(workspaceId, relayId);
      setRelayServers(prev => ({ ...prev, [relayId]: servers }));
    } catch (err: any) {
      alert('Failed to update scope: ' + (err.message || err));
    }
  };

  const handleUpdateServerLifecycle = async (relayId: string, server: RelayServer, lifecycleScope: string) => {
    if (!workspaceId || !server.installId) return;
    try {
      await api.updateInstallation(workspaceId, server.installId, { lifecycleScope });
      setRelayServers(prev => ({
        ...prev,
        [relayId]: (prev[relayId] || []).map(s =>
          s.id === server.id ? { ...s, lifecycleScope } : s
        ),
      }));
    } catch (err: any) {
      alert('Failed to update lifecycle: ' + (err.message || err));
    }
  };

  const handleToggleServer = async (relayId: string, serverId: string, isEnabled: boolean) => {
    if (!workspaceId) return;
    try {
      await api.updateRelayServer(workspaceId, relayId, serverId, { isEnabled });
      setRelayServers(prev => ({
        ...prev,
        [relayId]: (prev[relayId] || []).map(s =>
          s.id === serverId ? { ...s, isEnabled } : s
        ),
      }));
    } catch (err) {
      console.error('Failed to toggle server:', err);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 2000);
  };

  // --- Config delivery methods ---

  const sendToClient = async (token: string) => {
    setClientSending(true);
    setClientResult(null);
    try {
      const res = await fetch(`http://127.0.0.1:${LOCAL_CLIENT_PORT}/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: getRelayEndpoint(), token }),
        signal: AbortSignal.timeout(30000), // user needs time to confirm
      });
      const data = await res.json();
      setClientResult({
        ok: data.accepted,
        message: data.accepted ? 'Configuration sent and accepted by client!' : (data.message || 'User rejected the configuration'),
      });
    } catch (err: any) {
      setClientResult({ ok: false, message: `Failed to reach client: ${err?.message || err}` });
    } finally {
      setClientSending(false);
    }
  };

  const openDeepLink = (token: string) => {
    const endpoint = encodeURIComponent(getRelayEndpoint());
    const encodedToken = encodeURIComponent(token);
    window.location.href = `synapse-relay://setup?endpoint=${endpoint}&token=${encodedToken}`;
  };

  const copyConfig = (token: string) => {
    const yaml = `endpoint: "${getRelayEndpoint()}"\ntoken: "${token}"\nlog_level: "info"\nservers: []`;
    navigator.clipboard.writeText(yaml);
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  };

  // Reusable token actions component
  const TokenActions = ({ token }: { token: string }) => (
    <div className="space-y-3">
      {/* Method 1: Send to local client (if detected) */}
      {clientDetected && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="flex-1 gap-2"
            onClick={() => sendToClient(token)}
            disabled={clientSending}
          >
            <Monitor className="w-4 h-4" />
            {clientSending ? 'Waiting for confirmation...' : 'Send to Desktop Client'}
          </Button>
          <Badge variant="outline" className="text-xs border-emerald-500/30 text-emerald-400 shrink-0">
            Client Detected
          </Badge>
        </div>
      )}

      <div className="flex items-center gap-2">
        {/* Method 2: Deep link */}
        <Button size="sm" variant="outline" className="flex-1 gap-2" onClick={() => openDeepLink(token)}>
          <ExternalLink className="w-4 h-4" />
          Open in Client
        </Button>

        {/* Method 3: Copy full config YAML */}
        <Button size="sm" variant="outline" className="flex-1 gap-2" onClick={() => copyConfig(token)}>
          {copiedConfig ? <Check className="w-4 h-4 text-emerald-400" /> : <Clipboard className="w-4 h-4" />}
          {copiedConfig ? 'Config Copied!' : 'Copy Config YAML'}
        </Button>
      </div>

      {/* Result feedback */}
      {clientResult && (
        <div className={`text-xs px-3 py-2 rounded-lg border ${
          clientResult.ok
            ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
            : 'bg-red-500/10 border-red-500/20 text-red-400'
        }`}>
          {clientResult.message}
        </div>
      )}
    </div>
  );

  if (loading) {
    return <div className="text-center py-12 text-muted-foreground">Loading relays...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Header with create button */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Connect local MCP servers to Synapse via relay tunnel agents.
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={loadRelays}>
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)} className="gap-1.5">
            <Plus className="w-4 h-4" />
            New Relay
          </Button>
        </div>
      </div>

      {/* Relay list */}
      {relays.length === 0 ? (
        <div className="text-center py-12">
          <Radio className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-muted-foreground">No relay agents registered.</p>
          <p className="text-sm text-muted-foreground mt-1">
            Create a relay to expose local MCP servers to your workspace.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {relays.map(relay => (
            <Card key={relay.id} className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10">
              <CardContent className="p-0">
                {/* Main row */}
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <button onClick={() => toggleExpand(relay.id)} className="text-muted-foreground hover:text-foreground transition-colors">
                      {expandedRelay === relay.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                    <div className="w-9 h-9 rounded-lg bg-indigo-500/10 flex items-center justify-center flex-shrink-0">
                      <Radio className="w-4 h-4 text-indigo-400" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm truncate">{relay.name}</p>
                        <Badge variant="outline" className={`text-xs gap-1 ${
                          relay.isConnected
                            ? 'border-emerald-500/30 text-emerald-400'
                            : 'border-gray-300 dark:border-white/10 text-muted-foreground'
                        }`}>
                          {relay.isConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                          {relay.isConnected ? 'Connected' : 'Offline'}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        ID: {relay.id.slice(0, 8)}
                        {relay.lastConnectedAt && ` · Last seen ${new Date(relay.lastConnectedAt).toLocaleString()}`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button size="icon" variant="ghost" title="Regenerate Token" onClick={() => handleRegenerate(relay)}>
                      <KeyRound className="w-4 h-4" />
                    </Button>
                    <Button size="icon" variant="ghost" className="text-red-400 hover:text-red-300" title="Delete" onClick={() => handleDelete(relay.id)}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                {/* Expanded: servers list */}
                {expandedRelay === relay.id && (
                  <div className="border-t border-gray-200 dark:border-white/10 px-4 py-3 bg-gray-50 dark:bg-white/[0.02]">
                    {!relayServers[relay.id] ? (
                      <p className="text-xs text-muted-foreground">Loading servers...</p>
                    ) : relayServers[relay.id].length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {relay.isConnected
                          ? 'Agent connected but no servers registered yet.'
                          : 'No servers. Connect the relay agent to register servers.'}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">MCP Servers</p>
                        {relayServers[relay.id].map(server => (
                          <div key={server.id} className="rounded-lg border border-gray-200 dark:border-white/10 p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2.5">
                                <Server className="w-3.5 h-3.5 text-muted-foreground" />
                                <div>
                                  <p className="text-sm font-medium">{server.name}</p>
                                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                    <span>{server.transport}</span>
                                    <span>·</span>
                                    <Wrench className="w-3 h-3" />
                                    <span>{server.toolsManifest?.length || 0} tools</span>
                                  </div>
                                </div>
                              </div>
                              <Switch
                                checked={server.isEnabled}
                                onCheckedChange={(checked) => handleToggleServer(relay.id, server.id, checked)}
                              />
                            </div>
                            {/* Scope & Lifecycle controls */}
                            {server.installId && (
                              <div className="flex items-center gap-2 pt-1 border-t border-gray-100 dark:border-white/5">
                                <Shield className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                                <select
                                  className="h-7 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-2 text-xs bg-white dark:bg-gray-900"
                                  value={server.scopeType || 'workspace'}
                                  onChange={(e) => {
                                    const newScope = e.target.value;
                                    let newScopeId = workspaceId || '';
                                    if (newScope === 'user') newScopeId = user?.id || '';
                                    if (newScope === 'workspace') newScopeId = workspaceId || '';
                                    // For actor/group, show first available as default
                                    if (newScope === 'actor') newScopeId = actors[0]?.id || '';
                                    if (newScope === 'group') newScopeId = groups[0]?.id || '';
                                    handleUpdateServerScope(relay.id, server, newScope, newScopeId);
                                  }}
                                >
                                  {Object.entries(scopeLabels).map(([value, label]) => (
                                    <option key={value} value={value}>{label}</option>
                                  ))}
                                </select>
                                {/* Target selector for actor/group scope */}
                                {server.scopeType === 'actor' && (
                                  <select
                                    className="h-7 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-2 text-xs bg-white dark:bg-gray-900 max-w-[140px]"
                                    value={server.scopeId || ''}
                                    onChange={(e) => handleUpdateServerScope(relay.id, server, 'actor', e.target.value)}
                                  >
                                    {actors.map((a: any) => (
                                      <option key={a.id} value={a.id}>{a.name}</option>
                                    ))}
                                  </select>
                                )}
                                {server.scopeType === 'group' && (
                                  <select
                                    className="h-7 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-2 text-xs bg-white dark:bg-gray-900 max-w-[140px]"
                                    value={server.scopeId || ''}
                                    onChange={(e) => handleUpdateServerScope(relay.id, server, 'group', e.target.value)}
                                  >
                                    {groups.map((g: any) => (
                                      <option key={g.id} value={g.id}>{g.name}</option>
                                    ))}
                                  </select>
                                )}
                                <span className="text-xs text-muted-foreground">·</span>
                                <select
                                  className="h-7 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-2 text-xs bg-white dark:bg-gray-900"
                                  value={server.lifecycleScope || 'session'}
                                  onChange={(e) => handleUpdateServerLifecycle(relay.id, server, e.target.value)}
                                >
                                  {(lifecycleOptionsForScope[server.scopeType || 'workspace'] || ['session']).map(opt => (
                                    <option key={opt} value={opt}>{opt}</option>
                                  ))}
                                </select>
                              </div>
                            )}
                            {!server.installId && (
                              <p className="text-xs text-muted-foreground italic pt-1 border-t border-gray-100 dark:border-white/5">
                                No installation record — reconnect relay to create one
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Relay Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Relay Agent</DialogTitle>
            <DialogDescription>
              Create a relay to tunnel local MCP servers to this workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label>Name</Label>
              <Input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. My Laptop, Dev Server"
                className="mt-1.5"
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
              {creating ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Token Display Dialog (shown after creation) */}
      <Dialog open={!!createdToken} onOpenChange={() => setCreatedToken(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Relay Created: {createdToken?.name}</DialogTitle>
            <DialogDescription>
              Send the configuration to your desktop client, or copy the token manually.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Config delivery buttons */}
            {createdToken && <TokenActions token={createdToken.token} />}

            <div className="border-t border-gray-200 dark:border-white/10 pt-4">
              <Label className="text-xs text-muted-foreground">Authentication Token</Label>
              <div className="flex items-center gap-2 mt-1.5">
                <code className="flex-1 text-xs bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-md p-3 font-mono break-all select-all">
                  {createdToken?.token}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => createdToken && copyToClipboard(createdToken.token)}
                >
                  {copiedToken ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>

            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
              <p className="text-xs text-amber-400 font-medium">Save this token now</p>
              <p className="text-xs text-muted-foreground mt-1">
                You won&apos;t be able to see this token again after closing this dialog.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setCreatedToken(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Regenerated Token Dialog */}
      <Dialog open={!!regeneratedToken} onOpenChange={() => setRegeneratedToken(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New Token for: {regeneratedToken?.name}</DialogTitle>
            <DialogDescription>
              The old token has been invalidated. Send the new configuration to your client.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Config delivery buttons */}
            {regeneratedToken && <TokenActions token={regeneratedToken.token} />}

            <div className="border-t border-gray-200 dark:border-white/10 pt-4">
              <Label className="text-xs text-muted-foreground">New Authentication Token</Label>
              <div className="flex items-center gap-2 mt-1.5">
                <code className="flex-1 text-xs bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-md p-3 font-mono break-all select-all">
                  {regeneratedToken?.token}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => regeneratedToken && copyToClipboard(regeneratedToken.token)}
                >
                  {copiedToken ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setRegeneratedToken(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
