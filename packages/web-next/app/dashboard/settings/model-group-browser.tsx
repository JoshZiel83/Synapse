'use client';

import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  Cpu,
  Globe2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Star,
  Trash2,
  UserRound,
} from 'lucide-react';

import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import ModelGroupDialog from './model-group-dialog';

type ModelGroupScope = 'workspace' | 'platform' | 'user';

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

type ModelItem = {
  id: string;
  group_id: string;
  profile_id: string;
  display_name: string;
  priority: number;
  weight: number;
  is_enabled: boolean;
  current_revision_id: string | null;
  version: number;
  provider_type: string;
  engine_kind?: string;
  base_url: string;
  model_name: string;
  max_tokens: number;
  capability_tags: string[];
  extra_config?: Record<string, unknown>;
};

type GroupDetail = ModelGroupSummary & {
  items: ModelItem[];
};

type ModelItemFormState = {
  displayName: string;
  providerType: string;
  engineKind: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  maxTokens: string;
  priority: string;
  weight: string;
  builtinTools: string[];
  multimodalTypes: string[];
  isEnabled: boolean;
};

const ANTHROPIC_BUILTIN_TOOLS = [
  {
    key: 'web_search',
    label: 'Web Search',
    description: 'Allow the model to search the web for real-time information',
  },
  {
    key: 'web_fetch',
    label: 'Web Fetch',
    description: 'Allow the model to fetch and read full web page content',
  },
];

const MULTIMODAL_TYPES = [
  { key: 'image', label: 'Images' },
  { key: 'audio', label: 'Audio' },
  { key: 'video', label: 'Video' },
  { key: 'document', label: 'Documents' },
];

const ENGINE_KIND_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  anthropic: [
    { value: 'anthropic.messages', label: 'Messages API' },
  ],
  openai: [
    { value: 'openai.chat_completions', label: 'Chat Completions' },
    { value: 'openai.responses', label: 'Responses API' },
  ],
};

function defaultEngineKind(providerType: string) {
  return providerType === 'openai' ? 'openai.chat_completions' : 'anthropic.messages';
}

function defaultBaseUrl(providerType: string) {
  return providerType === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com';
}

function defaultModelName(providerType: string, engineKind?: string) {
  if (providerType !== 'openai') return 'claude-sonnet-4-20250514';
  return engineKind === 'openai.responses' ? 'gpt-5' : 'gpt-4.1';
}

