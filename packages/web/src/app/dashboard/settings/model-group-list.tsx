'use client';

import { useEffect, useState } from 'react';
import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Cpu,
  Plus,
  RefreshCw,
  Globe,
  Building2,
  ChevronRight,
  Star,
} from 'lucide-react';
import ModelGroupDialog from './model-group-dialog';
import ModelGroupDetail from './model-group-detail';

interface ModelGroup {
  id: string;
  workspace_id: string | null;
  name: string;
  description: string;
  routing_strategy: string;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
}

export default function ModelGroupList() {
  const { workspaceId } = useWorkspace();
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editGroup, setEditGroup] = useState<ModelGroup | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  const loadGroups = async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const res = await api.getModelGroups(workspaceId);
      setGroups(res.groups || []);
    } catch (err) {
      console.error('Failed to load model groups:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadGroups(); }, [workspaceId]);

  const handleCreated = () => {
    setDialogOpen(false);
    setEditGroup(null);
    loadGroups();
  };

  const handleEdit = (g: ModelGroup) => {
    setEditGroup(g);
    setDialogOpen(true);
  };

  if (selectedGroupId) {
    return (
      <ModelGroupDetail
        groupId={selectedGroupId}
        onBack={() => { setSelectedGroupId(null); loadGroups(); }}
      />
    );
  }

  const strategyLabel = (s: string) => {
    switch (s) {
      case 'weighted_random': return 'Weighted Random';
      case 'round_robin': return 'Round Robin';
      case 'priority_failover': return 'Priority Failover';
      default: return s;
    }
  };

  const platformGroups = groups.filter(g => !g.workspace_id);
  const workspaceGroups = groups.filter(g => !!g.workspace_id);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Configure AI model groups with routing strategies and failover chains
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={loadGroups} className="border-blue-500/20 hover:bg-blue-500/10">
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh
          </Button>
          <Button size="sm" onClick={() => { setEditGroup(null); setDialogOpen(true); }}
            className="bg-gradient-to-r from-blue-500 to-violet-600 hover:from-blue-600 hover:to-violet-700">
            <Plus className="w-4 h-4 mr-1" /> New Group
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
        </div>
      ) : groups.length === 0 ? (
        <Card className="glass-card border-blue-500/10">
          <CardContent className="flex flex-col items-center py-12">
            <Cpu className="w-12 h-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">No model groups configured</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Create a group to manage AI model routing</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {platformGroups.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Globe className="w-4 h-4" />
                <span className="font-medium">Platform Groups</span>
              </div>
              <div className="grid gap-3">
                {platformGroups.map(g => (
                  <GroupCard key={g.id} group={g} onSelect={() => setSelectedGroupId(g.id)} onEdit={() => handleEdit(g)} strategyLabel={strategyLabel} />
                ))}
              </div>
            </div>
          )}

          {workspaceGroups.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Building2 className="w-4 h-4" />
                <span className="font-medium">Workspace Groups</span>
              </div>
              <div className="grid gap-3">
                {workspaceGroups.map(g => (
                  <GroupCard key={g.id} group={g} onSelect={() => setSelectedGroupId(g.id)} onEdit={() => handleEdit(g)} strategyLabel={strategyLabel} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <ModelGroupDialog
        open={dialogOpen}
        onOpenChange={(o) => { setDialogOpen(o); if (!o) setEditGroup(null); }}
        group={editGroup}
        onSaved={handleCreated}
      />
    </div>
  );
}

function GroupCard({ group, onSelect, onEdit, strategyLabel }: {
  group: ModelGroup;
  onSelect: () => void;
  onEdit: () => void;
  strategyLabel: (s: string) => string;
}) {
  return (
    <Card
      className="glass-card border-blue-500/10 hover:border-blue-500/25 transition-all cursor-pointer group"
      onClick={onSelect}
    >
      <CardContent className="flex items-center justify-between p-4">
        <div className="flex items-center gap-4">
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-blue-500/10">
            <Cpu className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{group.name}</span>
              {group.is_default && (
                <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-xs">
                  <Star className="w-3 h-3 mr-1" /> Default
                </Badge>
              )}
              {!group.workspace_id && (
                <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-xs">
                  <Globe className="w-3 h-3 mr-1" /> Platform
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-xs text-muted-foreground">{strategyLabel(group.routing_strategy)}</span>
              {group.description && (
                <span className="text-xs text-muted-foreground/60 truncate max-w-xs">{group.description}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
          >
            Edit
          </Button>
          <ChevronRight className="w-4 h-4 text-muted-foreground/50 group-hover:text-blue-400 transition-colors" />
        </div>
      </CardContent>
    </Card>
  );
}
