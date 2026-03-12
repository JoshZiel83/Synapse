'use client';

import { useEffect, useState } from 'react';
import { useWorkspace } from '../workspace-provider';
import { useAuthStore } from '@/stores/auth-store';
import { api } from '@/lib/api';
import type {
  CanonicalContentBlock,
  Memory as SharedMemory,
  MemoryCategory,
  MemoryGrant,
  MemoryScope,
  MemoryStability,
  MemoryStatus,
} from '@synapse/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Brain,
  Plus,
  RefreshCw,
  Filter,
  Pencil,
  Trash2,
  Tag,
  User,
  Star,
  Search,
  Layers,
  Link2,
  FileText,
  Share2,
} from 'lucide-react';

type Memory = SharedMemory & {
  actorName?: string;
  conversationTitle?: string;
  userName?: string;
};

interface ActorOption {
  id: string;
  name: string;
  title?: string;
}

interface GroupOption {
  id: string;
  title?: string;
}

type FormState = {
  content: string;
  ownerScope: MemoryScope;
  ownerActorId: string;
  ownerConversationId: string;
  ownerUserId: string;
  category: MemoryCategory;
  status: MemoryStatus;
  stability: MemoryStability;
  tags: string;
  importance: number;
  confidence: number;
  textDigest: string;
  grantsJson: string;
};

const defaultGrantJson = '[]';

function getCategoryBadge(category: MemoryCategory) {
  switch (category) {
    case 'fact':
      return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
    case 'preference':
      return 'bg-fuchsia-500/10 text-fuchsia-500 border-fuchsia-500/20';
    case 'decision':
      return 'bg-amber-500/10 text-amber-500 border-amber-500/20';
    case 'relationship':
      return 'bg-pink-500/10 text-pink-500 border-pink-500/20';
    case 'procedure':
      return 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20';
    case 'artifact':
      return 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20';
    case 'summary':
      return 'bg-violet-500/10 text-violet-500 border-violet-500/20';
  }
}

function getScopeLabel(scope: MemoryScope) {
  switch (scope) {
    case 'workspace':
      return 'Workspace';
    case 'conversation':
      return 'Conversation';
    case 'actor_global':
      return 'Actor';
    case 'actor_conversation':
      return 'Actor + Conversation';
    case 'user':
      return 'User';
  }
}

function getStatusBadge(status: MemoryStatus) {
  switch (status) {
    case 'established':
      return 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20';
    case 'candidate':
      return 'bg-slate-500/10 text-slate-500 border-slate-500/20';
    case 'superseded':
      return 'bg-amber-500/10 text-amber-500 border-amber-500/20';
    case 'retracted':
      return 'bg-red-500/10 text-red-500 border-red-500/20';
  }
}

function getTextPreview(memory: Memory) {
  if (memory.textDigest) return memory.textDigest;
  return memory.contentBlocks
    .filter((block): block is Extract<CanonicalContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function formatOwner(memory: Memory) {
  switch (memory.ownerScope) {
    case 'workspace':
      return 'Workspace';
    case 'conversation':
      return memory.conversationTitle || 'Conversation';
    case 'actor_global':
      return memory.actorName || 'Actor';
    case 'actor_conversation':
      return [memory.actorName || 'Actor', memory.conversationTitle || 'Conversation'].join(' · ');
    case 'user':
      return memory.userName || 'User';
  }
}

function serializeGrants(grants: MemoryGrant[]) {
  return JSON.stringify(
    grants.map((grant) => ({
      grantScope: grant.grantScope,
      actorId: grant.actorId,
      conversationId: grant.conversationId,
      userId: grant.userId,
      reason: grant.reason,
      metadata: grant.metadata,
    })),
    null,
    2,
  );
}

function parseGrantJson(raw: string): Array<{
  grantScope: MemoryScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}> {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error('Grants must be a JSON array.');
  }
  return parsed.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Each grant must be a JSON object.');
    }
    return item as {
      grantScope: MemoryScope;
      actorId?: string;
      conversationId?: string;
      userId?: string;
      reason?: string;
      metadata?: Record<string, unknown>;
    };
  });
}

function initialForm(actors: ActorOption[], groups: GroupOption[], currentUserId: string): FormState {
  return {
    content: '',
    ownerScope: 'actor_global',
    ownerActorId: actors[0]?.id || '',
    ownerConversationId: groups[0]?.id || '',
    ownerUserId: currentUserId,
    category: 'fact',
    status: 'established',
    stability: 'durable',
    tags: '',
    importance: 0.7,
    confidence: 0.8,
    textDigest: '',
    grantsJson: defaultGrantJson,
  };
}