function resolveScope(group: ModelGroupSummary): ModelGroupScope {
  if (group.owner_type === 'platform' || (!group.owner_type && !group.workspace_id)) {
    return 'platform';
  }
  if (group.owner_type === 'user') {
    return 'user';
  }
  return 'workspace';
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

function scopeVisual(scope: ModelGroupScope) {
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

function createFormState(item?: ModelItem | null): ModelItemFormState {
  const extraConfig = (item?.extra_config || {}) as Record<string, any>;
  const multimodal = extraConfig.multimodal || {};
  const providerType = item?.provider_type || 'anthropic';
  const engineKind = item?.engine_kind || extraConfig.engine_kind || defaultEngineKind(providerType);

  return {
    displayName: item?.display_name || '',
    providerType,
    engineKind,
    apiKey: '',
    baseUrl: item?.base_url || defaultBaseUrl(providerType),
    modelName: item?.model_name || defaultModelName(providerType, engineKind),
    maxTokens: String(item?.max_tokens || 4096),
    priority: String(item?.priority ?? 0),
    weight: String(item?.weight ?? 100),
    builtinTools: Array.isArray(extraConfig.builtin_tools) ? extraConfig.builtin_tools : [],
    multimodalTypes: multimodal.supported && Array.isArray(multimodal.types) ? multimodal.types : [],
    isEnabled: item ? Boolean(item.is_enabled) : true,
  };
}

async function fetchGroupDetail(
  scope: ModelGroupScope,
  groupId: string,
  workspaceId: string | null,
) {
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

function GroupListItem({
  group,
  selected,
  onSelect,
}: {
  group: ModelGroupSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const resolvedScope = resolveScope(group);
  const scopeMeta = scopeVisual(resolvedScope);
  const ScopeIcon = scopeMeta.icon;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
        selected ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent/60'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Cpu className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-sm font-medium text-foreground">{group.name}</div>
            {group.is_default ? (
              <Badge variant="outline">
                <Star className="mr-1 size-3" />
                Default
              </Badge>
            ) : null}
            <Badge className={scopeMeta.badgeClassName}>
              <ScopeIcon className="mr-1 size-3" />
              {scopeMeta.label}
            </Badge>
          </div>
          <div className="mt-1 text-sm text-muted-foreground">{strategyLabel(group.routing_strategy)}</div>
          {group.description ? (
            <div className="mt-1 truncate text-sm text-muted-foreground">{group.description}</div>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function ConfigListItem({
  item,
  selected,
  onSelect,
}: {
  item: ModelItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
        selected ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent/60'
      } ${item.is_enabled ? '' : 'opacity-60'}`}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-2xl ${
          item.is_enabled ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground'
        }`}>
          <Cpu className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-sm font-medium text-foreground">{item.display_name}</div>
            <Badge variant="secondary">v{item.version || 1}</Badge>
            {item.provider_type ? <Badge variant="outline">{item.provider_type}</Badge> : null}
            {item.engine_kind ? <Badge variant="outline">{item.engine_kind}</Badge> : null}
            {!item.is_enabled ? <Badge variant="outline">Disabled</Badge> : null}
          </div>
          <div className="mt-1 truncate text-sm text-muted-foreground">{item.model_name || 'No model configured'}</div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>Priority {item.priority}</span>
            <span>Weight {item.weight}</span>
            {item.max_tokens ? <span>{item.max_tokens} tokens</span> : null}
          </div>
        </div>
      </div>
    </button>
  );
}

export default function ModelGroupBrowser({
  scope,
}: {
  scope: ModelGroupScope;
}) {
  const { workspaceId } = useWorkspace();
  const [groups, setGroups] = useState<ModelGroupSummary[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<GroupDetail | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ModelGroupSummary | null>(null);
  const [itemDraft, setItemDraft] = useState<ModelItemFormState>(createFormState());
  const [savingItem, setSavingItem] = useState(false);
  const [groupSearch, setGroupSearch] = useState('');
  const deferredGroupSearch = useDeferredValue(groupSearch);

  const currentItem = useMemo(
    () => selectedGroup?.items.find((item) => item.id === selectedItemId) || null,
    [selectedGroup, selectedItemId],
  );

  async function loadGroups() {
    if (scope === 'workspace' && !workspaceId) {
      return;
    }

    setGroupsLoading(true);
    try {
      let nextGroups: ModelGroupSummary[] = [];

      if (scope === 'platform') {
        const response = await api.getPlatformModelGroups();
        nextGroups = response.groups || [];
      } else if (scope === 'user') {
        const response = await api.getUserModelGroups();
        nextGroups = response.groups || [];
      } else {
        const response = await api.getModelGroups(workspaceId!);
        nextGroups = (response.groups || []).filter((group: ModelGroupSummary) => resolveScope(group) === 'workspace');
      }

      setGroups(nextGroups);
      setSelectedGroupId((current) => (
        current && nextGroups.some((group) => group.id === current) ? current : nextGroups[0]?.id || null
      ));
    } catch (error) {
      console.error('Failed to load model groups:', error);
      setGroups([]);
      setSelectedGroupId(null);
    } finally {
      setGroupsLoading(false);
    }
  }

  async function loadSelectedGroup(groupId: string, preferredItemId?: string | null) {
    setDetailLoading(true);
    try {
      const response = await fetchGroupDetail(scope, groupId, workspaceId);
      const nextGroup = response.group as GroupDetail;
      setSelectedGroup(nextGroup);
      setSelectedItemId((current) => {
        const nextSelectedId =
          preferredItemId && nextGroup.items.some((item) => item.id === preferredItemId)
            ? preferredItemId
            : current && nextGroup.items.some((item) => item.id === current)
              ? current
              : nextGroup.items[0]?.id || null;
        return nextSelectedId;
      });
    } catch (error) {
      console.error('Failed to load model group detail:', error);
      setSelectedGroup(null);
      setSelectedItemId(null);
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    void loadGroups();
  }, [scope, workspaceId]);

  useEffect(() => {
    if (!selectedGroupId) {
      setSelectedGroup(null);
      setSelectedItemId(null);
      return;
    }
    void loadSelectedGroup(selectedGroupId);
  }, [selectedGroupId]);

  useEffect(() => {
    setItemDraft(createFormState(currentItem));
  }, [currentItem]);

  const filteredGroups = useMemo(() => {
    const needle = deferredGroupSearch.trim().toLowerCase();
    if (!needle) return groups;
    return groups.filter((group) => {
      const haystack = `${group.name} ${group.description} ${group.routing_strategy}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [deferredGroupSearch, groups]);

  const emptyLabel =
    scope === 'platform'
      ? 'No platform model groups configured'
      : scope === 'user'
        ? 'No personal model groups configured'
        : 'No workspace model groups configured';

  const editorTitle = currentItem ? currentItem.display_name : selectedGroup ? 'New Model Config' : 'Select a model group';

  function handleNewItem() {
    setSelectedItemId(null);
    setItemDraft(createFormState());
  }

  async function handleDeleteItem() {
    if (!selectedGroup || !currentItem) return;

    try {
      if (scope === 'platform') {
        await api.deletePlatformModelItem(selectedGroup.id, currentItem.id);
      } else if (scope === 'user') {
        await api.deleteUserModelItem(selectedGroup.id, currentItem.id);
      } else if (workspaceId) {
        await api.deleteModelItem(workspaceId, selectedGroup.id, currentItem.id);
      }

      await loadSelectedGroup(selectedGroup.id);
    } catch (error) {
      console.error('Failed to delete model config:', error);
    }
  }

  async function handleSaveItem() {
    if (!selectedGroup) return;
    if (!itemDraft.displayName.trim()) return;
    if (!currentItem && (!itemDraft.apiKey.trim() || !itemDraft.baseUrl.trim() || !itemDraft.modelName.trim())) return;

    setSavingItem(true);
    try {
      const extraConfig: Record<string, unknown> = {};
      if (itemDraft.providerType === 'anthropic' && itemDraft.builtinTools.length > 0) {
        extraConfig.builtin_tools = itemDraft.builtinTools;
      }
      if (itemDraft.multimodalTypes.length > 0) {
        extraConfig.multimodal = { supported: true, types: itemDraft.multimodalTypes };
      }

      if (currentItem) {
        const payload: Record<string, unknown> = {
          displayName: itemDraft.displayName.trim(),
          priority: parseInt(itemDraft.priority, 10),
          weight: parseInt(itemDraft.weight, 10),
          extraConfig,
          isEnabled: itemDraft.isEnabled,
          maxTokens: parseInt(itemDraft.maxTokens, 10),
          providerType: itemDraft.providerType,
          engineKind: itemDraft.engineKind,
        };
        if (itemDraft.modelName.trim()) payload.modelName = itemDraft.modelName.trim();
        if (itemDraft.baseUrl.trim()) payload.baseUrl = itemDraft.baseUrl.trim();
        if (itemDraft.apiKey.trim()) payload.apiKey = itemDraft.apiKey.trim();

        if (scope === 'platform') {
          await api.updatePlatformModelItem(selectedGroup.id, currentItem.id, payload);
        } else if (scope === 'user') {
          await api.updateUserModelItem(selectedGroup.id, currentItem.id, payload);
        } else if (workspaceId) {
          await api.updateModelItem(workspaceId, selectedGroup.id, currentItem.id, payload);
        }

        await loadSelectedGroup(selectedGroup.id, currentItem.id);
      } else {
        const payload = {
          displayName: itemDraft.displayName.trim(),
          priority: parseInt(itemDraft.priority, 10),
          weight: parseInt(itemDraft.weight, 10),
          providerType: itemDraft.providerType,
          engineKind: itemDraft.engineKind,
          apiKey: itemDraft.apiKey.trim(),
          baseUrl: itemDraft.baseUrl.trim(),
          modelName: itemDraft.modelName.trim(),
          maxTokens: parseInt(itemDraft.maxTokens, 10),
          extraConfig,
        };

        let response;
        if (scope === 'platform') {
          response = await api.addPlatformModelItem(selectedGroup.id, payload);
        } else if (scope === 'user') {
          response = await api.addUserModelItem(selectedGroup.id, payload);
        } else {
          response = await api.addModelItem(workspaceId!, selectedGroup.id, payload);
        }

        await loadSelectedGroup(selectedGroup.id, response?.item?.id || null);
      }
    } catch (error) {
      console.error('Failed to save model config:', error);
    } finally {
      setSavingItem(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="flex w-[320px] shrink-0 min-h-0 flex-col border-r border-border bg-muted/20">
        <div className="border-b border-border px-4 py-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-foreground">Model Groups</div>
              <div className="text-sm text-muted-foreground">Select a group to inspect its configs.</div>
            </div>
            <Button size="sm" onClick={() => { setEditingGroup(null); setGroupDialogOpen(true); }}>
              <Plus data-icon="inline-start" />
              New
            </Button>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={groupSearch}
              onChange={(event) => setGroupSearch(event.target.value)}
              placeholder="Search groups..."
              className="pl-9"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {groupsLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
            </div>
          ) : filteredGroups.length > 0 ? (
            <div className="flex flex-col gap-2">
              {filteredGroups.map((group) => (
                <GroupListItem
                  key={group.id}
                  group={group}
                  selected={group.id === selectedGroupId}
                  onSelect={() => setSelectedGroupId(group.id)}
                />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <Cpu className="size-10 text-muted-foreground/60" />
                <div>
                  <div className="font-medium text-foreground">{emptyLabel}</div>
                  <div className="text-sm text-muted-foreground">Create a model group to start managing routing.</div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <div className="flex w-[360px] shrink-0 min-h-0 flex-col border-r border-border bg-background">
        <div className="border-b border-border px-4 py-4">
          {selectedGroup ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{selectedGroup.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{strategyLabel(selectedGroup.routing_strategy)}</Badge>
                    {selectedGroup.is_default ? <Badge variant="outline">Default</Badge> : null}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => void loadSelectedGroup(selectedGroup.id, selectedItemId)}>
                    <RefreshCw data-icon="inline-start" />
                    Refresh
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingGroup(selectedGroup);
                      setGroupDialogOpen(true);
                    }}
                  >
                    Edit
                  </Button>
                </div>
              </div>
              {selectedGroup.description ? (
                <div className="text-sm text-muted-foreground">{selectedGroup.description}</div>
              ) : null}
              <Button size="sm" onClick={handleNewItem}>
                <Plus data-icon="inline-start" />
                New Config
              </Button>
            </div>
          ) : (
            <div>
              <div className="text-sm font-medium text-foreground">Configs</div>
              <div className="text-sm text-muted-foreground">Select a model group first.</div>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {detailLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
            </div>
          ) : !selectedGroup ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <Cpu className="size-10 text-muted-foreground/60" />
                <div>
                  <div className="font-medium text-foreground">No group selected</div>
                  <div className="text-sm text-muted-foreground">Pick a model group to browse its configs.</div>
                </div>
              </CardContent>
            </Card>
          ) : selectedGroup.items.length > 0 ? (
            <div className="flex flex-col gap-2">
              {selectedGroup.items.map((item) => (
                <ConfigListItem
                  key={item.id}
                  item={item}
                  selected={item.id === selectedItemId}
                  onSelect={() => setSelectedItemId(item.id)}
                />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <Cpu className="size-10 text-muted-foreground/60" />
                <div>
                  <div className="font-medium text-foreground">No configs yet</div>
                  <div className="text-sm text-muted-foreground">Create the first model config for this group.</div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col">
          <div className="border-b border-border px-6 py-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-foreground">{editorTitle}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedGroup
                    ? currentItem
                      ? 'Edit the selected config. Saving creates a new config revision.'
                      : 'Configure a new model for the selected group.'
                    : 'Select a group and a config from the left to start editing.'}
                </p>
              </div>
              {selectedGroup ? (
                <div className="flex items-center gap-2">
                  {currentItem ? (
                    <Button variant="outline" onClick={() => void handleDeleteItem()}>
                      <Trash2 data-icon="inline-start" />
                      Delete
                    </Button>
                  ) : null}
                  <Button onClick={() => void handleSaveItem()} disabled={savingItem || !selectedGroup}>
                    <Save data-icon="inline-start" />
                    {savingItem ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex-1 p-6">
            {selectedGroup ? (
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                <Card>
                  <CardHeader>
                    <CardTitle>Config</CardTitle>
                    <CardDescription>Provider, endpoint, model name, limits, and runtime toggles.</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <div className="space-y-2">
                      <Label>Display Name</Label>
                      <Input
                        value={itemDraft.displayName}
                        onChange={(event) => setItemDraft((current) => ({ ...current, displayName: event.target.value }))}
                        placeholder="e.g. Claude Sonnet"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Provider</Label>
                        <select
                          value={itemDraft.providerType}
                          onChange={(event) => setItemDraft((current) => ({
                            ...current,
                            providerType: event.target.value,
                            engineKind: defaultEngineKind(event.target.value),
                            baseUrl: defaultBaseUrl(event.target.value),
                            modelName: defaultModelName(event.target.value, defaultEngineKind(event.target.value)),
                            builtinTools: event.target.value === 'anthropic' ? current.builtinTools : [],
                          }))}
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
                        >
                          <option value="anthropic">Anthropic</option>
                          <option value="openai">OpenAI</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label>Protocol</Label>
                        <select
                          value={itemDraft.engineKind}
                          onChange={(event) => setItemDraft((current) => ({
                            ...current,
                            engineKind: event.target.value,
                            modelName: defaultModelName(current.providerType, event.target.value),
                          }))}
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
                        >
                          {(ENGINE_KIND_OPTIONS[itemDraft.providerType] || []).map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Model Name</Label>
                        <Input
                          value={itemDraft.modelName}
                          onChange={(event) => setItemDraft((current) => ({ ...current, modelName: event.target.value }))}
                          placeholder="claude-sonnet-4-20250514"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>API Key</Label>
                      <Input
                        type="password"
                        value={itemDraft.apiKey}
                        onChange={(event) => setItemDraft((current) => ({ ...current, apiKey: event.target.value }))}
                        placeholder={currentItem ? '(leave blank to keep current)' : 'sk-...'}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Base URL</Label>
                      <Input
                        value={itemDraft.baseUrl}
                        onChange={(event) => setItemDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                        placeholder="https://api.anthropic.com"
                      />
                    </div>

                    <div className="grid grid-cols-4 gap-4">
                      <div className="space-y-2">
                        <Label>Max Tokens</Label>
                        <Input
                          type="number"
                          value={itemDraft.maxTokens}
                          onChange={(event) => setItemDraft((current) => ({ ...current, maxTokens: event.target.value }))}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Priority</Label>
                        <Input
                          type="number"
                          value={itemDraft.priority}
                          onChange={(event) => setItemDraft((current) => ({ ...current, priority: event.target.value }))}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Weight</Label>
                        <Input
                          type="number"
                          value={itemDraft.weight}
                          onChange={(event) => setItemDraft((current) => ({ ...current, weight: event.target.value }))}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Status</Label>
                        <select
                          value={itemDraft.isEnabled ? 'enabled' : 'disabled'}
                          onChange={(event) => setItemDraft((current) => ({ ...current, isEnabled: event.target.value === 'enabled' }))}
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
                        >
                          <option value="enabled">Enabled</option>
                          <option value="disabled">Disabled</option>
                        </select>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <div className="flex flex-col gap-6">
                  {itemDraft.providerType === 'anthropic' ? (
                    <Card>
                      <CardHeader>
                        <CardTitle>Built-in Tools</CardTitle>
                        <CardDescription>Anthropic server-side tools exposed to this config.</CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-3">
                        {ANTHROPIC_BUILTIN_TOOLS.map((tool) => {
                          const checked = itemDraft.builtinTools.includes(tool.key);
                          return (
                            <label key={tool.key} className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border p-3">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => setItemDraft((current) => ({
                                  ...current,
                                  builtinTools: checked
                                    ? current.builtinTools.filter((value) => value !== tool.key)
                                    : [...current.builtinTools, tool.key],
                                }))}
                                className="mt-1 accent-primary"
                              />
                              <div>
                                <div className="font-medium text-foreground">{tool.label}</div>
                                <div className="text-sm text-muted-foreground">{tool.description}</div>
                              </div>
                            </label>
                          );
                        })}
                      </CardContent>
                    </Card>
                  ) : null}

                  <Card>
                    <CardHeader>
                      <CardTitle>Multimodal</CardTitle>
                      <CardDescription>Declare which input modalities this config supports.</CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                      {MULTIMODAL_TYPES.map((type) => {
                        const checked = itemDraft.multimodalTypes.includes(type.key);
                        return (
                          <label key={type.key} className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border p-3">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => setItemDraft((current) => ({
                                ...current,
                                multimodalTypes: checked
                                  ? current.multimodalTypes.filter((value) => value !== type.key)
                                  : [...current.multimodalTypes, type.key],
                              }))}
                              className="accent-primary"
                            />
                            <span className="font-medium text-foreground">{type.label}</span>
                          </label>
                        );
                      })}
                    </CardContent>
                  </Card>

                  {selectedGroup ? (
                    <Card>
                      <CardHeader>
                        <CardTitle>Selected Group</CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-3 text-sm">
                        <div className="flex items-center justify-between gap-4">
                          <span className="text-muted-foreground">Group</span>
                          <span className="font-medium text-foreground">{selectedGroup.name}</span>
                        </div>
                        <Separator />
                        <div className="flex items-center justify-between gap-4">
                          <span className="text-muted-foreground">Strategy</span>
                          <span className="font-medium text-foreground">{strategyLabel(selectedGroup.routing_strategy)}</span>
                        </div>
                        <Separator />
                        <div className="flex items-center justify-between gap-4">
                          <span className="text-muted-foreground">Configs</span>
                          <span className="font-medium text-foreground">{selectedGroup.items.length}</span>
                        </div>
                      </CardContent>
                    </Card>
                  ) : null}
                </div>
              </div>
            ) : (
              <Card className="max-w-xl">
                <CardHeader>
                  <CardTitle>Select a model group</CardTitle>
                  <CardDescription>Pick a group on the left, then choose a config in the middle column to edit it here.</CardDescription>
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
        scope={scope}
        group={editingGroup}
        onSaved={() => {
          setGroupDialogOpen(false);
          setEditingGroup(null);
          void loadGroups();
        }}
      />
    </div>
  );
}
