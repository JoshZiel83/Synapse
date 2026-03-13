'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { useAuthStore } from '@/stores/auth-store';
import { api } from '@/lib/api';
import { PluginIcon, ScopeBadge, getLocale, translate } from '../plugins/plugin-ui';

type GrantScope = 'platform' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';

const grantOptions: Array<{ value: GrantScope; label: string }> = [
  { value: 'platform', label: 'Platform' },
  { value: 'workspace', label: 'Workspace' },
  { value: 'conversation', label: 'Conversation' },
  { value: 'actor_global', label: 'Actor' },
  { value: 'actor_conversation', label: 'Actor + Conversation' },
  { value: 'user', label: 'User' },
];

function normalizeActorOption(actor: any) {
  const definition = actor?.definition || actor;
  return {
    id: actor.id,
    name: definition.name,
    title: definition.title,
    role: definition.role,
  };
}

export default function AuthorizationsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { workspaceId } = useWorkspace();
  const { user } = useAuthStore();
  const [installations, setInstallations] = useState<any[]>([]);
  const [actors, setActors] = useState<any[]>([]);
  const [conversations, setConversations] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [selectedBindingId, setSelectedBindingId] = useState<string | null>(searchParams.get('bindingId'));
  const [summary, setSummary] = useState<any>(null);
  const [grants, setGrants] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [grantScope, setGrantScope] = useState<GrantScope>('workspace');
  const [conversationId, setConversationId] = useState('');
  const [actorId, setActorId] = useState('');
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');

  const selectedInstallation = useMemo(
    () => installations.find((item) => item.id === selectedBindingId) || null,
    [installations, selectedBindingId],
  );
  const locale = useMemo(() => getLocale(selectedInstallation?.default_locale), [selectedInstallation?.default_locale]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;

    const load = async () => {
      try {
        setLoading(true);
        const [installedData, actorData, groupData, memberData] = await Promise.all([
          api.getInstallations(workspaceId),
          api.getActors(workspaceId),
          api.getGroups(workspaceId),
          api.getWorkspaceMembers(workspaceId),
        ]);
        if (cancelled) return;
        setInstallations(installedData);
        setActors(Array.isArray(actorData) ? actorData.map(normalizeActorOption) : []);
        setConversations(groupData.groups || []);
        setMembers(memberData.data || []);
        if (!selectedBindingId && installedData[0]?.id) {
          setSelectedBindingId(installedData[0].id);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || !selectedBindingId) {
      setSummary(null);
      setGrants([]);
      return;
    }
    let cancelled = false;

    const load = async () => {
      const [grantData, authData] = await Promise.all([
        api.getCapabilityGrants(workspaceId, selectedBindingId),
        api.getCapabilityAuthorization(workspaceId, selectedBindingId),
      ]);
      if (cancelled) return;
      setGrants(grantData.grants || []);
      setSummary(authData.summary || null);
      setGrantScope((authData.summary?.suggestedGrantScope as GrantScope | undefined) || 'workspace');
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [selectedBindingId, workspaceId]);

  useEffect(() => {
    if (selectedBindingId && searchParams.get('bindingId') !== selectedBindingId) {
      const params = new URLSearchParams(searchParams.toString());
      params.set('bindingId', selectedBindingId);
      router.replace(`/dashboard/authorizations?${params.toString()}`);
    }
  }, [router, searchParams, selectedBindingId]);

  const createGrant = async () => {
    if (!workspaceId || !selectedBindingId) return;
    setSaving(true);
    try {
      await api.issueCapabilityGrant(workspaceId, selectedBindingId, {
        grantScope,
        actorId: grantScope === 'actor_global' || grantScope === 'actor_conversation' ? actorId : undefined,
        conversationId: grantScope === 'conversation' || grantScope === 'actor_conversation' ? conversationId : undefined,
        userId: grantScope === 'user' ? userId || user?.id || user?.userId : undefined,
        permissions: summary?.requiredPermissions || [],
        reason: reason || undefined,
      });
      const [grantData, authData] = await Promise.all([
        api.getCapabilityGrants(workspaceId, selectedBindingId),
        api.getCapabilityAuthorization(workspaceId, selectedBindingId),
      ]);
      setGrants(grantData.grants || []);
      setSummary(authData.summary || null);
      setReason('');
    } finally {
      setSaving(false);
    }
  };

  const revokeGrant = async (grantId: string) => {
    if (!workspaceId || !selectedBindingId) return;
    await api.revokeCapabilityGrant(workspaceId, grantId);
    const [grantData, authData] = await Promise.all([
      api.getCapabilityGrants(workspaceId, selectedBindingId),
      api.getCapabilityAuthorization(workspaceId, selectedBindingId),
    ]);
    setGrants(grantData.grants || []);
    setSummary(authData.summary || null);
  };

  if (loading) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Loading authorizations...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Authorizations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage which installed capabilities are shared across users, actors, and conversations. This page will also power skills and memory later.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
        <section className="rounded-[28px] border border-gray-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-gray-900">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Installed capabilities</h2>
            <Badge variant="secondary" className="bg-gray-100 text-gray-700 dark:bg-white/5 dark:text-gray-300">
              {installations.length}
            </Badge>
          </div>
          <div className="space-y-2">
            {installations.map((installation) => {
              const active = installation.id === selectedBindingId;
              const title = translate(installation.plugin_display_name_i18n, locale, installation.default_locale || 'en') || installation.plugin_display_name;
              return (
                <button
                  key={installation.id}
                  type="button"
                  onClick={() => setSelectedBindingId(installation.id)}
                  className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition-colors ${
                    active
                      ? 'border-blue-500 bg-blue-50 dark:border-blue-500/60 dark:bg-blue-500/10'
                      : 'border-gray-200 hover:bg-gray-50 dark:border-white/10 dark:hover:bg-white/5'
                  }`}
                >
                  <PluginIcon iconUrl={installation.plugin_icon_url} title={title} transport={installation.transport} containerClassName="h-12 w-12 rounded-[16px]" className="h-5 w-5" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{title}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <ScopeBadge scope={installation.scope_type} />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="space-y-6">
          {selectedInstallation ? (
            <>
              <div className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-gray-900">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <PluginIcon
                      iconUrl={selectedInstallation.plugin_icon_url}
                      title={translate(selectedInstallation.plugin_display_name_i18n, locale, selectedInstallation.default_locale || 'en') || selectedInstallation.plugin_display_name}
                      transport={selectedInstallation.transport}
                      containerClassName="h-16 w-16 rounded-[20px]"
                      className="h-6 w-6"
                    />
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold text-foreground">
                          {translate(selectedInstallation.plugin_display_name_i18n, locale, selectedInstallation.default_locale || 'en') || selectedInstallation.plugin_display_name}
                        </h2>
                        <ScopeBadge scope={selectedInstallation.scope_type} />
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Required permissions: {(summary?.requiredPermissions || []).join(', ') || 'None'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <LinkToConfig installationId={selectedInstallation.id} />
                  </div>
                </div>
              </div>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-gray-900">
                  <div className="mb-4 flex items-center gap-2">
                    {summary?.isAuthorized ? <ShieldCheck className="h-5 w-5 text-green-500" /> : <ShieldOff className="h-5 w-5 text-amber-500" />}
                    <h3 className="text-lg font-semibold text-foreground">Current grants</h3>
                  </div>
                  <div className="space-y-3">
                    {grants.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-gray-300 p-6 text-sm text-muted-foreground dark:border-white/10">
                        No grants have been issued for this binding yet.
                      </div>
                    ) : (
                      grants.map((grant) => (
                        <div key={grant.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-200 p-4 dark:border-white/10">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <ScopeBadge scope={grant.grantScope} />
                              <Badge variant="outline" className="border-gray-200 text-gray-600 dark:border-white/10 dark:text-gray-300">
                                {grant.permissions.join(', ')}
                              </Badge>
                            </div>
                            {grant.reason ? <p className="text-sm text-muted-foreground">{grant.reason}</p> : null}
                          </div>
                          <Button variant="ghost" className="gap-2 text-red-500 hover:text-red-600" onClick={() => revokeGrant(grant.id)}>
                            <Trash2 className="h-4 w-4" />
                            Revoke
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-gray-900">
                  <h3 className="text-lg font-semibold text-foreground">Issue a new grant</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Installation ownership stays where it is. Grants decide which contexts can actually use it.
                  </p>

                  <div className="mt-5 space-y-4">
                    <div className="space-y-2">
                      <Label>Grant scope</Label>
                      <select
                        className="h-10 w-full rounded-md border border-gray-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-gray-900"
                        value={grantScope}
                        onChange={(event) => setGrantScope(event.target.value as GrantScope)}
                      >
                        {grantOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {(grantScope === 'conversation' || grantScope === 'actor_conversation') && (
                      <div className="space-y-2">
                        <Label>Conversation</Label>
                        <select
                          className="h-10 w-full rounded-md border border-gray-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-gray-900"
                          value={conversationId}
                          onChange={(event) => setConversationId(event.target.value)}
                        >
                          <option value="">Select conversation</option>
                          {conversations.map((conversation) => (
                            <option key={conversation.id} value={conversation.id}>
                              {conversation.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {(grantScope === 'actor_global' || grantScope === 'actor_conversation') && (
                      <div className="space-y-2">
                        <Label>Actor</Label>
                        <select
                          className="h-10 w-full rounded-md border border-gray-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-gray-900"
                          value={actorId}
                          onChange={(event) => setActorId(event.target.value)}
                        >
                          <option value="">Select actor</option>
                          {actors.map((actor) => (
                            <option key={actor.id} value={actor.id}>
                              {actor.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {grantScope === 'user' && (
                      <div className="space-y-2">
                        <Label>User</Label>
                        <select
                          className="h-10 w-full rounded-md border border-gray-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-gray-900"
                          value={userId}
                          onChange={(event) => setUserId(event.target.value)}
                        >
                          <option value="">Select user</option>
                          {members.map((member) => (
                            <option key={member.userId} value={member.userId}>
                              {member.userName || member.userEmail || member.userId}
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
                        placeholder={summary?.reason || 'Optional note describing why this grant is needed'}
                      />
                    </div>

                    <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 text-sm text-muted-foreground dark:border-white/10 dark:bg-white/5">
                      Effective permissions: {(summary?.effectivePermissions || []).join(', ') || 'None'}
                    </div>

                    <Button onClick={createGrant} disabled={saving || !selectedBindingId} className="w-full">
                      {saving ? 'Issuing grant...' : 'Issue grant'}
                    </Button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-[28px] border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-muted-foreground dark:border-white/10 dark:bg-gray-900">
              Select an installed capability to manage its grants.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function LinkToConfig({ installationId }: { installationId: string }) {
  return (
    <Button asChild variant="outline">
      <Link href={`/dashboard/plugins/installations/${installationId}`}>Open configuration</Link>
    </Button>
  );
}
