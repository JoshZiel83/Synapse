'use client';

import { useEffect, useMemo, useState } from 'react';
import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Bot,
  Brain,
  Mail,
  Search,
  ShieldCheck,
  User,
  Users,
} from 'lucide-react';

type WorkspaceMember = {
  id: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  avatarUrl?: string | null;
  trustLevel: string;
  joinedAt: string;
};

type Actor = {
  id: string;
  name: string;
  role: string;
  title?: string;
  charter?: string;
  capabilities?: string[];
  skills?: Array<{ name: string; description?: string }>;
  isActive?: boolean;
  createdAt?: string;
};

type ContactItem =
  | {
      kind: 'user';
      id: string;
      name: string;
      subtitle: string;
      data: WorkspaceMember;
    }
  | {
      kind: 'actor';
      id: string;
      name: string;
      subtitle: string;
      data: Actor;
    };

function formatDate(dateString?: string) {
  if (!dateString) return 'Unknown';
  try {
    return new Date(dateString).toLocaleDateString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return 'Unknown';
  }
}

function titleCase(input: string) {
  return input
    .split('_')
    .join(' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function ContactListItem({
  item,
  active,
  onSelect,
}: {
  item: ContactItem;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
        active
          ? 'border-primary bg-accent'
          : 'border-transparent hover:bg-accent/60'
      }`}
    >
      <div className="flex items-center gap-3">
        {item.kind === 'user' ? (
          <Avatar className="size-10">
            <AvatarImage src={item.data.avatarUrl || undefined} alt={item.name} />
            <AvatarFallback>{item.name.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
        ) : (
          <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Bot className="size-5" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{item.name}</div>
          <div className="truncate text-sm text-muted-foreground">{item.subtitle}</div>
        </div>
      </div>
    </button>
  );
}

function UserDetail({ member }: { member: WorkspaceMember }) {
  const displayName = member.userName || 'Unknown user';

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-5">
        <div className="flex items-start gap-4">
          <Avatar className="size-16">
            <AvatarImage src={member.avatarUrl || undefined} alt={displayName} />
            <AvatarFallback className="text-lg">{displayName.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-foreground">{displayName}</h2>
              <Badge variant="secondary">Workspace User</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{member.userEmail || 'No email available'}</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Account</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <div className="flex items-start gap-3">
                <Mail className="mt-0.5 size-4 text-muted-foreground" />
                <div>
                  <div className="font-medium text-foreground">Email</div>
                  <div className="text-muted-foreground">{member.userEmail || 'Not available'}</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 size-4 text-muted-foreground" />
                <div>
                  <div className="font-medium text-foreground">Workspace Role</div>
                  <div className="text-muted-foreground">{titleCase(member.trustLevel)}</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Users className="mt-0.5 size-4 text-muted-foreground" />
                <div>
                  <div className="font-medium text-foreground">Joined Workspace</div>
                  <div className="text-muted-foreground">{formatDate(member.joinedAt)}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ActorDetail({ actor }: { actor: Actor }) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-5">
        <div className="flex items-start gap-4">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Bot className="size-8" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-foreground">{actor.name}</h2>
              <Badge variant="secondary">{titleCase(actor.role)}</Badge>
              {actor.isActive === false ? <Badge variant="outline">Inactive</Badge> : null}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{actor.title || 'No title set'}</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Profile</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-5 text-sm">
              <div>
                <div className="mb-1 font-medium text-foreground">Role</div>
                <div className="text-muted-foreground">{titleCase(actor.role)}</div>
              </div>
              <div>
                <div className="mb-1 font-medium text-foreground">Title</div>
                <div className="text-muted-foreground">{actor.title || 'Not set'}</div>
              </div>
              <div>
                <div className="mb-2 font-medium text-foreground">Charter</div>
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {actor.charter?.trim() || 'No charter set for this actor yet.'}
                </p>
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Capabilities</CardTitle>
              </CardHeader>
              <CardContent>
                {actor.capabilities && actor.capabilities.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {actor.capabilities.map((capability) => (
                      <Badge key={capability} variant="outline">
                        {capability}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No capabilities listed.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Skills</CardTitle>
              </CardHeader>
              <CardContent>
                {actor.skills && actor.skills.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    {actor.skills.map((skill) => (
                      <div key={skill.name}>
                        <div className="font-medium text-foreground">{skill.name}</div>
                        {skill.description ? (
                          <p className="mt-1 text-sm text-muted-foreground">{skill.description}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No skills configured.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Status</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">State</span>
                  <span className="font-medium text-foreground">{actor.isActive === false ? 'Inactive' : 'Active'}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Created</span>
                  <span className="font-medium text-foreground">{formatDate(actor.createdAt)}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ContactsPage() {
  const { workspaceId } = useWorkspace();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId) return;
    const currentWorkspaceId = workspaceId;

    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const [memberResponse, actorResponse] = await Promise.all([
          api.getWorkspaceMembers(currentWorkspaceId),
          api.getActors(currentWorkspaceId),
        ]);

        if (cancelled) return;

        const nextMembers = Array.isArray(memberResponse)
          ? memberResponse
          : (memberResponse?.data || []);
        const nextActors = Array.isArray(actorResponse)
          ? actorResponse
          : (actorResponse?.actors || []);

        setMembers(nextMembers);
        setActors(nextActors);

        const firstSelectable = nextMembers[0]?.userId || nextActors[0]?.id || null;
        setSelectedId((current) => current ?? firstSelectable);
      } catch (error) {
        console.error('Failed to load contacts:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const filteredUsers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return members;
    return members.filter((member) => {
      const haystack = `${member.userName || ''} ${member.userEmail || ''} ${member.trustLevel || ''}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [members, search]);

  const filteredActors = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return actors;
    return actors.filter((actor) => {
      const haystack = `${actor.name || ''} ${actor.title || ''} ${actor.role || ''} ${actor.charter || ''}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [actors, search]);

  const selectedUser = members.find((member) => member.userId === selectedId) || null;
  const selectedActor = actors.find((actor) => actor.id === selectedId) || null;

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="flex w-[340px] shrink-0 min-h-0 flex-col border-r border-border bg-muted/20">
        <div className="border-b border-border px-4 py-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search contacts..."
              className="pl-9"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <p className="text-sm text-muted-foreground">Loading contacts...</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <div className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Users
                </div>
                {filteredUsers.length > 0 ? (
                  filteredUsers.map((member) => (
                    <ContactListItem
                      key={member.userId}
                      item={{
                        kind: 'user',
                        id: member.userId,
                        name: member.userName || 'Unknown user',
                        subtitle: member.userEmail || titleCase(member.trustLevel),
                        data: member,
                      }}
                      active={selectedId === member.userId}
                      onSelect={() => setSelectedId(member.userId)}
                    />
                  ))
                ) : (
                  <p className="px-1 text-sm text-muted-foreground">No users found.</p>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <div className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Actors
                </div>
                {filteredActors.length > 0 ? (
                  filteredActors.map((actor) => (
                    <ContactListItem
                      key={actor.id}
                      item={{
                        kind: 'actor',
                        id: actor.id,
                        name: actor.name,
                        subtitle: actor.title || titleCase(actor.role),
                        data: actor,
                      }}
                      active={selectedId === actor.id}
                      onSelect={() => setSelectedId(actor.id)}
                    />
                  ))
                ) : (
                  <p className="px-1 text-sm text-muted-foreground">No actors found.</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1 bg-background">
        {selectedUser ? (
          <UserDetail member={selectedUser} />
        ) : selectedActor ? (
          <ActorDetail actor={selectedActor} />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="max-w-sm">
              <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Users className="size-7" />
              </div>
              <h2 className="text-lg font-semibold text-foreground">No contact selected</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Choose a workspace user or actor from the list to view their details.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
