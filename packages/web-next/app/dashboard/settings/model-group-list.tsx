'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Cpu,
  Plus,
  RefreshCw,
  Globe2,
  Building2,
  ChevronRight,
  Star,
  UserRound,
} from 'lucide-react';
import ModelGroupDialog from './model-group-dialog';

type ModelGroupScope = 'workspace' | 'platform' | 'user' | 'all';

interface ModelGroup {
  id: string;
  workspace_id: string | null;
  owner_type?: 'platform' | 'workspace' | 'user';
  owner_workspace_id?: string | null;
  owner_user_id?: string | null;
  name: string;
  description: string;
  routing_strategy: string;
  is_default: boolean;
  is_active?: boolean;
  created_at: string;
}

function strategyLabel(value: string) {
  switch (value) {
    case 'weighted_random':
      return 'Weighted Random';
    case 'round_robin':
      return 'Round Robin';
    case 'priority_failover':
      return 'Priority Failover';
    default:
      return value;
  }
}

function resolveScope(group: ModelGroup): Exclude<ModelGroupScope, 'all'> {
  if (group.owner_type === 'platform' || (!group.owner_type && !group.workspace_id)) {
    return 'platform';
  }
  if (group.owner_type === 'user') {
    return 'user';
  }
  return 'workspace';
}

function scopeVisual(scope: Exclude<ModelGroupScope, 'all'>) {
  switch (scope) {
    case 'platform':
      return {
        label: 'Platform',
        icon: Globe2,
        badgeClassName: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
      };
    case 'user':
      return {
        label: 'User',
        icon: UserRound,
        badgeClassName: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
      };
    default:
      return {
        label: 'Workspace',
        icon: Building2,
        badgeClassName: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
      };
  }
}

export default function ModelGroupList({
  scope = 'all',
  detailOrigin,
}: {
  scope?: ModelGroupScope;
  detailOrigin?: 'workspace' | 'workspace-user' | 'user' | 'platform';
}) {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editGroup, setEditGroup] = useState<ModelGroup | null>(null);

  const loadGroups = async () => {
    if (scope !== 'platform' && scope !== 'user' && !workspaceId) return;
    setLoading(true);
    try {
      let nextGroups: ModelGroup[] = [];

      if (scope === 'platform') {
        const response = await api.getPlatformModelGroups();
        nextGroups = response.groups || [];
      } else if (scope === 'user') {
        const response = await api.getUserModelGroups();
        nextGroups = response.groups || [];
      } else {
        const response = await api.getModelGroups(workspaceId!);
        nextGroups = response.groups || [];
      }

      if (scope === 'workspace') {
        nextGroups = nextGroups.filter((group) => resolveScope(group) === 'workspace');
      }

      setGroups(nextGroups);
    } catch (err) {
      console.error('Failed to load model groups:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadGroups();
  }, [workspaceId, scope]);

  const handleCreated = () => {
    setDialogOpen(false);
    setEditGroup(null);
    void loadGroups();
  };

  const handleEdit = (group: ModelGroup) => {
    setEditGroup(group);
    setDialogOpen(true);
  };

  const emptyLabel =
    scope === 'platform'
      ? 'No platform model groups configured'
      : scope === 'user'
        ? 'No personal model groups configured'
        : 'No workspace model groups configured';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Configure model groups, routing strategies, and failover chains for this scope.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadGroups()} className="border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5">
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh
          </Button>
          <Button size="sm" onClick={() => { setEditGroup(null); setDialogOpen(true); }} className="bg-indigo-600 hover:bg-indigo-500">
            <Plus className="w-4 h-4 mr-1" /> New Group
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
        </div>
      ) : groups.length === 0 ? (
        <Card className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10">
          <CardContent className="flex flex-col items-center py-12">
            <Cpu className="w-12 h-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">{emptyLabel}</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Create a group to manage AI model routing.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              onSelect={() => {
                const resolved = resolveScope(group);
                const params = new URLSearchParams();
                if (resolved !== 'workspace') {
                  params.set('scope', resolved);
                }
                params.set('origin', detailOrigin || (resolved === 'workspace' ? 'workspace' : resolved));
                router.push(`/models/group/${group.id}/setting?${params.toString()}`);
              }}
              detailOrigin={detailOrigin}
              onEdit={() => handleEdit(group)}
            />
          ))}
        </div>
      )}

      <ModelGroupDialog
        open={dialogOpen}
        onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditGroup(null); }}
        scope={scope === 'all' ? 'workspace' : scope}
        group={editGroup}
        onSaved={handleCreated}
      />
    </div>
  );
}

function GroupCard({
  group,
  detailOrigin,
  onSelect,
  onEdit,
}: {
  group: ModelGroup;
  detailOrigin?: 'workspace' | 'workspace-user' | 'user' | 'platform';
  onSelect: () => void;
  onEdit: () => void;
}) {
  const resolvedScope = resolveScope(group);
  const scopeMeta = scopeVisual(resolvedScope);
  const ScopeIcon = scopeMeta.icon;
  const params = new URLSearchParams();

  if (resolvedScope !== 'workspace') {
    params.set('scope', resolvedScope);
  }
  params.set('origin', detailOrigin || (resolvedScope === 'workspace' ? 'workspace' : resolvedScope));

  return (
    <Card className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10 hover:border-blue-500/25 transition-all cursor-pointer group">
      <CardContent className="flex items-center justify-between p-4">
        <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-4 text-left">
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-gray-200 dark:border-white/10">
            <Cpu className="w-5 h-5 text-blue-400" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{group.name}</span>
              {group.is_default ? (
                <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-xs">
                  <Star className="w-3 h-3 mr-1" /> Default
                </Badge>
              ) : null}
              <Badge className={`${scopeMeta.badgeClassName} text-xs`}>
                <ScopeIcon className="w-3 h-3 mr-1" /> {scopeMeta.label}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-3 mt-1">
              <span className="text-xs text-muted-foreground">{strategyLabel(group.routing_strategy)}</span>
              {group.description ? (
                <span className="text-xs text-muted-foreground/60 truncate max-w-xs">{group.description}</span>
              ) : null}
            </div>
          </div>
        </button>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onEdit}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
          >
            Edit
          </Button>
          <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground/50 hover:text-indigo-600 dark:hover:text-indigo-400">
            <Link href={`/models/group/${group.id}/setting?${params.toString()}`}>
              <ChevronRight className="w-4 h-4" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
