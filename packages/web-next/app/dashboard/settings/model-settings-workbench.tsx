'use client';

import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ChevronDown,
  Cpu,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import { useWorkspace } from '../workspace-provider';
import { useAuthStore } from '@/stores/auth-store';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ModelGroupDialog from './model-group-dialog';

type ModelGroupScope = 'workspace' | 'platform' | 'user';
type GrantScope = 'platform' | 'workspace' | 'user' | 'workspace_user' | 'actor';

type ModelGroupSummary = {
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
};

type ModelGroupGrant = {
  id: string;
  group_id: string;
  grant_scope: GrantScope;
  workspace_id: string | null;
  user_id: string | null;
  actor_id: string | null;
  status: 'active' | 'revoked';
  granted_by?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  revoked_at?: string | null;
};

type ModelItem = {
  id: string;
  group_id: string;
  profile_id: string;
  current_revision_id: string | null;
  display_name: string;
  priority: number;
  weight: number;
  is_enabled: boolean;
  version: number;
  provider_type: string;
  base_url: string;
  model_name: string;
  max_tokens: number;
  capability_tags: string[];
  extra_config?: Record<string, unknown>;
};

type GroupDetail = ModelGroupSummary & {
  grants: ModelGroupGrant[];
  items: ModelItem[];
};

type WorkspaceMember = {
  userId: string;
  userName?: string;
  userEmail?: string;
};

type WorkspaceActor = {
  id: string;
  definition?: {
    name?: string;
  };
  name?: string;
};

type WorkbenchUser = {
  id?: string;
  name?: string;
  email?: string;
};

type ConfigDraft = {
  displayName: string;
  providerType: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  maxTokens: string;
  priority: string;
  weight: string;
  isEnabled: boolean;
  builtinTools: string[];
  multimodalTypes: string[];
};

const ANTHROPIC_BUILTIN_TOOLS = [
  { key: 'web_search', label: 'Web Search' },
  { key: 'web_fetch', label: 'Web Fetch' },
];

const MULTIMODAL_TYPES = [
  { key: 'image', label: 'Images' },
  { key: 'audio', label: 'Audio' },
  { key: 'video', label: 'Video' },
  { key: 'document', label: 'Documents' },
];

const ROUTING_STRATEGIES = [
  { value: 'priority_failover', label: 'Priority Failover' },
  { value: 'weighted_random', label: 'Weighted Random' },
  { value: 'round_robin', label: 'Round Robin' },
] as const;

function resolveScope(group: ModelGroupSummary): ModelGroupScope {
  if (group.owner_type === 'platform' || (!group.owner_type && !group.workspace_id)) {
    return 'platform';
  }
  if (group.owner_type === 'user') {
    return 'user';
  }
  return 'workspace';
}

function createDraft(item?: ModelItem | null): ConfigDraft {
  const extraConfig = (item?.extra_config || {}) as Record<string, any>;
  const multimodal = extraConfig.multimodal || {};

  return {
    displayName: item?.display_name || '',
    providerType: item?.provider_type || 'anthropic',
    apiKey: '',
    baseUrl: item?.base_url || 'https://api.anthropic.com',
    modelName: item?.model_name || 'claude-sonnet-4-20250514',
    maxTokens: String(item?.max_tokens || 4096),
    priority: String(item?.priority ?? 0),
    weight: String(item?.weight ?? 100),
    isEnabled: item ? Boolean(item.is_enabled) : true,
    builtinTools: Array.isArray(extraConfig.builtin_tools) ? extraConfig.builtin_tools : [],
    multimodalTypes: multimodal.supported && Array.isArray(multimodal.types) ? multimodal.types : [],
  };
}

async function fetchGroupsForScope(scope: ModelGroupScope, workspaceId: string | null) {
  if (scope === 'platform') {
    const response = await api.getPlatformModelGroups();
    return (response.groups || []) as ModelGroupSummary[];
  }
  if (scope === 'user') {
    const response = await api.getUserModelGroups();
    return (response.groups || []) as ModelGroupSummary[];
  }
  if (!workspaceId) {
    return [];
  }
  const response = await api.getModelGroups(workspaceId);
  return ((response.groups || []) as ModelGroupSummary[]).filter((group) => resolveScope(group) === 'workspace');
}

async function fetchGroupDetail(scope: ModelGroupScope, groupId: string, workspaceId: string | null) {
  if (scope === 'platform') {
    return api.getPlatformModelGroup(groupId);
  }
  if (scope === 'user') {
    return api.getUserModelGroup(groupId);
  }
  if (!workspaceId) {
    throw new Error('Workspace is required');
  }
  return api.getModelGroup(workspaceId, groupId);
}

