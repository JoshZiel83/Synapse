'use client';

import { useEffect, useState } from 'react';
import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Users, Cpu, Plus, Trash2, GripVertical, RefreshCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Actor {
  id: string;
  name: string;
  role: string;
  title: string;
}

function normalizeActor(actor: any): Actor {
  const definition = actor?.definition || actor;
  return {
    id: actor.id,
    name: definition.name,
    role: definition.role,
    title: definition.title,
  };
}

interface AssignedGroup {
  actor_id: string;
  group_id: string;
  priority: number;
  group_name: string;
  routing_strategy: string;
  is_default: boolean;
  workspace_id: string | null;
}

interface ModelGroup {
  id: string;
  name: string;
  workspace_id: string | null;
  is_default: boolean;
  routing_strategy: string;
}

export default function ActorAssignment() {
  const { workspaceId } = useWorkspace();
  const [actors, setActors] = useState<Actor[]>([]);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [selectedActor, setSelectedActor] = useState<Actor | null>(null);
  const [assignedGroups, setAssignedGroups] = useState<AssignedGroup[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    Promise.all([
      api.getActors(workspaceId),
      api.getModelGroups(workspaceId),
    ])
      .then(([actorsRes, groupsRes]) => {
        const actorList = actorsRes?.data ?? actorsRes?.actors ?? actorsRes ?? [];
        setActors(Array.isArray(actorList) ? actorList.map(normalizeActor) : []);
        setGroups(groupsRes.groups || []);
      })
      .catch((err) => console.error('Failed to load data:', err))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  const handleSelectActor = async (actor: Actor) => {
    if (!workspaceId) return;
    setSelectedActor(actor);
    try {
      const res = await api.getActorModelGroups(workspaceId, actor.id);
      setAssignedGroups(res.groups || []);
      setDialogOpen(true);
    } catch (err) {
      console.error('Failed to load actor groups:', err);
    }
  };

  const handleAddGroup = (groupId: string) => {
    if (assignedGroups.some(g => g.group_id === groupId)) return;
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    setAssignedGroups(prev => [
      ...prev,
      {
        actor_id: selectedActor!.id,
        group_id: groupId,
        priority: prev.length,
        group_name: group.name,
        routing_strategy: group.routing_strategy,
        is_default: group.is_default,
        workspace_id: group.workspace_id,
      },
    ]);
  };

  const handleRemoveGroup = (groupId: string) => {
    setAssignedGroups(prev =>
      prev.filter(g => g.group_id !== groupId).map((g, i) => ({ ...g, priority: i }))
    );
  };

  const handleMoveUp = (idx: number) => {
    if (idx === 0) return;
    setAssignedGroups(prev => {
      const arr = [...prev];
      [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
      return arr.map((g, i) => ({ ...g, priority: i }));
    });
  };

  const handleMoveDown = (idx: number) => {
    if (idx >= assignedGroups.length - 1) return;
    setAssignedGroups(prev => {
      const arr = [...prev];
      [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
      return arr.map((g, i) => ({ ...g, priority: i }));
    });
  };

  const handleSave = async () => {
    if (!workspaceId || !selectedActor) return;
    setSaving(true);
    try {
      await api.setActorModelGroups(
        workspaceId,
        selectedActor.id,
        assignedGroups.map(g => ({ groupId: g.group_id, priority: g.priority }))
      );
      setDialogOpen(false);
    } catch (err) {
      console.error('Failed to save actor groups:', err);
    } finally {
      setSaving(false);
    }
  };

  const availableGroups = groups.filter(g => !assignedGroups.some(ag => ag.group_id === g.id));

  const roleBadgeStyle = (role: string) => {
    switch (role) {
      case 'secretary': return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
      case 'manager': return 'bg-violet-500/10 text-violet-400 border-violet-500/20';
      case 'specialist': return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      default: return 'bg-gray-500/10 text-gray-400 border-gray-500/20';
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Assign model groups to actors as a failover chain. Higher position = higher priority.
      </p>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
        </div>
      ) : actors.length === 0 ? (
        <Card className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10">
          <CardContent className="flex flex-col items-center py-12">
            <Users className="w-12 h-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">No actors found</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {actors.map((actor) => (
            <Card
              key={actor.id}
              className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10 hover:border-blue-500/25 transition-all cursor-pointer"
              onClick={() => handleSelectActor(actor)}
            >
              <CardContent className="flex items-center justify-between p-4">
                <div className="flex items-center gap-4">
                  <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-gray-200 dark:border-white/10">
                    <Users className="w-5 h-5 text-blue-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{actor.name}</span>
                      <Badge className={`${roleBadgeStyle(actor.role)} text-xs`}>{actor.role}</Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">{actor.title}</span>
                  </div>
                </div>
                <Button variant="outline" size="sm" className="border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5">
                  <Cpu className="w-4 h-4 mr-1" /> Configure
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Model Groups for {selectedActor?.name}
            </DialogTitle>
            <DialogDescription>
              Arrange groups in failover order. The system tries each group top-to-bottom.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {assignedGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No groups assigned. This actor will use workspace/platform defaults.
              </p>
            ) : (
              <div className="space-y-2">
                {assignedGroups.map((g, idx) => (
                  <div
                    key={g.group_id}
                    className="flex items-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-white/10 bg-background/30"
                  >
                    <div className="flex flex-col gap-0.5">
                      <button
                        onClick={() => handleMoveUp(idx)}
                        disabled={idx === 0}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30 text-xs"
                      >
                        ▲
                      </button>
                      <button
                        onClick={() => handleMoveDown(idx)}
                        disabled={idx >= assignedGroups.length - 1}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30 text-xs"
                      >
                        ▼
                      </button>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-xs">
                          #{idx + 1}
                        </Badge>
                        <span className="text-sm font-medium">{g.group_name}</span>
                        {g.is_default && (
                          <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-xs">
                            Default
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost" size="icon"
                      onClick={() => handleRemoveGroup(g.group_id)}
                      className="text-muted-foreground hover:text-red-400 h-8 w-8"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {availableGroups.length > 0 && (
              <div className="space-y-2">
                <span className="text-xs text-muted-foreground font-medium">Add group:</span>
                <div className="flex flex-wrap gap-2">
                  {availableGroups.map(g => (
                    <Button
                      key={g.id}
                      variant="outline"
                      size="sm"
                      onClick={() => handleAddGroup(g.id)}
                      className="border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5 text-xs"
                    >
                      <Plus className="w-3 h-3 mr-1" /> {g.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} className="border-gray-200 dark:border-white/10">
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}
              className="bg-indigo-600 hover:bg-indigo-500">
              {saving ? 'Saving...' : 'Save Assignment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
