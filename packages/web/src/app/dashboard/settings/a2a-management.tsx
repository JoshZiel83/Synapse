'use client';

import { useEffect, useState, useCallback } from 'react';
import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Plus, Copy, Trash2, Check, RotateCcw, Power, Eye, EyeOff } from 'lucide-react';

interface A2AAppActor {
  id: string;
  name: string;
  title: string;
  role: string;
}

interface A2AApp {
  id: string;
  name: string;
  description: string;
  apiKeyPrefix: string;
  rateLimitRpm: number;
  isActive: boolean;
  createdAt: string;
  actors: A2AAppActor[];
}

interface WorkspaceActor {
  id: string;
  name: string;
  title: string;
  role: string;
}

export default function A2AManagement() {
  const { workspaceId } = useWorkspace();
  const [apps, setApps] = useState<A2AApp[]>([]);
  const [actors, setActors] = useState<WorkspaceActor[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [showKeyFor, setShowKeyFor] = useState<string | null>(null);

  // Create form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedActorIds, setSelectedActorIds] = useState<string[]>([]);
  const [rateLimitRpm, setRateLimitRpm] = useState('60');
  const [creating, setCreating] = useState(false);

  const loadApps = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await api.getA2AApps(workspaceId);
      setApps(res?.apps ?? []);
    } catch (err) {
      console.error('Failed to load A2A apps:', err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const loadActors = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await api.getActors(workspaceId);
      setActors(res?.actors ?? []);
    } catch (err) {
      console.error('Failed to load actors:', err);
    }
  }, [workspaceId]);

  useEffect(() => { loadApps(); loadActors(); }, [loadApps, loadActors]);

  const handleCreate = async () => {
    if (!workspaceId || !name.trim() || selectedActorIds.length === 0) return;
    setCreating(true);
    try {
      const res = await api.createA2AApp(workspaceId, {
        name: name.trim(),
        description: description.trim(),
        actorIds: selectedActorIds,
        rateLimitRpm: parseInt(rateLimitRpm, 10) || 60,
      });
      setNewApiKey(res.apiKey);
      setShowKeyFor(res.app.id);
      setDialogOpen(false);
      setName('');
      setDescription('');
      setSelectedActorIds([]);
      setRateLimitRpm('60');
      loadApps();
    } catch (err: any) {
      alert(err.message || 'Failed to create A2A app');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (appId: string) => {
    if (!workspaceId || !confirm('Delete this A2A app? All API keys will be invalidated.')) return;
    try {
      await api.deleteA2AApp(workspaceId, appId);
      loadApps();
    } catch (err: any) {
      alert(err.message || 'Failed to delete app');
    }
  };

  const handleToggleActive = async (appId: string, isActive: boolean) => {
    if (!workspaceId) return;
    try {
      await api.updateA2AApp(workspaceId, appId, { isActive: !isActive });
      loadApps();
    } catch (err: any) {
      alert(err.message || 'Failed to update app');
    }
  };

  const handleRegenerateKey = async (appId: string) => {
    if (!workspaceId || !confirm('Regenerate API key? The old key will stop working immediately.')) return;
    try {
      const res = await api.regenerateA2AAppKey(workspaceId, appId);
      setNewApiKey(res.apiKey);
      setShowKeyFor(appId);
    } catch (err: any) {
      alert(err.message || 'Failed to regenerate key');
    }
  };

  const copyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const toggleActor = (actorId: string) => {
    setSelectedActorIds(prev =>
      prev.includes(actorId)
        ? prev.filter(id => id !== actorId)
        : [...prev, actorId]
    );
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">A2A Apps</h3>
          <p className="text-sm text-muted-foreground">Expose your actors via the A2A protocol for external integrations</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              Create App
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create A2A App</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div>
                <Label>App Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. My Integration"
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label>Description (optional)</Label>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this app is used for"
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label>Exposed Actors</Label>
                <div className="mt-1.5 space-y-1 max-h-48 overflow-y-auto border border-gray-200 dark:border-white/10 rounded-md p-2">
                  {actors.map((actor) => (
                    <label
                      key={actor.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedActorIds.includes(actor.id)}
                        onChange={() => toggleActor(actor.id)}
                        className="rounded border-gray-300"
                      />
                      <span className="text-sm text-foreground">{actor.name}</span>
                      <span className="text-xs text-muted-foreground">({actor.title})</span>
                    </label>
                  ))}
                  {actors.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-2">No actors available</p>
                  )}
                </div>
              </div>
              <div>
                <Label>Rate Limit (requests/minute)</Label>
                <Input
                  type="number"
                  min="1"
                  max="10000"
                  value={rateLimitRpm}
                  onChange={(e) => setRateLimitRpm(e.target.value)}
                  className="mt-1.5"
                />
              </div>
              <Button
                onClick={handleCreate}
                disabled={creating || !name.trim() || selectedActorIds.length === 0}
                className="w-full"
              >
                {creating ? 'Creating...' : 'Create A2A App'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* New API key display */}
      {newApiKey && showKeyFor && (
        <Card className="border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20">
          <CardContent className="py-4 px-4 space-y-2">
            <p className="text-sm font-medium text-green-800 dark:text-green-300">
              API Key generated — copy it now, it won&apos;t be shown again!
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-white dark:bg-black/30 rounded px-3 py-2 border break-all">
                {newApiKey}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyText(newApiKey, 'new-key')}
                className="h-8 w-8 p-0 shrink-0"
              >
                {copiedId === 'new-key' ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setNewApiKey(null); setShowKeyFor(null); }}
              className="text-xs text-muted-foreground"
            >
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {apps.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No A2A apps yet. Create one to expose your actors via the A2A protocol.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {apps.map((app) => {
            const agentCardUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/a2a/${app.id}/.well-known/agent.json`;
            const endpointUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/a2a/${app.id}`;

            return (
              <Card key={app.id} className={!app.isActive ? 'opacity-60' : ''}>
                <CardContent className="py-4 px-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-semibold text-foreground">{app.name}</h4>
                        <Badge variant={app.isActive ? 'default' : 'secondary'} className="text-xs">
                          {app.isActive ? 'Active' : 'Disabled'}
                        </Badge>
                      </div>
                      {app.description && (
                        <p className="text-sm text-muted-foreground mt-0.5">{app.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleToggleActive(app.id, app.isActive)}
                        className="h-8 w-8 p-0"
                        title={app.isActive ? 'Disable' : 'Enable'}
                      >
                        <Power className={`h-4 w-4 ${app.isActive ? 'text-green-600' : 'text-gray-400'}`} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRegenerateKey(app.id)}
                        className="h-8 w-8 p-0"
                        title="Regenerate API key"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(app.id)}
                        className="h-8 w-8 p-0 text-red-500 hover:text-red-600"
                        title="Delete app"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {/* Actors */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs text-muted-foreground">Actors:</span>
                    {app.actors.map((actor) => (
                      <Badge key={actor.id} variant="outline" className="text-xs">
                        {actor.name}
                      </Badge>
                    ))}
                  </div>

                  {/* Endpoints */}
                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-20 shrink-0">Key prefix:</span>
                      <code className="font-mono text-foreground">{app.apiKeyPrefix}...</code>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-20 shrink-0">Agent Card:</span>
                      <code className="font-mono text-foreground truncate flex-1">{agentCardUrl}</code>
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => copyText(agentCardUrl, `card-${app.id}`)}
                        className="h-6 w-6 p-0 shrink-0"
                      >
                        {copiedId === `card-${app.id}` ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-20 shrink-0">Endpoint:</span>
                      <code className="font-mono text-foreground truncate flex-1">{endpointUrl}</code>
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => copyText(endpointUrl, `ep-${app.id}`)}
                        className="h-6 w-6 p-0 shrink-0"
                      >
                        {copiedId === `ep-${app.id}` ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-20 shrink-0">Rate limit:</span>
                      <span className="text-foreground">{app.rateLimitRpm} req/min</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
