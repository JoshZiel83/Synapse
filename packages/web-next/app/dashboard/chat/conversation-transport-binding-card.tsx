'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Actor,
  ConversationTransportBindingSummary,
  TransportAccountInboundActorMode,
  TransportConversationInboundActorMode,
  TransportKind,
} from '@synapse/shared';
import { ArrowUpRight, Bot, Link2, MessageCircle, RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { API_BASE, api } from '@/lib/api';
import type { ConversationSummary } from '@/stores/chat-store';

interface ConversationTransportBindingCardProps {
  workspaceId: string;
  conversation: ConversationSummary;
  compact?: boolean;
}

function prettyTransportKind(kind: TransportKind) {
  return kind === 'feishu' ? 'Feishu' : 'WeChat';
}

function prettyEndpointType(endpointType: 'direct' | 'group') {
  return endpointType === 'group' ? 'Group chat' : 'Direct chat';
}

function prettyConnectionMode(mode: 'webhook' | 'long_connection') {
  return mode === 'webhook' ? 'Webhook' : 'Long connection';
}

function prettyAccountInboundActorMode(mode: TransportAccountInboundActorMode) {
  switch (mode) {
    case 'follow_owner_chief_actor':
      return 'Follow owner chief actor';
    case 'specified_actor':
      return 'Specific actor';
    default:
      return 'No default actor';
  }
}

function prettySessionInboundActorMode(mode: TransportConversationInboundActorMode) {
  switch (mode) {
    case 'inherit_account':
      return 'Follow binding setting';
    case 'specified_actor':
      return 'Specific actor';
    default:
      return 'No default actor';
  }
}

function buildWebhookUrl(accountId: string) {
  if (typeof window === 'undefined') return '';
  try {
    return new URL(
      `${API_BASE}/im/public/feishu/accounts/${accountId}/webhook`,
      window.location.origin,
    ).toString();
  } catch {
    return '';
  }
}

export default function ConversationTransportBindingCard({
  workspaceId,
  conversation,
  compact = false,
}: ConversationTransportBindingCardProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [binding, setBinding] = useState<ConversationTransportBindingSummary | null>(null);
  const [actors, setActors] = useState<Actor[]>([]);

  const actorById = useMemo(
    () =>
      new Map(
        actors
          .filter((actor) => actor.isActive)
          .map((actor) => [actor.id, actor.definition.name]),
      ),
    [actors],
  );

  const bindingInboundActorLabel = useMemo(() => {
    if (!binding) return null;
    if (binding.inboundActorMode === 'specified_actor') {
      return (
        (binding.inboundActorId ? actorById.get(binding.inboundActorId) : null) ||
        binding.inboundActorId ||
        'Unknown actor'
      );
    }
    return prettySessionInboundActorMode(binding.inboundActorMode);
  }, [actorById, binding]);

  const accountInboundActorLabel = useMemo(() => {
    if (!binding) return null;
    if (binding.account.inboundActorMode === 'specified_actor') {
      return (
        (binding.account.inboundActorId
          ? actorById.get(binding.account.inboundActorId)
          : null) ||
        binding.account.inboundActorId ||
        'Unknown actor'
      );
    }
    return prettyAccountInboundActorMode(binding.account.inboundActorMode);
  }, [actorById, binding]);

  const webhookUrl =
    binding?.transportKind === 'feishu' && binding.account.connectionMode === 'webhook'
      ? buildWebhookUrl(binding.account.id)
      : '';

  const loadBinding = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bindingResult, actorsResult] = await Promise.all([
        api.getThreadTransportBinding(workspaceId, conversation.id),
        api.getActors(workspaceId).catch((loadError) => {
          console.error('Failed to load actors for IM binding card:', loadError);
          return [];
        }),
      ]);
      setBinding(bindingResult?.binding || null);
      setActors(Array.isArray(actorsResult) ? (actorsResult as Actor[]) : []);
    } catch (loadError) {
      console.error('Failed to load conversation transport binding:', loadError);
      setError(loadError instanceof Error ? loadError.message : 'Failed to load IM session');
    } finally {
      setLoading(false);
    }
  }, [conversation.id, workspaceId]);

  useEffect(() => {
    void loadBinding();
  }, [loadBinding]);

  return (
    <Card className={compact ? 'border-dashed bg-background/70' : undefined}>
      <CardHeader className={compact ? 'pb-3' : undefined}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="size-4" />
              IM Session
            </CardTitle>
            <CardDescription className="mt-1">
              This conversation may be linked to an automatically created IM session.
              Routing and external-user mapping are managed from the workspace IM page.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard/im">
              Open IM
              <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="size-4 animate-spin" />
            Loading IM session...
          </div>
        ) : null}

        {!loading && !binding ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/30 px-4 py-4 text-sm text-muted-foreground">
            This conversation is internal only. WeChat direct chats and Feishu direct
            or group chats create their own conversations on inbound sync instead of
            attaching to an existing conversation.
          </div>
        ) : null}

        {binding ? (
          <>
            <div className="grid gap-3 rounded-2xl border bg-muted/30 p-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{prettyTransportKind(binding.transportKind)}</Badge>
                  <Badge variant="outline">
                    {prettyEndpointType(binding.endpoint.endpointType)}
                  </Badge>
                  <Badge variant="outline">
                    {prettyConnectionMode(binding.account.connectionMode)}
                  </Badge>
                  <Badge variant="outline">
                    {binding.outboundEnabled ? 'outbound on' : 'outbound off'}
                  </Badge>
                  {binding.metadata?.autoCreated ? (
                    <Badge variant="outline">Auto created</Badge>
                  ) : null}
                </div>
                <div className="text-sm font-medium text-foreground">
                  {binding.endpoint.displayName ||
                    binding.account.displayName ||
                    binding.endpoint.externalId}
                </div>
                <div className="text-xs text-muted-foreground">
                  Endpoint: {binding.endpoint.externalId}
                </div>
                <div className="text-xs text-muted-foreground">
                  Account: {binding.account.displayName}
                </div>
                <div className="text-xs text-muted-foreground">
                  Session inbound actor:{' '}
                  <span className="text-foreground">{bindingInboundActorLabel || 'None'}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Binding inbound actor:{' '}
                  <span className="text-foreground">{accountInboundActorLabel || 'None'}</span>
                </div>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MessageCircle className="size-4" />
                  One external session maps to one conversation
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Bot className="size-4" />
                  Outbound delivery only happens when a message explicitly targets a
                  participant that is reachable in this session
                </div>
                {webhookUrl ? (
                  <div className="rounded-xl bg-background px-3 py-2 text-xs text-muted-foreground">
                    Webhook URL: <span className="break-all text-foreground">{webhookUrl}</span>
                  </div>
                ) : null}
                <div className="rounded-xl bg-background px-3 py-2 text-xs text-muted-foreground">
                  External user mapping and session routing are managed in{' '}
                  <span className="text-foreground">Dashboard / IM</span>.
                </div>
              </div>
            </div>
          </>
        ) : null}

        {error ? <div className="text-sm text-destructive">{error}</div> : null}
      </CardContent>
    </Card>
  );
}
