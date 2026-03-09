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
  Radio, Wifi, WifiOff, Server, KeyRound, Wrench,
} from 'lucide-react';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { api } from '@/lib/api';

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
}

export default function RelayList() {
  const { workspaceId } = useWorkspace();
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
                          <div key={server.id} className="flex items-center justify-between py-1.5">
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
              Copy the authentication token below. It will not be shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
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
                Paste it into your relay agent&apos;s <code className="text-xs">config.yaml</code> file.
                You won&apos;t be able to see this token again.
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
              The old token has been invalidated. Copy the new token below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
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
