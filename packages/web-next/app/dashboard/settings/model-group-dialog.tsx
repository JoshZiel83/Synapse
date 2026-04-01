'use client';

import { useState, useEffect } from 'react';
import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
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

interface ModelGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope?: 'workspace' | 'platform' | 'workspace_member';
  availableScopes?: Array<'workspace' | 'platform' | 'workspace_member'>;
  group: any | null; // null = create, object = edit
  onSaved: () => void;
}

const STRATEGIES = [
  { value: 'priority_failover', label: 'Priority Failover', desc: 'Use highest-priority model, fall back on failure' },
  { value: 'weighted_random', label: 'Weighted Random', desc: 'Randomly select by weight distribution' },
  { value: 'round_robin', label: 'Round Robin', desc: 'Cycle through models evenly' },
];

export default function ModelGroupDialog({
  open,
  onOpenChange,
  scope = 'workspace',
  availableScopes,
  group,
  onSaved,
}: ModelGroupDialogProps) {
  const { workspaceId } = useWorkspace();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [strategy, setStrategy] = useState('priority_failover');
  const [isDefault, setIsDefault] = useState(false);
  const [selectedScope, setSelectedScope] =
    useState<'workspace' | 'platform' | 'workspace_member'>(scope);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (group) {
      setName(group.name || '');
      setDescription(group.description || '');
      setStrategy(group.routing_strategy || 'priority_failover');
      setIsDefault(group.is_default || false);
      setSelectedScope(scope);
    } else {
      setName('');
      setDescription('');
      setStrategy('priority_failover');
      setIsDefault(false);
      setSelectedScope(availableScopes?.[0] || scope);
    }
  }, [availableScopes, group, open, scope]);

  const handleSave = async () => {
    const effectiveScope = group ? scope : selectedScope;
    if ((!workspaceId && effectiveScope === 'workspace') || !name.trim()) return;
    setSaving(true);
    try {
      const data = {
        name: name.trim(),
        description: description.trim(),
        routingStrategy: strategy,
        isDefault,
      };
      if (effectiveScope === 'platform') {
        if (group) {
          await api.updatePlatformModelGroup(group.id, data);
        } else {
          await api.createPlatformModelGroup(data);
        }
      } else if (effectiveScope === 'workspace_member') {
        if (group) {
          await api.updateWorkspaceMemberModelGroup(
            workspaceId!,
            group.id,
            data
          );
        } else {
          await api.createWorkspaceMemberModelGroup(workspaceId!, data);
        }
      } else if (group) {
        await api.updateModelGroup(workspaceId!, group.id, data);
      } else {
        await api.createModelGroup(workspaceId!, data);
      }
      onSaved();
    } catch (err) {
      console.error('Failed to save model group:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{group ? 'Edit Model Group' : 'Create Model Group'}</DialogTitle>
          <DialogDescription>
            {group ? 'Update group configuration' : 'Create a new model group to manage AI routing'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {!group && (availableScopes?.length || 0) > 1 ? (
            <div className="space-y-2">
              <Label>Scope</Label>
              <select
                value={selectedScope}
                onChange={(event) =>
                  setSelectedScope(
                    event.target.value as
                      | 'workspace'
                      | 'platform'
                      | 'workspace_member'
                  )
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
              >
                {availableScopes?.map((option) => (
                  <option key={option} value={option}>
                    {option === 'workspace'
                      ? 'Workspace'
                      : option === 'platform'
                        ? 'Platform'
                        : 'Member'}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Primary Models"
              className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/10 focus:border-blue-500/40"
            />
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/10 focus:border-blue-500/40"
            />
          </div>

          <div className="space-y-2">
            <Label>Routing Strategy</Label>
            <div className="grid gap-2">
              {STRATEGIES.map(s => (
                <label
                  key={s.value}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                    strategy === s.value
                      ? 'border-blue-500/40 bg-blue-500/10'
                      : 'border-gray-200 dark:border-white/10 hover:border-blue-500/20 bg-background/30'
                  }`}
                >
                  <input
                    type="radio"
                    name="strategy"
                    value={s.value}
                    checked={strategy === s.value}
                    onChange={() => setStrategy(s.value)}
                    className="mt-0.5 accent-blue-500"
                  />
                  <div>
                    <div className="text-sm font-medium">{s.label}</div>
                    <div className="text-xs text-muted-foreground">{s.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="accent-blue-500"
            />
            <span className="text-sm">Set as default group for this scope</span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="border-gray-200 dark:border-white/10">
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}
            className="bg-indigo-600 hover:bg-indigo-500">
            {saving ? 'Saving...' : group ? 'Update' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
