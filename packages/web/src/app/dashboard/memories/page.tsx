'use client';

import { useEffect, useState } from 'react';
import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
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
} from 'lucide-react';

interface Memory {
  id: string;
  content: string;
  category: string;
  tags?: string[];
  importance?: number;
  scope?: string;
  actorId?: string;
  actorName?: string;
  createdAt?: string;
  updatedAt?: string;
}

function getCategoryBadge(category: string) {
  switch (category?.toLowerCase()) {
    case 'working':
      return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
    case 'experiential':
      return 'bg-violet-500/10 text-violet-400 border-violet-500/20';
    case 'knowledge':
      return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
    case 'procedural':
      return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    case 'relational':
      return 'bg-pink-500/10 text-pink-400 border-pink-500/20';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

export default function MemoriesPage() {
  const { workspaceId } = useWorkspace();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [formData, setFormData] = useState({
    content: '',
    category: 'knowledge',
    tags: '',
    importance: 0.5,
    scope: 'workspace',
  });

  useEffect(() => {
    if (!workspaceId) return;
    loadMemories();
  }, [workspaceId]);

  async function loadMemories() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const data = await api.getMemories(workspaceId);
      const items = Array.isArray(data) ? data : (data?.items || data?.memories || []);
      setMemories(items);
    } catch (err) {
      console.error('Failed to load memories:', err);
    } finally {
      setLoading(false);
    }
  }

  function openCreateDialog() {
    setEditingMemory(null);
    setFormData({ content: '', category: 'fact', tags: '', importance: 5, scope: 'workspace' });
    setDialogOpen(true);
  }

  function openEditDialog(memory: Memory) {
    setEditingMemory(memory);
    setFormData({
      content: memory.content,
      category: memory.category,
      tags: memory.tags?.join(', ') || '',
      importance: memory.importance || 0.5,
      scope: memory.scope || 'workspace',
    });
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!workspaceId || !formData.content) return;
    setSaving(true);
    try {
      const payload = {
        content: formData.content,
        category: formData.category,
        tags: formData.tags ? formData.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        importance: formData.importance,
        scope: formData.scope,
      };

      if (editingMemory) {
        await api.updateMemory(workspaceId, editingMemory.id, payload);
      } else {
        await api.createMemory(workspaceId, payload);
      }
      setDialogOpen(false);
      loadMemories();
    } catch (err: any) {
      console.error('Failed to save memory:', err);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!workspaceId) return;
    if (!confirm('Are you sure you want to delete this memory?')) return;
    try {
      await api.deleteMemory(workspaceId, id);
      loadMemories();
    } catch (err) {
      console.error('Failed to delete memory:', err);
    }
  }

  const filteredMemories = memories.filter((m) => {
    const matchesSearch = !searchQuery || m.content.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = categoryFilter === 'all' || m.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  const categories = ['all', ...Array.from(new Set(memories.map((m) => m.category).filter(Boolean)))];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20 flex items-center justify-center">
            <Brain className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Memories</h1>
            <p className="text-sm text-muted-foreground">Organizational knowledge and learned information</p>
          </div>
          <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
            {memories.length} memories
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadMemories}
            className="border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-white/5 text-muted-foreground"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={openCreateDialog}
            className="bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Memory
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search memories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-gray-700"
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="w-4 h-4 text-muted-foreground" />
          {categories.map((cat) => (
            <Button
              key={cat}
              variant={categoryFilter === cat ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCategoryFilter(cat)}
              className={
                categoryFilter === cat
                  ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/30'
                  : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-white/5 text-muted-foreground'
              }
            >
              {cat.charAt(0).toUpperCase() + cat.slice(1)}
            </Button>
          ))}
        </div>
      </div>

      {/* Memory List */}
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
            {searchQuery || categoryFilter !== 'all'
              ? 'Try adjusting your filters.'
              : 'Memories will be stored as your organization learns and grows.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredMemories.map((memory) => (
            <Card key={memory.id} className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 shadow-sm hover:border-gray-200 dark:hover:border-white/10 transition-all duration-300 group">
              <CardContent className="p-5 space-y-3">
                {/* Top row */}
                <div className="flex items-start justify-between gap-2">
                  <Badge variant="outline" className={`text-xs ${getCategoryBadge(memory.category)}`}>
                    {memory.category}
                  </Badge>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-indigo-600 dark:hover:text-indigo-400"
                      onClick={() => openEditDialog(memory)}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-red-400"
                      onClick={() => handleDelete(memory.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>

                {/* Content */}
                <p className="text-sm text-foreground leading-relaxed">{memory.content}</p>

                {/* Tags */}
                {memory.tags && memory.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {memory.tags.map((tag, i) => (
                      <span key={i} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-gray-50 dark:bg-background/30 text-muted-foreground border border-border/30">
                        <Tag className="w-2.5 h-2.5" />
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* Bottom row */}
                <div className="flex items-center justify-between pt-2 border-t border-border/30">
                  <div className="flex items-center gap-3">
                    {memory.importance && (
                      <div className="flex items-center gap-1">
                        <Star className="w-3 h-3 text-amber-400" />
                        <span className="text-xs text-muted-foreground">{(memory.importance ?? 0).toFixed(1)}</span>
                      </div>
                    )}
                    {memory.actorName && (
                      <div className="flex items-center gap-1">
                        <User className="w-3 h-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">{memory.actorName}</span>
                      </div>
                    )}
                  </div>
                  {memory.createdAt && (
                    <span className="text-[10px] text-muted-foreground/50">
                      {new Date(memory.createdAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              {editingMemory ? 'Edit Memory' : 'Create Memory'}
            </DialogTitle>
            <DialogDescription>
              {editingMemory ? 'Update this memory entry.' : 'Add a new piece of knowledge to your organization.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Content</Label>
              <textarea
                value={formData.content}
                onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                placeholder="What should be remembered?"
                rows={3}
                className="flex w-full rounded-md border border-input bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground">Category</Label>
                <select
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  className="flex h-10 w-full rounded-md border border-input bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="knowledge">Knowledge</option>
                  <option value="experiential">Experiential</option>
                  <option value="working">Working</option>
                  <option value="procedural">Procedural</option>
                  <option value="relational">Relational</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">Importance (0-1)</Label>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={formData.importance}
                  onChange={(e) => setFormData({ ...formData, importance: parseFloat(e.target.value) || 0.5 })}
                  className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-gray-700"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">Tags (comma-separated)</Label>
              <Input
                value={formData.tags}
                onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                placeholder="e.g., project-x, architecture, decision"
                className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-gray-700"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">Scope</Label>
              <select
                value={formData.scope}
                onChange={(e) => setFormData({ ...formData, scope: e.target.value })}
                className="flex h-10 w-full rounded-md border border-input bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="private">Private</option>
                <option value="team">Team</option>
                <option value="workspace">Workspace</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} className="border-gray-200 dark:border-gray-700">
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={!formData.content || saving}
              className="bg-indigo-600 hover:bg-indigo-500 text-white"
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  Saving...
                </span>
              ) : editingMemory ? (
                'Update Memory'
              ) : (
                'Create Memory'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
