'use client';

import { useEffect, useState } from 'react';
import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
import OrgTree from '@/components/org-tree';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Plus, Users, RefreshCw } from 'lucide-react';

export default function OrganizationPage() {
  const { workspaceId } = useWorkspace();
  const [actors, setActors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [parentId, setParentId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    role: '',
    title: '',
    capabilities: '',
  });

  useEffect(() => {
    if (!workspaceId) return;
    loadActors();
  }, [workspaceId]);

  async function loadActors() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      // Try tree endpoint first, fall back to flat list
      let data;
      try {
        data = await api.getOrgTree(workspaceId);
      } catch {
        data = await api.getActors(workspaceId);
      }
      setActors(Array.isArray(data) ? data : (data?.actors || data?.tree || []));
    } catch (err) {
      console.error('Failed to load actors:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleAddChild(pId: string) {
    setParentId(pId);
    setDialogOpen(true);
  }

  function handleAddRoot() {
    setParentId(null);
    setDialogOpen(true);
  }

  async function handleCreate() {
    if (!workspaceId || !formData.name || !formData.role) return;
    setCreating(true);
    try {
      await api.createActor(workspaceId, {
        name: formData.name,
        role: formData.role,
        title: formData.title || undefined,
        capabilities: formData.capabilities
          ? formData.capabilities.split(',').map((c) => c.trim()).filter(Boolean)
          : undefined,
        parentId: parentId || undefined,
      });
      setDialogOpen(false);
      setFormData({ name: '', role: '', title: '', capabilities: '' });
      setParentId(null);
      loadActors();
    } catch (err: any) {
      console.error('Failed to create actor:', err);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-purple-600 shadow-lg shadow-violet-500/20 flex items-center justify-center">
            <Users className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Organization</h1>
            <p className="text-sm text-muted-foreground">Manage your digital employee hierarchy</p>
          </div>
          <Badge variant="secondary" className="bg-violet-500/10 text-violet-400 border-violet-500/20">
            {actors.length} actors
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadActors}
            className="border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-white/5 text-muted-foreground"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={handleAddRoot}
            className="bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Actor
          </Button>
        </div>
      </div>

      {/* Tree */}
      <Card className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 shadow-sm">
        <CardContent className="p-6">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-8 w-8 rounded-full border-2 border-violet-500 border-t-transparent animate-spin" />
            </div>
          ) : (
            <OrgTree actors={actors} onAddChild={handleAddChild} />
          )}
        </CardContent>
      </Card>

      {/* Create Actor Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              {parentId ? 'Add Subordinate Actor' : 'Add Root Actor'}
            </DialogTitle>
            <DialogDescription>
              Create a new digital employee in your organization.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Name</Label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Project Manager Alpha"
                className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-gray-700"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">Role</Label>
              <Input
                value={formData.role}
                onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                placeholder="e.g., manager, engineer, analyst"
                className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-gray-700"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">Title (optional)</Label>
              <Input
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="e.g., Senior Project Coordinator"
                className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-gray-700"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">Capabilities (comma-separated)</Label>
              <Input
                value={formData.capabilities}
                onChange={(e) => setFormData({ ...formData, capabilities: e.target.value })}
                placeholder="e.g., code-review, testing, deployment"
                className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-gray-700"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} className="border-gray-200 dark:border-gray-700">
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!formData.name || !formData.role || creating}
              className="bg-indigo-600 hover:bg-indigo-500 text-white"
            >
              {creating ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  Creating...
                </span>
              ) : (
                'Create Actor'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