async function updateGroupForScope(
  scope: ModelGroupScope,
  groupId: string,
  workspaceId: string | null,
  data: Record<string, unknown>,
) {
  if (scope === 'platform') {
    return api.updatePlatformModelGroup(groupId, data);
  }
  if (scope === 'user') {
    return api.updateUserModelGroup(groupId, data);
  }
  if (!workspaceId) {
    throw new Error('Workspace is required');
  }
  return api.updateModelGroup(workspaceId, groupId, data);
}

async function issueGrantForGroup(scope: ModelGroupScope, groupId: string, workspaceId: string | null, data: Record<string, unknown>) {
  if (scope === 'platform') {
    return api.issuePlatformModelGroupGrant(groupId, data);
  }
  if (scope === 'user') {
    return api.issueUserModelGroupGrant(groupId, data);
  }
  if (!workspaceId) {
    throw new Error('Workspace is required');
  }
  return api.issueModelGroupGrant(workspaceId, groupId, data);
}

async function revokeGrantForGroup(scope: ModelGroupScope, groupId: string, workspaceId: string | null, grantId: string) {
  if (scope === 'platform') {
    return api.revokePlatformModelGroupGrant(groupId, grantId);
  }
  if (scope === 'user') {
    return api.revokeUserModelGroupGrant(groupId, grantId);
  }
  if (!workspaceId) {
    throw new Error('Workspace is required');
  }
  return api.revokeModelGroupGrant(workspaceId, groupId, grantId);
}

async function saveItemForGroup(
  scope: ModelGroupScope,
  groupId: string,
  workspaceId: string | null,
  itemId: string | null,
  payload: Record<string, unknown>,
) {
  if (itemId) {
    if (scope === 'platform') {
      return api.updatePlatformModelItem(groupId, itemId, payload);
    }
    if (scope === 'user') {
      return api.updateUserModelItem(groupId, itemId, payload);
    }
    if (!workspaceId) {
      throw new Error('Workspace is required');
    }
    return api.updateModelItem(workspaceId, groupId, itemId, payload);
  }

  if (scope === 'platform') {
    return api.addPlatformModelItem(groupId, payload);
  }
  if (scope === 'user') {
    return api.addUserModelItem(groupId, payload);
  }
  if (!workspaceId) {
    throw new Error('Workspace is required');
  }
  return api.addModelItem(workspaceId, groupId, payload);
}

async function deleteItemForGroup(scope: ModelGroupScope, groupId: string, workspaceId: string | null, itemId: string) {
  if (scope === 'platform') {
    return api.deletePlatformModelItem(groupId, itemId);
  }
  if (scope === 'user') {
    return api.deleteUserModelItem(groupId, itemId);
  }
  if (!workspaceId) {
    throw new Error('Workspace is required');
  }
  return api.deleteModelItem(workspaceId, groupId, itemId);
}

function grantTargetLabel(
  grant: ModelGroupGrant,
  workspaces: Array<{ id: string; name: string }>,
  members: WorkspaceMember[],
  actors: WorkspaceActor[],
  currentUser: WorkbenchUser | null,
) {
  switch (grant.grant_scope) {
    case 'platform':
      return 'Platform';
    case 'workspace':
      return workspaces.find((workspace) => workspace.id === grant.workspace_id)?.name || 'Workspace';
    case 'user':
    case 'workspace_user': {
      if (grant.user_id && currentUser?.id === grant.user_id) {
        return currentUser.name || currentUser.email || 'Current user';
      }
      const member = members.find((item) => item.userId === grant.user_id);
      return member?.userName || member?.userEmail || grant.user_id || 'User';
    }
    case 'actor': {
      const actor = actors.find((item) => item.id === grant.actor_id);
      return actor?.definition?.name || actor?.name || grant.actor_id || 'Actor';
    }
    default:
      return 'Target';
  }
}

