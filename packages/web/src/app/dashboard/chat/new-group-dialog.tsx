'use client';

import { useEffect, useState, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { Search, X, Bot } from 'lucide-react';

interface Actor {
  id: string;
  name: string;
  role: string;
  title?: string;
  config?: { avatar_emoji?: string };
}

interface NewGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onCreateGroup: (actorIds: string[]) => void;
  preselectedActorId?: string;
}

// Group actors by role
function groupByRole(actors: Actor[]): { role: string; actors: Actor[] }[] {
  const map = new Map<string, Actor[]>();
  for (const a of actors) {
    const role = a.role || 'other';
    if (!map.has(role)) map.set(role, []);
    map.get(role)!.push(a);
  }
  // Sort: secretary first, then alphabetical
  const entries = Array.from(map.entries());
  entries.sort(([a], [b]) => {
    if (a === 'secretary') return -1;
    if (b === 'secretary') return 1;
    return a.localeCompare(b);
  });
  return entries.map(([role, actors]) => ({ role, actors }));
}

function roleLabel(role: string): string {
  switch (role) {
    case 'secretary': return 'Secretary';
    case 'specialist': return 'Specialist';
    case 'manager': return 'Manager';
    default: return role.charAt(0).toUpperCase() + role.slice(1);
  }
}

export default function NewGroupDialog({ open, onOpenChange, workspaceId, onCreateGroup, preselectedActorId }: NewGroupDialogProps) {
  const [actors, setActors] = useState<Actor[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !workspaceId) return;
    (async () => {
      try {
        const data = await api.getActors(workspaceId);
        const list: Actor[] = data?.actors || data || [];
        list.sort((a, b) => a.name.localeCompare(b.name));
        setActors(list);

        if (preselectedActorId) {
          setSelectedIds(new Set([preselectedActorId]));
        }
      } catch (err) {
        console.error('Failed to load actors:', err);
      }
    })();
  }, [open, workspaceId, preselectedActorId]);

  useEffect(() => {
    if (!open) {
      setSelectedIds(new Set());
      setSearch('');
    }
  }, [open]);

  function toggleActor(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function removeActor(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function handleCreate() {
    if (selectedIds.size === 0) return;
    setLoading(true);
    try {
      onCreateGroup(Array.from(selectedIds));
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return actors;
    const q = search.toLowerCase();
    return actors.filter((a) => a.name.toLowerCase().includes(q) || a.title?.toLowerCase().includes(q));
  }, [actors, search]);

  const grouped = useMemo(() => groupByRole(filtered), [filtered]);
  const selectedActors = useMemo(() => actors.filter((a) => selectedIds.has(a.id)), [actors, selectedIds]);

  function ActorAvatar({ actor, size = 'md' }: { actor: Actor; size?: 'md' | 'sm' }) {
    const cls = size === 'md' ? 'h-10 w-10 rounded-md text-lg' : 'h-9 w-9 rounded-md text-base';
    return (
      <div className={`${cls} bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0 ring-1 ring-gray-900/10 dark:ring-white/10`}>
        {actor.config?.avatar_emoji ? (
          <span>{actor.config.avatar_emoji}</span>
        ) : (
          <Bot className={size === 'md' ? 'w-5 h-5 text-white' : 'w-4 h-4 text-white'} />
        )}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 p-0 max-w-[740px] w-full overflow-hidden">
        <div className="flex h-[520px]">

          {/* Left: actor list */}
          <div className="flex w-[340px] flex-col border-r border-gray-200 dark:border-white/10">
            {/* Search */}
            <div className="p-4 border-b border-gray-100 dark:border-white/5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search actors..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="block w-full rounded-md bg-white pl-9 pr-3 py-1.5 text-sm text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
                  autoFocus
                />
              </div>
            </div>

            {/* Scrollable list */}
            <div className="flex-1 overflow-y-auto">
              {grouped.map(({ role, actors: groupActors }) => (
                <div key={role}>
                  {/* Role header */}
                  <div className="px-5 py-1.5 text-xs font-semibold text-gray-500 bg-gray-50 dark:bg-white/5 dark:text-gray-400 sticky top-0">
                    {roleLabel(role)}
                  </div>
                  {/* Actor rows */}
                  {groupActors.map((actor) => (
                    <label
                      key={actor.id}
                      className="flex items-center px-5 py-2.5 cursor-pointer select-none hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                    >
                      <div className="flex h-6 shrink-0 items-center mr-3">
                        <div className="group grid size-4 grid-cols-1">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(actor.id)}
                            onChange={() => toggleActor(actor.id)}
                            className="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:focus-visible:outline-indigo-500"
                          />
                          <svg
                            fill="none"
                            viewBox="0 0 14 14"
                            className="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white"
                          >
                            <path
                              d="M3 8L6 11L11 3.5"
                              strokeWidth={2}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="opacity-0 group-has-checked:opacity-100"
                            />
                          </svg>
                        </div>
                      </div>
                      <ActorAvatar actor={actor} />
                      <div className="ml-3 min-w-0 flex-1">
                        <span className="text-sm font-medium text-gray-900 dark:text-white truncate block">{actor.name}</span>
                        {actor.title && (
                          <span className="text-xs text-gray-500 dark:text-gray-400 truncate block">{actor.title}</span>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="px-5 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                  No actors found
                </div>
              )}
            </div>
          </div>

          {/* Right: selected list */}
          <div className="flex flex-1 flex-col">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-100 dark:border-white/5 flex justify-between items-center">
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">New Group</h2>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select actors'}
              </span>
            </div>

            {/* Selected actors */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {selectedActors.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <div className="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-white/5 flex items-center justify-center mb-3">
                    <Bot className="w-8 h-8 text-gray-300 dark:text-gray-600" />
                  </div>
                  <p className="text-sm text-gray-400 dark:text-gray-500">
                    Select actors from the left
                  </p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {selectedActors.map((actor) => (
                    <div
                      key={`sel-${actor.id}`}
                      className="flex items-center px-2 py-2 group rounded-md hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                    >
                      <ActorAvatar actor={actor} size="sm" />
                      <div className="ml-3 min-w-0 flex-1">
                        <span className="text-sm font-medium text-gray-900 dark:text-white truncate block">{actor.name}</span>
                        {actor.title && (
                          <span className="text-xs text-gray-500 dark:text-gray-400 truncate block">{actor.title}</span>
                        )}
                      </div>
                      <button
                        onClick={() => removeActor(actor.id)}
                        className="ml-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-300 transition-colors"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer buttons */}
            <div className="px-6 py-4 border-t border-gray-100 dark:border-white/5 flex justify-end gap-3 bg-gray-50 dark:bg-gray-900">
              <button
                onClick={() => onOpenChange(false)}
                className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-gray-900 shadow-xs ring-1 ring-inset ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:ring-white/5 dark:hover:bg-white/20"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={selectedIds.size === 0 || loading}
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed dark:bg-indigo-500 dark:hover:bg-indigo-400"
              >
                Create
              </button>
            </div>
          </div>

        </div>
      </DialogContent>
    </Dialog>
  );
}
