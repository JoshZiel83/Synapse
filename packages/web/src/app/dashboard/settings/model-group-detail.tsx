'use client';

import { useEffect, useState } from 'react';
import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft,
  Plus,
  Cpu,
  Trash2,
  Power,
  PowerOff,
  History,
  RefreshCw,
} from 'lucide-react';
import ModelItemDialog from './model-item-dialog';
import ModelItemVersions from './model-item-versions';

interface ModelItem {
  id: string;
  group_id: string;
  display_name: string;
  priority: number;
  weight: number;
  is_enabled: boolean;
  current_config_id: string | null;
  // joined config fields
  config_id: string;
  version: number;
  provider_type: string;
  base_url: string;
  model_name: string;
  max_tokens: number;
  capability_tags: string[];
}

interface GroupDetail {
  id: string;
  name: string;
  description: string;
  routing_strategy: string;
  is_default: boolean;
  workspace_id: string | null;
  items: ModelItem[];
}

export default function ModelGroupDetail({ groupId, onBack }: { groupId: string; onBack: () => void }) {
  const { workspaceId } = useWorkspace();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [editItem, setEditItem] = useState<ModelItem | null>(null);
  const [versionsItemId, setVersionsItemId] = useState<string | null>(null);

  const loadGroup = async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const res = await api.getModelGroup(workspaceId, groupId);
      setGroup(res.group);
    } catch (err) {
      console.error('Failed to load model group:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadGroup(); }, [workspaceId, groupId]);

  const handleToggleItem = async (item: ModelItem) => {
    if (!workspaceId) return;
    try {
      await api.updateModelItem(workspaceId, groupId, item.id, { isEnabled: !item.is_enabled });
      loadGroup();
    } catch (err) {
      console.error('Failed to toggle item:', err);
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    if (!workspaceId) return;
    try {
      await api.deleteModelItem(workspaceId, groupId, itemId);
      loadGroup();
    } catch (err) {
      console.error('Failed to delete item:', err);
    }
  };

  const handleItemSaved = () => {
    setItemDialogOpen(false);
    setEditItem(null);
    loadGroup();
  };

  if (versionsItemId) {
    return (
      <ModelItemVersions
        groupId={groupId}
        itemId={versionsItemId}
        onBack={() => setVersionsItemId(null)}
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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        {group && (
          <div>
            <h2 className="text-lg font-semibold text-foreground">{group.name}</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-xs">
                {strategyLabel(group.routing_strategy)}
              </Badge>
              {group.is_default && (
                <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-xs">Default</Badge>
              )}
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
        </div>
      ) : !group ? (
        <p className="text-muted-foreground">Group not found</p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {group.items.length} model{group.items.length !== 1 ? 's' : ''} configured
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={loadGroup} className="border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5">
                <RefreshCw className="w-4 h-4 mr-1" /> Refresh
              </Button>
              <Button size="sm" onClick={() => { setEditItem(null); setItemDialogOpen(true); }}
                className="bg-indigo-600 hover:bg-indigo-500">
                <Plus className="w-4 h-4 mr-1" /> Add Model
              </Button>
            </div>
          </div>

          {group.items.length === 0 ? (
            <Card className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10">
              <CardContent className="flex flex-col items-center py-12">
                <Cpu className="w-12 h-12 text-muted-foreground/50 mb-4" />
                <p className="text-muted-foreground">No models in this group</p>
                <p className="text-xs text-muted-foreground/60 mt-1">Add a model to start using this group</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3">
              {group.items.map((item) => (
                <Card key={item.id} className={`bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10 transition-all ${!item.is_enabled ? 'opacity-50' : ''}`}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-4">
                      <div className={`flex items-center justify-center w-10 h-10 rounded-lg border ${
                        item.is_enabled
                          ? 'bg-gradient-to-br from-emerald-500/20 to-blue-500/20 border-emerald-500/10'
                          : 'bg-red-500/10 border-red-500/10'
                      }`}>
                        <Cpu className={`w-5 h-5 ${item.is_enabled ? 'text-emerald-400' : 'text-red-400'}`} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{item.display_name}</span>
                          <Badge className="bg-violet-500/10 text-violet-400 border-violet-500/20 text-xs">
                            v{item.version || 1}
                          </Badge>
                          {item.provider_type && (
                            <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-xs">
                              {item.provider_type}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span>{item.model_name || 'No model configured'}</span>
                          <span>Priority: {item.priority}</span>
                          <span>Weight: {item.weight}</span>
                          {item.max_tokens && <span>Max tokens: {item.max_tokens}</span>}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost" size="icon"
                        onClick={() => setVersionsItemId(item.id)}
                        title="Version history"
                        className="text-muted-foreground hover:text-indigo-600 dark:hover:text-indigo-400"
                      >
                        <History className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost" size="icon"
                        onClick={() => { setEditItem(item); setItemDialogOpen(true); }}
                        title="Edit"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Cpu className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost" size="icon"
                        onClick={() => handleToggleItem(item)}
                        title={item.is_enabled ? 'Disable' : 'Enable'}
                        className={item.is_enabled ? 'text-emerald-400 hover:text-red-400' : 'text-red-400 hover:text-emerald-400'}
                      >
                        {item.is_enabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                      </Button>
                      <Button
                        variant="ghost" size="icon"
                        onClick={() => handleDeleteItem(item.id)}
                        title="Remove"
                        className="text-muted-foreground hover:text-red-400"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <ModelItemDialog
        open={itemDialogOpen}
        onOpenChange={(o) => { setItemDialogOpen(o); if (!o) setEditItem(null); }}
        groupId={groupId}
        item={editItem}
        onSaved={handleItemSaved}
      />
    </div>
  );
}