export default function MemoriesPage() {
  const { workspaceId } = useWorkspace();
  const { user } = useAuthStore();
  const currentUserId = user?.id || user?.userId || '';

  const [memories, setMemories] = useState<Memory[]>([]);
  const [actors, setActors] = useState<ActorOption[]>([]);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [scopeFilter, setScopeFilter] = useState<'all' | MemoryScope>('all');
  const [formData, setFormData] = useState<FormState>(() => initialForm([], [], ''));

  useEffect(() => {
    if (!workspaceId) return;
    loadPageData();
  }, [workspaceId]);

  useEffect(() => {
    if (!dialogOpen || editingMemory) return;
    setFormData((current) => ({
      ...current,
      ownerUserId: current.ownerUserId || currentUserId,
    }));
  }, [currentUserId, dialogOpen, editingMemory]);

  async function loadPageData() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const [memoryData, actorData, groupData] = await Promise.all([
        api.getMemories(workspaceId),
        api.getActors(workspaceId),
        api.getGroups(workspaceId),
      ]);

      const memoryItems = Array.isArray(memoryData) ? memoryData : (memoryData?.memories || []);
      const actorItems = Array.isArray(actorData) ? actorData : [];
      const groupItems = Array.isArray(groupData) ? groupData : (groupData?.groups || []);

      setMemories(memoryItems);
      setActors(actorItems.map((actor: ActorOption) => ({ id: actor.id, name: actor.name, title: actor.title })));
      setGroups(groupItems.map((group: GroupOption) => ({ id: group.id, title: group.title })));
    } catch (error) {
      console.error('Failed to load memories page data:', error);
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setFormData(initialForm(actors, groups, currentUserId));
  }

  function openCreateDialog() {
    setEditingMemory(null);
    resetForm();
    setDialogOpen(true);
  }

  function openEditDialog(memory: Memory) {
    setEditingMemory(memory);
    setFormData({
      content: getTextPreview(memory),
      ownerScope: memory.ownerScope,
      ownerActorId: memory.ownerActorId || '',
      ownerConversationId: memory.ownerConversationId || '',
      ownerUserId: memory.ownerUserId || currentUserId,
      category: memory.category,
      status: memory.status,
      stability: memory.stability,
      tags: memory.tags.join(', '),
      importance: memory.importance,
      confidence: memory.confidence,
      textDigest: memory.textDigest,
      grantsJson: serializeGrants(memory.grants || []),
    });
    setDialogOpen(true);
  }

  function buildPayload() {
    const grants = parseGrantJson(formData.grantsJson);
    return {
      ownerScope: formData.ownerScope,
      ownerActorId: formData.ownerScope === 'actor_global' || formData.ownerScope === 'actor_conversation'
        ? formData.ownerActorId || undefined
        : undefined,
      ownerConversationId: formData.ownerScope === 'conversation' || formData.ownerScope === 'actor_conversation'
        ? formData.ownerConversationId || undefined
        : undefined,
      ownerUserId: formData.ownerScope === 'user'
        ? formData.ownerUserId || currentUserId || undefined
        : undefined,
      grants,
      category: formData.category,
      status: formData.status,
      stability: formData.stability,
      importance: formData.importance,
      confidence: formData.confidence,
      tags: formData.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      content: formData.content,
      textDigest: formData.textDigest || undefined,
    };
  }

  async function handleSave() {
    if (!workspaceId || !formData.content.trim()) return;
    setSaving(true);
    try {
      const payload = buildPayload();
      if (editingMemory) {
        await api.updateMemory(workspaceId, editingMemory.id, payload);
      } else {
        await api.createMemory(workspaceId, payload);
      }
      setDialogOpen(false);
      await loadPageData();
    } catch (error: any) {
      console.error('Failed to save memory:', error);
      alert(error?.message || 'Failed to save memory');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(memoryId: string) {
    if (!workspaceId) return;
    if (!confirm('Delete this memory entry?')) return;
    try {
      await api.deleteMemory(workspaceId, memoryId);
      await loadPageData();
    } catch (error) {
      console.error('Failed to delete memory:', error);
    }
  }

  const filteredMemories = memories.filter((memory) => {
    const preview = getTextPreview(memory).toLowerCase();
    const matchesSearch =
      !searchQuery ||
      preview.includes(searchQuery.toLowerCase()) ||
      memory.tags.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesCategory = categoryFilter === 'all' || memory.category === categoryFilter;
    const matchesScope = scopeFilter === 'all' || memory.ownerScope === scopeFilter;
    return matchesSearch && matchesCategory && matchesScope;
  });

  const categories = ['all', ...Array.from(new Set(memories.map((memory) => memory.category)))];
  const scopeOptions: Array<'all' | MemoryScope> = ['all', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user'];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20 flex items-center justify-center">
            <Brain className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Memories</h1>
            <p className="text-sm text-muted-foreground">Memory owners and sharing grants now control who can recall a fact.</p>
          </div>
          <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
            {memories.length} memories
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadPageData}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
          <Button size="sm" onClick={openCreateDialog} className="bg-indigo-600 hover:bg-indigo-500 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Add Memory
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-10"
            placeholder="Search memories..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          {categories.map((category) => (
            <Button
              key={category}
              variant={categoryFilter === category ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCategoryFilter(category)}
            >
              {category}
            </Button>
          ))}
          {scopeOptions.map((scope) => (
            <Button
              key={scope}
              variant={scopeFilter === scope ? 'default' : 'outline'}
              size="sm"
              onClick={() => setScopeFilter(scope)}
            >
              {scope === 'all' ? 'all scopes' : getScopeLabel(scope)}
            </Button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" />
        </div>
      ) : filteredMemories.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-emerald-500/10 to-teal-500/10 flex items-center justify-center mb-4">
            <Brain className="w-10 h-10 text-muted-foreground/50" />
          </div>
          <h3 className="text-lg font-semibold text-foreground mb-2">No Memories Found</h3>
          <p className="text-sm text-muted-foreground">
            {searchQuery ? 'Try a broader query.' : 'Memories will appear here once the system starts storing durable facts.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredMemories.map((memory) => {
            const preview = getTextPreview(memory);
            const fileRefs = memory.contentBlocks.filter((block) => block.type === 'file_ref').length;
            return (
              <Card key={memory.id} className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 shadow-sm transition-all duration-300 group">
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className={`text-xs ${getCategoryBadge(memory.category)}`}>
                        {memory.category}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {getScopeLabel(memory.ownerScope)}
                      </Badge>
                      <Badge variant="outline" className={`text-xs ${getStatusBadge(memory.status)}`}>
                        {memory.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditDialog(memory)}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => handleDelete(memory.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>

                  <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{preview || '(no text preview)'}</p>

                  {memory.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {memory.tags.map((tag) => (
                        <span key={tag} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-gray-50 dark:bg-background/30 text-muted-foreground border border-border/30">
                          <Tag className="w-2.5 h-2.5" />
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Star className="w-3 h-3 text-amber-500" />
                      importance {(memory.importance ?? 0).toFixed(2)}
                    </div>
                    <div className="flex items-center gap-1">
                      <Layers className="w-3 h-3 text-sky-500" />
                      confidence {(memory.confidence ?? 0).toFixed(2)}
                    </div>
                    <div className="flex items-center gap-1">
                      <User className="w-3 h-3" />
                      {formatOwner(memory)}
                    </div>
                    <div className="flex items-center gap-1">
                      <Share2 className="w-3 h-3" />
                      {memory.grants.length} grants
                    </div>
                    <div className="flex items-center gap-1">
                      <FileText className="w-3 h-3" />
                      {memory.stability}
                    </div>
                    <div className="flex items-center gap-1">
                      <Link2 className="w-3 h-3" />
                      {fileRefs} file refs
                    </div>
                  </div>

                  <div className="pt-2 border-t border-border/30 text-[10px] text-muted-foreground/60">
                    updated {new Date(memory.updatedAt).toLocaleString()}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingMemory ? 'Edit Memory' : 'Create Memory'}</DialogTitle>
            <DialogDescription>
              Set the owner for this fact, then optionally share it with additional conversations, actors, users, or the whole workspace.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Content</Label>
              <textarea
                value={formData.content}
                onChange={(event) => setFormData((current) => ({ ...current, content: event.target.value }))}
                rows={5}
                className="flex w-full rounded-md border border-input bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Owner Scope</Label>
                <select
                  value={formData.ownerScope}
                  onChange={(event) => setFormData((current) => ({ ...current, ownerScope: event.target.value as MemoryScope }))}
                  className="flex h-10 w-full rounded-md border border-input bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm"
                >
                  <option value="workspace">Workspace</option>
                  <option value="conversation">Conversation</option>
                  <option value="actor_global">Actor</option>
                  <option value="actor_conversation">Actor + Conversation</option>
                  <option value="user">User</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>Category</Label>
                <select
                  value={formData.category}
                  onChange={(event) => setFormData((current) => ({ ...current, category: event.target.value as MemoryCategory }))}
                  className="flex h-10 w-full rounded-md border border-input bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm"
                >
                  <option value="fact">Fact</option>
                  <option value="preference">Preference</option>
                  <option value="decision">Decision</option>
                  <option value="relationship">Relationship</option>
                  <option value="procedure">Procedure</option>
                  <option value="artifact">Artifact</option>
                  <option value="summary">Summary</option>
                </select>
              </div>
            </div>

            {(formData.ownerScope === 'actor_global' || formData.ownerScope === 'actor_conversation') && (
              <div className="space-y-2">
                <Label>Owner Actor</Label>
                <select
                  value={formData.ownerActorId}
                  onChange={(event) => setFormData((current) => ({ ...current, ownerActorId: event.target.value }))}
                  className="flex h-10 w-full rounded-md border border-input bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm"
                >
                  <option value="">Select actor</option>
                  {actors.map((actor) => (
                    <option key={actor.id} value={actor.id}>
                      {actor.name}{actor.title ? ` · ${actor.title}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {(formData.ownerScope === 'conversation' || formData.ownerScope === 'actor_conversation') && (
              <div className="space-y-2">
                <Label>Owner Conversation</Label>
                <select
                  value={formData.ownerConversationId}
                  onChange={(event) => setFormData((current) => ({ ...current, ownerConversationId: event.target.value }))}
                  className="flex h-10 w-full rounded-md border border-input bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm"
                >
                  <option value="">Select conversation</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.title || group.id}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {formData.ownerScope === 'user' && (
              <div className="space-y-2">
                <Label>Owner User</Label>
                <div className="flex h-10 w-full rounded-md border border-input bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm items-center text-muted-foreground">
                  {user?.name || user?.email || 'Current user'}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Status</Label>
                <select
                  value={formData.status}
                  onChange={(event) => setFormData((current) => ({ ...current, status: event.target.value as MemoryStatus }))}
                  className="flex h-10 w-full rounded-md border border-input bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm"
                >
                  <option value="candidate">Candidate</option>
                  <option value="established">Established</option>
                  <option value="superseded">Superseded</option>
                  <option value="retracted">Retracted</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>Stability</Label>
                <select
                  value={formData.stability}
                  onChange={(event) => setFormData((current) => ({ ...current, stability: event.target.value as MemoryStability }))}
                  className="flex h-10 w-full rounded-md border border-input bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm"
                >
                  <option value="durable">Durable</option>
                  <option value="ephemeral">Ephemeral</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Importance</Label>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={formData.importance}
                  onChange={(event) => setFormData((current) => ({ ...current, importance: parseFloat(event.target.value) || 0 }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Confidence</Label>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={formData.confidence}
                  onChange={(event) => setFormData((current) => ({ ...current, confidence: parseFloat(event.target.value) || 0 }))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Text Digest</Label>
              <Input
                value={formData.textDigest}
                onChange={(event) => setFormData((current) => ({ ...current, textDigest: event.target.value }))}
                placeholder="Optional one-line digest for faster recall"
              />
            </div>

            <div className="space-y-2">
              <Label>Tags</Label>
              <Input
                value={formData.tags}
                onChange={(event) => setFormData((current) => ({ ...current, tags: event.target.value }))}
                placeholder="comma,separated,tags"
              />
            </div>

            <div className="space-y-2">
              <Label>Sharing Grants (JSON)</Label>
              <textarea
                value={formData.grantsJson}
                onChange={(event) => setFormData((current) => ({ ...current, grantsJson: event.target.value }))}
                rows={6}
                className="flex w-full rounded-md border border-input bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm font-mono"
                placeholder='[{"grantScope":"conversation","conversationId":"..."}]'
              />
              <p className="text-xs text-muted-foreground">
                Example: share this memory into another conversation or actor without changing its owner.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !formData.content.trim()} className="bg-indigo-600 hover:bg-indigo-500 text-white">
              {saving ? 'Saving...' : editingMemory ? 'Update Memory' : 'Create Memory'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
