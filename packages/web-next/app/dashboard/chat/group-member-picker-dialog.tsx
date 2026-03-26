'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Search, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import ChatAvatar from './chat-avatar';
import type { GroupMember } from '@/stores/chat-store';

type PickerOption = {
  type: 'actor' | 'user';
  id: string;
  name: string;
  subtitle?: string;
  avatarUrl?: string;
  emoji?: string;
};

function normalizeActorOption(actor: any): PickerOption {
  const definition = actor?.definition || actor;
  return {
    type: 'actor',
    id: actor.id,
    name: definition.name || 'Untitled actor',
    subtitle: definition.title || definition.role || undefined,
    avatarUrl: actor.avatarUrl,
    emoji: definition?.avatarEmoji || undefined,
  };
}

function normalizeUserOption(member: any): PickerOption {
  return {
    type: 'user',
    id: member.userId || member.id,
    name: member.userName || member.userEmail || 'Unknown user',
    subtitle: member.userEmail || undefined,
    avatarUrl: member.avatarUrl || undefined,
  };
}

interface GroupMemberPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  groupId: string;
  existingMembers: GroupMember[];
  onAdded: () => Promise<void> | void;
}

export default function GroupMemberPickerDialog({
  open,
  onOpenChange,
  workspaceId,
  groupId,
  existingMembers,
  onAdded,
}: GroupMemberPickerDialogProps) {
  const [options, setOptions] = useState<PickerOption[]>([]);
  const [search, setSearch] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setSearch('');
      setSelectedKeys(new Set());
      return;
    }

    let cancelled = false;
    void (async () => {
      const [actorsRes, membersRes] = await Promise.all([
        api.getActors(workspaceId),
        api.getWorkspaceMembers(workspaceId),
      ]);

      if (cancelled) return;

      const actorOptions = (actorsRes?.actors || actorsRes || []).map(normalizeActorOption);
      const userOptions = (membersRes?.data || membersRes || []).map(normalizeUserOption);
      const existingActorIds = new Set(existingMembers.filter((member) => member.type === 'actor').map((member) => member.id));
      const existingUserIds = new Set(existingMembers.filter((member) => member.type === 'user').map((member) => member.id));

      setOptions([
        ...actorOptions.filter((option: PickerOption) => !existingActorIds.has(option.id)),
        ...userOptions.filter((option: PickerOption) => !existingUserIds.has(option.id)),
      ]);
    })().catch((error) => {
      console.error('Failed to load available group members:', error);
      if (!cancelled) setOptions([]);
    });

    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, existingMembers]);

  const filteredOptions = useMemo(() => {
    if (!search.trim()) return options;
    const query = search.toLowerCase();
    return options.filter((option) =>
      option.name.toLowerCase().includes(query) ||
      option.subtitle?.toLowerCase().includes(query),
    );
  }, [options, search]);

  const groupedOptions = useMemo(() => ({
    actors: filteredOptions.filter((option) => option.type === 'actor'),
    users: filteredOptions.filter((option) => option.type === 'user'),
  }), [filteredOptions]);

  function toggleOption(option: PickerOption) {
    const key = `${option.type}:${option.id}`;
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleAdd() {
    if (selectedKeys.size === 0) return;
    setSubmitting(true);
    try {
      const actorIds: string[] = [];
      const userIds: string[] = [];

      for (const key of selectedKeys) {
        const [type, id] = key.split(':');
        if (type === 'actor') actorIds.push(id);
        if (type === 'user') userIds.push(id);
      }

      await api.addGroupMembers(workspaceId, groupId, { actorIds, userIds });
      await onAdded();
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to add group members:', error);
    } finally {
      setSubmitting(false);
    }
  }

  function renderSection(title: string, sectionOptions: PickerOption[]) {
    if (sectionOptions.length === 0) return null;

    return (
      <div className="flex flex-col gap-2">
        <div className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
        <div className="overflow-hidden rounded-3xl border border-border bg-background">
          {sectionOptions.map((option) => {
            const key = `${option.type}:${option.id}`;
            const checked = selectedKeys.has(key);
            return (
              <div
                key={key}
                role="button"
                tabIndex={0}
                aria-pressed={checked}
                onClick={() => toggleOption(option)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggleOption(option);
                  }
                }}
                className="flex w-full items-center gap-3 border-b border-border/60 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/30"
              >
                <Checkbox checked={checked} className="pointer-events-none" />
                <ChatAvatar
                  name={option.name}
                  avatarUrl={option.avatarUrl}
                  emoji={option.emoji}
                  entityType={option.type}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">{option.name}</div>
                  {option.subtitle ? (
                    <div className="truncate text-xs text-muted-foreground">{option.subtitle}</div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add members</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search actors or users"
              className="pl-9"
            />
          </div>

          <ScrollArea className="h-[420px] pr-3">
            <div className="flex flex-col gap-4">
              {renderSection('Actors', groupedOptions.actors)}
              {renderSection('Users', groupedOptions.users)}
              {filteredOptions.length === 0 ? (
                <div className="rounded-3xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                  No available actors or users
                </div>
              ) : null}
            </div>
          </ScrollArea>

          <div className="flex items-center justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleAdd()}
              disabled={selectedKeys.size === 0 || submitting}
            >
              <UserPlus className="size-4" />
              Add members
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