function GrantDialog({
  open,
  onOpenChange,
  onSubmit,
  groupScope,
  workspaces,
  members,
  actors,
  currentUser,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
  groupScope: ModelGroupScope;
  workspaces: Array<{ id: string; name: string }>;
  members: WorkspaceMember[];
  actors: WorkspaceActor[];
  currentUser: WorkbenchUser | null;
}) {
  const [grantScope, setGrantScope] = useState<GrantScope>('workspace');
  const [workspaceId, setWorkspaceId] = useState('');
  const [userId, setUserId] = useState('');
  const [actorId, setActorId] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setGrantScope(groupScope === 'platform' ? 'platform' : 'workspace');
    setWorkspaceId(workspaces[0]?.id || '');
    setUserId(currentUser?.id || members[0]?.userId || '');
    setActorId(actors[0]?.id || '');
    setReason('');
  }, [actors, currentUser?.id, groupScope, members, open, workspaces]);

  const grantScopeOptions: Array<{ value: GrantScope; label: string }> = [
    ...(groupScope === 'platform' ? [{ value: 'platform' as const, label: 'Platform' }] : []),
    { value: 'workspace', label: 'Workspace' },
    { value: 'user', label: 'User' },
    { value: 'workspace_user', label: 'Workspace User' },
    ...(actors.length > 0 ? [{ value: 'actor' as const, label: 'Actor' }] : []),
  ];

  const users = useMemo(() => {
    const options = [...members];
    if (currentUser?.id && !options.some((member) => member.userId === currentUser.id)) {
      options.unshift({
        userId: currentUser.id,
        userName: currentUser.name,
        userEmail: currentUser.email,
      });
    }
    return options;
  }, [currentUser, members]);

  const canSubmit =
    grantScope === 'platform'
      ? true
      : grantScope === 'workspace'
        ? Boolean(workspaceId)
        : grantScope === 'actor'
          ? Boolean(workspaceId && actorId)
          : Boolean(userId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Grant</DialogTitle>
          <DialogDescription>Grant this model group to a workspace, user, or actor target.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="space-y-2">
            <Label>Grant Scope</Label>
            <select
              value={grantScope}
              onChange={(event) => setGrantScope(event.target.value as GrantScope)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
            >
              {grantScopeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {(grantScope === 'workspace' || grantScope === 'workspace_user' || grantScope === 'actor') && (
            <div className="space-y-2">
              <Label>Workspace</Label>
              <select
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {(grantScope === 'user' || grantScope === 'workspace_user') && (
            <div className="space-y-2">
              <Label>User</Label>
              <select
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
              >
                {users.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.userName || member.userEmail || member.userId}
                  </option>
                ))}
              </select>
            </div>
          )}

          {grantScope === 'actor' && (
            <div className="space-y-2">
              <Label>Actor</Label>
              <select
                value={actorId}
                onChange={(event) => setActorId(event.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
              >
                {actors.map((actor) => (
                  <option key={actor.id} value={actor.id}>
                    {actor.definition?.name || actor.name || actor.id}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-2">
            <Label>Reason</Label>
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional rationale for this grant"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canSubmit || saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSubmit({
                  grantScope,
                  workspaceId: grantScope === 'workspace' || grantScope === 'workspace_user' || grantScope === 'actor' ? workspaceId : undefined,
                  userId: grantScope === 'user' || grantScope === 'workspace_user' ? userId : undefined,
                  actorId: grantScope === 'actor' ? actorId : undefined,
                  reason: reason.trim() || undefined,
                });
                onOpenChange(false);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Saving...' : 'Create Grant'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfigEditor({
  draft,
  onChange,
  onSave,
  onDelete,
  onCancel,
  saving,
  isNew,
}: {
  draft: ConfigDraft;
  onChange: (draft: ConfigDraft) => void;
  onSave: () => void;
  onDelete?: () => void;
  onCancel: () => void;
  saving: boolean;
  isNew: boolean;
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <div className="space-y-2">
            <Label>Display Name</Label>
            <Input
              value={draft.displayName}
              onChange={(event) => onChange({ ...draft, displayName: event.target.value })}
              placeholder="e.g. Claude Sonnet"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Provider</Label>
              <select
                value={draft.providerType}
                onChange={(event) => onChange({
                  ...draft,
                  providerType: event.target.value,
                  builtinTools: event.target.value === 'anthropic' ? draft.builtinTools : [],
                })}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>Model Name</Label>
              <Input
                value={draft.modelName}
                onChange={(event) => onChange({ ...draft, modelName: event.target.value })}
                placeholder="claude-sonnet-4-20250514"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>API Key</Label>
            <Input
              type="password"
              value={draft.apiKey}
              onChange={(event) => onChange({ ...draft, apiKey: event.target.value })}
              placeholder={isNew ? 'sk-...' : '(leave blank to keep current)'}
            />
          </div>

          <div className="space-y-2">
            <Label>Base URL</Label>
            <Input
              value={draft.baseUrl}
              onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })}
              placeholder="https://api.anthropic.com"
            />
          </div>

          <div className="grid grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label>Max Tokens</Label>
              <Input
                type="number"
                value={draft.maxTokens}
                onChange={(event) => onChange({ ...draft, maxTokens: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Priority</Label>
              <Input
                type="number"
                value={draft.priority}
                onChange={(event) => onChange({ ...draft, priority: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Weight</Label>
              <Input
                type="number"
                value={draft.weight}
                onChange={(event) => onChange({ ...draft, weight: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <select
                value={draft.isEnabled ? 'enabled' : 'disabled'}
                onChange={(event) => onChange({ ...draft, isEnabled: event.target.value === 'enabled' })}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
              >
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        {draft.providerType === 'anthropic' ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Built-in Tools</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {ANTHROPIC_BUILTIN_TOOLS.map((tool) => {
                const checked = draft.builtinTools.includes(tool.key);
                return (
                  <label key={tool.key} className="flex items-center gap-3 rounded-2xl border border-border p-3">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onChange({
                        ...draft,
                        builtinTools: checked
                          ? draft.builtinTools.filter((value) => value !== tool.key)
                          : [...draft.builtinTools, tool.key],
                      })}
                      className="accent-primary"
                    />
                    <span className="font-medium text-foreground">{tool.label}</span>
                  </label>
                );
              })}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Multimodal</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {MULTIMODAL_TYPES.map((type) => {
              const checked = draft.multimodalTypes.includes(type.key);
              return (
                <label key={type.key} className="flex items-center gap-3 rounded-2xl border border-border p-3">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onChange({
                      ...draft,
                      multimodalTypes: checked
                        ? draft.multimodalTypes.filter((value) => value !== type.key)
                        : [...draft.multimodalTypes, type.key],
                    })}
                    className="accent-primary"
                  />
                  <span className="font-medium text-foreground">{type.label}</span>
                </label>
              );
            })}
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Button onClick={onSave} disabled={saving}>
            <Save data-icon="inline-start" />
            {saving ? 'Saving...' : 'Save'}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {!isNew && onDelete ? (
            <Button variant="outline" onClick={onDelete}>
              <Trash2 data-icon="inline-start" />
              Delete
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function ModelSettingsWorkbench() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { workspaceId } = useWorkspace();
  const { user } = useAuthStore();
  const [groups, setGroups] = useState<ModelGroupSummary[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<GroupDetail | null>(null);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeSection, setActiveSection] = useState<'configs' | 'grants'>('configs');
  const [groupSearch, setGroupSearch] = useState('');
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ModelGroupSummary | null>(null);
  const [grantDialogOpen, setGrantDialogOpen] = useState(false);
  const [expandedItemId, setExpandedItemId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<ConfigDraft>(createDraft());
  const [savingConfig, setSavingConfig] = useState(false);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [workspaceActors, setWorkspaceActors] = useState<WorkspaceActor[]>([]);
  const [availableWorkspaces, setAvailableWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [creatableScopes, setCreatableScopes] = useState<ModelGroupScope[]>(['user']);
  const [editingField, setEditingField] = useState<'name' | 'description' | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState('');
  const [groupDescriptionDraft, setGroupDescriptionDraft] = useState('');
  const [savingGroupField, setSavingGroupField] = useState<'name' | 'description' | null>(null);
  const [savingGroupSettings, setSavingGroupSettings] = useState<'routing' | 'default' | null>(null);
  const deferredGroupSearch = useDeferredValue(groupSearch);

  async function loadGroups() {
    setGroupsLoading(true);
    try {
      const [workspaceResult, userResult, platformResult, workspacesResult] = await Promise.allSettled([
        fetchGroupsForScope('workspace', workspaceId),
        fetchGroupsForScope('user', workspaceId),
        fetchGroupsForScope('platform', workspaceId),
        api.getWorkspaces(),
      ]);

      const nextGroups = [
        ...(workspaceResult.status === 'fulfilled' ? workspaceResult.value : []),
        ...(userResult.status === 'fulfilled' ? userResult.value : []),
        ...(platformResult.status === 'fulfilled' ? platformResult.value : []),
      ].sort((left, right) => {
        const rank = (group: ModelGroupSummary) => {
          const scope = resolveScope(group);
          return scope === 'workspace' ? 0 : scope === 'user' ? 1 : 2;
        };
        return rank(left) - rank(right) || Number(right.is_default) - Number(left.is_default) || left.name.localeCompare(right.name);
      });

      setGroups(nextGroups);
      setCreatableScopes([
        ...(workspaceResult.status === 'fulfilled' ? (['workspace'] as ModelGroupScope[]) : []),
        'user',
        ...(platformResult.status === 'fulfilled' ? (['platform'] as ModelGroupScope[]) : []),
      ]);

      if (workspacesResult.status === 'fulfilled') {
        const workspaceList = (workspacesResult.value?.data ?? workspacesResult.value ?? []) as Array<{ id: string; name: string }>;
        setAvailableWorkspaces(workspaceList.map((workspace) => ({ id: workspace.id, name: workspace.name })));
      }

      setSelectedGroupId((current) => {
        const requestedGroupId = searchParams.get('groupId');
        if (requestedGroupId && nextGroups.some((group) => group.id === requestedGroupId)) {
          return requestedGroupId;
        }
        if (current && nextGroups.some((group) => group.id === current)) {
          return current;
        }
        return nextGroups[0]?.id || null;
      });
    } catch (error) {
      console.error('Failed to load editable model groups:', error);
      setGroups([]);
      setSelectedGroupId(null);
    } finally {
      setGroupsLoading(false);
    }
  }

  async function loadSelectedGroup(groupId: string) {
    const summary = groups.find((group) => group.id === groupId);
    if (!summary) {
      return;
    }

    setDetailLoading(true);
    try {
      const response = await fetchGroupDetail(resolveScope(summary), groupId, workspaceId);
      setSelectedGroup(response.group as GroupDetail);
      setExpandedItemId(null);
      setDraft(createDraft());
    } catch (error) {
      console.error('Failed to load model group detail:', error);
      setSelectedGroup(null);
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    void loadGroups();
  }, [workspaceId]);

  useEffect(() => {
    if (!selectedGroupId) {
      setSelectedGroup(null);
      return;
    }
    void loadSelectedGroup(selectedGroupId);
  }, [selectedGroupId, groups]);

  useEffect(() => {
    if (!selectedGroupId) return;
    if (searchParams.get('groupId') === selectedGroupId) return;

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set('groupId', selectedGroupId);
    router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false });
  }, [pathname, router, searchParams, selectedGroupId]);

  useEffect(() => {
    if (!workspaceId) {
      setWorkspaceMembers([]);
      setWorkspaceActors([]);
      return;
    }

    Promise.allSettled([api.getWorkspaceMembers(workspaceId), api.getActors(workspaceId)]).then(([membersResult, actorsResult]) => {
      if (membersResult.status === 'fulfilled') {
        const members = membersResult.value?.data ?? membersResult.value ?? [];
        setWorkspaceMembers(members as WorkspaceMember[]);
      } else {
        setWorkspaceMembers([]);
      }

      if (actorsResult.status === 'fulfilled') {
        const actors = actorsResult.value?.data ?? actorsResult.value?.actors ?? actorsResult.value ?? [];
        setWorkspaceActors(actors as WorkspaceActor[]);
      } else {
        setWorkspaceActors([]);
      }
    });
  }, [workspaceId]);

  useEffect(() => {
    setGroupNameDraft(selectedGroup?.name || '');
    setGroupDescriptionDraft(selectedGroup?.description || '');
    setEditingField(null);
  }, [selectedGroup?.description, selectedGroup?.id, selectedGroup?.name]);

  const filteredGroups = useMemo(() => {
    const needle = deferredGroupSearch.trim().toLowerCase();
    if (!needle) return groups;
    return groups.filter((group) => {
      const haystack = `${group.name} ${group.description} ${group.routing_strategy}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [deferredGroupSearch, groups]);

  const currentUser = (user || null) as WorkbenchUser | null;

  async function reloadCurrentGroup() {
    if (selectedGroupId) {
      await loadSelectedGroup(selectedGroupId);
    }
  }

  async function handleIssueGrant(payload: Record<string, unknown>) {
    if (!selectedGroup) return;
    const scope = resolveScope(selectedGroup);
    await issueGrantForGroup(scope, selectedGroup.id, workspaceId, payload);
    await reloadCurrentGroup();
  }

  async function handleRevokeGrant(grantId: string) {
    if (!selectedGroup) return;
    const scope = resolveScope(selectedGroup);
    await revokeGrantForGroup(scope, selectedGroup.id, workspaceId, grantId);
    await reloadCurrentGroup();
  }

  async function handleSaveConfig(itemId: string | null) {
    if (!selectedGroup) return;
    if (!draft.displayName.trim()) return;
    if (!itemId && (!draft.apiKey.trim() || !draft.baseUrl.trim() || !draft.modelName.trim())) return;

    setSavingConfig(true);
    try {
      const extraConfig: Record<string, unknown> = {};
      if (draft.providerType === 'anthropic' && draft.builtinTools.length > 0) {
        extraConfig.builtin_tools = draft.builtinTools;
      }
      if (draft.multimodalTypes.length > 0) {
        extraConfig.multimodal = { supported: true, types: draft.multimodalTypes };
      }

      const payload: Record<string, unknown> = {
        displayName: draft.displayName.trim(),
        priority: parseInt(draft.priority, 10),
        weight: parseInt(draft.weight, 10),
        providerType: draft.providerType,
        maxTokens: parseInt(draft.maxTokens, 10),
        extraConfig,
      };

      if (draft.baseUrl.trim()) payload.baseUrl = draft.baseUrl.trim();
      if (draft.modelName.trim()) payload.modelName = draft.modelName.trim();
      if (draft.apiKey.trim()) payload.apiKey = draft.apiKey.trim();
      if (itemId) payload.isEnabled = draft.isEnabled;

      const response = await saveItemForGroup(resolveScope(selectedGroup), selectedGroup.id, workspaceId, itemId, payload);
      await reloadCurrentGroup();
      setExpandedItemId(itemId || response?.item?.id || null);
    } catch (error) {
      console.error('Failed to save model config:', error);
    } finally {
      setSavingConfig(false);
    }
  }

  async function handleDeleteConfig(itemId: string) {
    if (!selectedGroup) return;
    try {
      await deleteItemForGroup(resolveScope(selectedGroup), selectedGroup.id, workspaceId, itemId);
      await reloadCurrentGroup();
      setExpandedItemId(null);
      setDraft(createDraft());
    } catch (error) {
      console.error('Failed to delete model config:', error);
    }
  }

  async function handleUpdateGroupSettings(
    patch: Record<string, unknown>,
    savingKey: 'routing' | 'default',
  ) {
    if (!selectedGroup) return;

    setSavingGroupSettings(savingKey);
    try {
      await updateGroupForScope(resolveScope(selectedGroup), selectedGroup.id, workspaceId, patch);
      await loadGroups();
      await reloadCurrentGroup();
    } catch (error) {
      console.error('Failed to update model group settings:', error);
    } finally {
      setSavingGroupSettings(null);
    }
  }

  async function handleSaveGroupField(field: 'name' | 'description') {
    if (!selectedGroup) return;

    const nextValue = field === 'name' ? groupNameDraft.trim() : groupDescriptionDraft.trim();
    const currentValue = field === 'name' ? selectedGroup.name : selectedGroup.description || '';

    if (field === 'name' && !nextValue) {
      setGroupNameDraft(selectedGroup.name);
      setEditingField(null);
      return;
    }

    if (nextValue === currentValue) {
      setEditingField(null);
      return;
    }

    setSavingGroupField(field);
    try {
      await updateGroupForScope(resolveScope(selectedGroup), selectedGroup.id, workspaceId, {
        [field]: nextValue,
      });
      setGroups((current) =>
        current.map((group) => (group.id === selectedGroup.id ? { ...group, [field]: nextValue } : group)),
      );
      setSelectedGroup((current) => (current ? { ...current, [field]: nextValue } : current));
      setEditingField(null);
    } catch (error) {
      console.error(`Failed to update model group ${field}:`, error);
      setGroupNameDraft(selectedGroup.name);
      setGroupDescriptionDraft(selectedGroup.description || '');
    } finally {
      setSavingGroupField(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="flex w-[340px] shrink-0 min-h-0 flex-col border-r border-border bg-muted/20">
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={groupSearch}
                onChange={(event) => setGroupSearch(event.target.value)}
                placeholder="Search groups..."
                className="pl-9"
              />
            </div>
            <Button
              size="icon"
              aria-label="Create model group"
              onClick={() => {
                setEditingGroup(null);
                setGroupDialogOpen(true);
              }}
            >
              <Plus />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {groupsLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-24 rounded-2xl" />
              <Skeleton className="h-24 rounded-2xl" />
              <Skeleton className="h-24 rounded-2xl" />
            </div>
          ) : filteredGroups.length > 0 ? (
            <div className="flex flex-col gap-2">
              {filteredGroups.map((group) => {
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => setSelectedGroupId(group.id)}
                    className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
                      selectedGroupId === group.id ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent/60'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{group.name}</div>
                      {group.description ? <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">{group.description}</div> : null}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <Cpu className="size-10 text-muted-foreground/60" />
                <div>
                  <div className="font-medium text-foreground">No editable groups</div>
                  <div className="text-sm text-muted-foreground">Create a group or switch workspace.</div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col">
          <div className="border-b border-border px-6 py-5">
            {selectedGroup ? (
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {editingField === 'name' ? (
                      <Input
                        autoFocus
                        value={groupNameDraft}
                        disabled={savingGroupField === 'name'}
                        onChange={(event) => setGroupNameDraft(event.target.value)}
                        onBlur={() => void handleSaveGroupField('name')}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                          if (event.key === 'Escape') {
                            setGroupNameDraft(selectedGroup.name);
                            setEditingField(null);
                          }
                        }}
                        className="h-10 max-w-md text-base font-semibold"
                      />
                    ) : (
                      <>
                        <h1 className="text-xl font-semibold text-foreground">{selectedGroup.name}</h1>
                        <Button variant="ghost" size="icon-sm" onClick={() => setEditingField('name')}>
                          <Pencil className="size-4" />
                        </Button>
                      </>
                    )}
                  </div>

                  <div className="flex max-w-2xl items-center gap-2 text-sm text-muted-foreground">
                    {editingField === 'description' ? (
                      <Input
                        autoFocus
                        value={groupDescriptionDraft}
                        disabled={savingGroupField === 'description'}
                        onChange={(event) => setGroupDescriptionDraft(event.target.value)}
                        onBlur={() => void handleSaveGroupField('description')}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                          if (event.key === 'Escape') {
                            setGroupDescriptionDraft(selectedGroup.description || '');
                            setEditingField(null);
                          }
                        }}
                        placeholder="Add a description"
                        className="h-9 max-w-xl"
                      />
                    ) : (
                      <>
                        <p>{selectedGroup.description || 'Add a description for this model group.'}</p>
                        <Button variant="ghost" size="icon-sm" onClick={() => setEditingField('description')}>
                          <Pencil className="size-4" />
                        </Button>
                      </>
                    )}
                  </div>

                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" onClick={() => void reloadCurrentGroup()}>
                    <RefreshCw data-icon="inline-start" />
                    Refresh
                  </Button>
                  <Select
                    value={selectedGroup.routing_strategy}
                    onValueChange={(value) => {
                      if (value === selectedGroup.routing_strategy) return;
                      void handleUpdateGroupSettings({ routingStrategy: value }, 'routing');
                    }}
                    disabled={savingGroupSettings !== null}
                  >
                    <SelectTrigger className="w-[220px]">
                      <SelectValue placeholder="Routing Strategy" />
                    </SelectTrigger>
                    <SelectContent>
                      {ROUTING_STRATEGIES.map((strategy) => (
                        <SelectItem key={strategy.value} value={strategy.value}>
                          {strategy.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedGroup.is_default ? (
                    <Button variant="outline" disabled>
                      Default
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={savingGroupSettings !== null}
                      onClick={() => void handleUpdateGroupSettings({ isDefault: true }, 'default')}
                    >
                      Set As Default
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div>
                <h1 className="text-xl font-semibold text-foreground">Model Groups</h1>
                <p className="mt-2 text-sm text-muted-foreground">Select a group from the left to manage grants and configs.</p>
              </div>
            )}
          </div>

          <div className="flex-1 p-6">
            {detailLoading ? (
              <div className="flex flex-col gap-4">
                <Skeleton className="h-12 rounded-2xl" />
                <Skeleton className="h-40 rounded-2xl" />
                <Skeleton className="h-56 rounded-2xl" />
              </div>
            ) : selectedGroup ? (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3">
                  <Tabs value={activeSection} onValueChange={(value) => setActiveSection(value as 'configs' | 'grants')}>
                    <TabsList>
                      <TabsTrigger value="configs">
                        <Cpu />
                        Configs
                      </TabsTrigger>
                      <TabsTrigger value="grants">
                        <ShieldCheck />
                        Grants
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>

                  {activeSection === 'configs' ? (
                    <Button
                      onClick={() => {
                        setExpandedItemId('new');
                        setDraft(createDraft());
                      }}
                    >
                      <Plus data-icon="inline-start" />
                      New Config
                    </Button>
                  ) : (
                    <Button onClick={() => setGrantDialogOpen(true)}>
                      <ShieldCheck data-icon="inline-start" />
                      New Grant
                    </Button>
                  )}
                </div>

                {activeSection === 'configs' ? (
                  <>
                  {expandedItemId === 'new' ? (
                    <ConfigEditor
                      draft={draft}
                      onChange={setDraft}
                      onSave={() => void handleSaveConfig(null)}
                      onCancel={() => {
                        setExpandedItemId(null);
                        setDraft(createDraft());
                      }}
                      saving={savingConfig}
                      isNew
                    />
                  ) : null}

                  <div className="flex flex-col gap-3">
                    {selectedGroup.items.map((item) => {
                      const expanded = expandedItemId === item.id;
                      return (
                        <div key={item.id} className="rounded-2xl border border-border">
                          <button
                            type="button"
                            onClick={() => {
                              if (expanded) {
                                setExpandedItemId(null);
                                setDraft(createDraft());
                              } else {
                                setExpandedItemId(item.id);
                                setDraft(createDraft(item));
                              }
                            }}
                            className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left"
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              <div className={`flex size-10 shrink-0 items-center justify-center rounded-2xl ${
                                item.is_enabled ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground'
                              }`}>
                                <Cpu className="size-4" />
                              </div>
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="truncate font-medium text-foreground">{item.display_name}</span>
                                  <Badge variant="secondary">v{item.version || 1}</Badge>
                                  {item.provider_type ? <Badge variant="outline">{item.provider_type}</Badge> : null}
                                  {!item.is_enabled ? <Badge variant="outline">Disabled</Badge> : null}
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                                  <span>{item.model_name || 'No model configured'}</span>
                                  <span>Priority {item.priority}</span>
                                  <span>Weight {item.weight}</span>
                                </div>
                              </div>
                            </div>
                            <ChevronDown className={`size-4 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
                          </button>

                          {expanded ? (
                            <div className="border-t border-border px-4 py-4">
                              <ConfigEditor
                                draft={draft}
                                onChange={setDraft}
                                onSave={() => void handleSaveConfig(item.id)}
                                onDelete={() => void handleDeleteConfig(item.id)}
                                onCancel={() => {
                                  setExpandedItemId(null);
                                  setDraft(createDraft());
                                }}
                                saving={savingConfig}
                                isNew={false}
                              />
                            </div>
                          ) : null}
                        </div>
                      );
                    })}

                    {selectedGroup.items.length === 0 && expandedItemId !== 'new' ? (
                      <Card>
                        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                          <Cpu className="size-10 text-muted-foreground/60" />
                          <div>
                            <div className="font-medium text-foreground">No configs yet</div>
                            <div className="text-sm text-muted-foreground">Create the first config for this group.</div>
                          </div>
                        </CardContent>
                      </Card>
                    ) : null}
                  </div>
                  </>
                ) : (
                  <div className="flex flex-col gap-3">
                    {selectedGroup.grants
                      .filter((grant) => grant.status === 'active')
                      .map((grant) => (
                        <div key={grant.id} className="rounded-2xl border border-border px-4 py-4">
                          <div className="flex flex-wrap items-start justify-between gap-4">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium text-foreground">
                                  {grantTargetLabel(grant, availableWorkspaces, workspaceMembers, workspaceActors, currentUser)}
                                </span>
                                <Badge variant="outline">{grant.grant_scope.replaceAll('_', ' ')}</Badge>
                              </div>
                              <div className="mt-1 text-sm text-muted-foreground">
                                {grant.reason || 'No explicit reason recorded.'}
                              </div>
                            </div>
                            <Button variant="outline" onClick={() => void handleRevokeGrant(grant.id)}>
                              Revoke
                            </Button>
                          </div>
                        </div>
                      ))}

                    {selectedGroup.grants.filter((grant) => grant.status === 'active').length === 0 ? (
                      <Card>
                        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                          <ShieldCheck className="size-10 text-muted-foreground/60" />
                          <div>
                            <div className="font-medium text-foreground">No explicit grants</div>
                            <div className="text-sm text-muted-foreground">Add a grant to share this group with a workspace, user, or actor.</div>
                          </div>
                        </CardContent>
                      </Card>
                    ) : null}
                  </div>
                )}
              </div>
            ) : (
              <Card className="max-w-xl">
                <CardHeader>
                  <CardTitle>Select a model group</CardTitle>
                  <CardDescription>Choose a group from the left to manage its grants and configs.</CardDescription>
                </CardHeader>
              </Card>
            )}
          </div>
        </div>
      </div>

      <ModelGroupDialog
        open={groupDialogOpen}
        onOpenChange={(open) => {
          setGroupDialogOpen(open);
          if (!open) setEditingGroup(null);
        }}
        scope={editingGroup ? resolveScope(editingGroup) : 'workspace'}
        availableScopes={creatableScopes}
        group={editingGroup}
        onSaved={() => {
          setGroupDialogOpen(false);
          setEditingGroup(null);
          void loadGroups();
        }}
      />

      <GrantDialog
        open={grantDialogOpen}
        onOpenChange={setGrantDialogOpen}
        groupScope={selectedGroup ? resolveScope(selectedGroup) : 'workspace'}
        workspaces={availableWorkspaces}
        members={workspaceMembers}
        actors={workspaceActors}
        currentUser={currentUser}
        onSubmit={handleIssueGrant}
      />
    </div>
  );
}
