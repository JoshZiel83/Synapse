'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  CapabilityAccessTarget,
  CapabilityAccessTargetType,
} from '@synapse/shared/types';
import { Bot, Plus, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { getConversationDisplayName } from '@/app/dashboard/access/attachment-visuals';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { api } from '@/lib/api';

type PluginGrantScope = CapabilityAccessTargetType;

const allowedGrantScopes: PluginGrantScope[] = [
  'workspace',
  'conversation',
  'actor',
  'actor_in_conversation',
];

function buildGrantScopeOptions(resourceLabel: string): Array<{
  value: PluginGrantScope;
  label: string;
  description: string;
}> {
  return [
    {
      value: 'workspace',
      label: 'Workspace',
      description: `Anyone in this workspace can use this ${resourceLabel}.`,
    },
    {
      value: 'conversation',
      label: 'Conversation',
      description: `Only one conversation can use this ${resourceLabel}, across every workspace participating in it.`,
    },
    {
      value: 'actor',
      label: 'Actor',
      description: `Only one actor can use this ${resourceLabel} anywhere it appears.`,
    },
    {
      value: 'actor_in_conversation',
      label: 'Actor in Conversation',
      description: `Only one actor can use this ${resourceLabel} inside one conversation.`,
    },
  ];
}

const PREVIEW_PRIMARY_USER = 'Maya';
const PREVIEW_SECONDARY_USER = 'Iris';
const PREVIEW_PRIMARY_ACTOR = 'Nova';
const PREVIEW_SECONDARY_ACTOR = 'Atlas';
const PREVIEW_CONVERSATION = 'Project Sync';

type ActorOption = {
  id: string;
  name: string;
};

type ConversationOption = {
  id: string;
  name: string;
  title?: string;
  participants?: Array<{ id: string; name: string }>;
};

type AccessPreviewScenario = {
  title: string;
  subtitle: string;
  identities: Array<{ label: string; kind: 'user' | 'actor'; active: boolean }>;
  userMessage: string;
  actorName: string;
  actorMessage: string;
  secondaryActorName: string;
  secondaryActorMessage: string;
  secondaryActorActive: boolean;
  footer: string;
};

type AccessAdapter = {
  loadAccess: (workspaceId: string, resourceId: string) => Promise<any>;
  grantAccess: (
    workspaceId: string,
    resourceId: string,
    payload: {
      accessTarget?: CapabilityAccessTarget;
      permissions?: string[];
    },
  ) => Promise<unknown>;
  revokeAccess: (
    workspaceId: string,
    resourceId: string,
    grantId: string,
  ) => Promise<unknown>;
};

const pluginInstallationAccessAdapter: AccessAdapter = {
  loadAccess: (workspaceId, resourceId) =>
    api.getPluginInstallationAccess(workspaceId, resourceId),
  grantAccess: (workspaceId, resourceId, payload) =>
    api.grantPluginInstallationAccess(workspaceId, resourceId, payload),
  revokeAccess: (workspaceId, resourceId, grantId) =>
    api.revokePluginInstallationAccess(workspaceId, resourceId, grantId),
};

function normalizeActorOption(actor: any): ActorOption {
  const definition = actor?.definition || actor;
  return {
    id: actor.id,
    name: definition.name || definition.title || 'Untitled actor',
  };
}

function normalizeConversationOption(group: any): ConversationOption {
  return {
    id: group.id,
    name: group.name || group.title || 'Untitled conversation',
    title: group.title,
    participants: group.participants,
  };
}

function getScopeLabel(scope: PluginGrantScope) {
  switch (scope) {
    case 'workspace':
      return 'Workspace';
    case 'conversation':
      return 'Conversation';
    case 'actor':
      return 'Actor';
    case 'actor_in_conversation':
      return 'Actor in Conversation';
    default:
      return scope;
  }
}

function formatGrantTarget(
  grant: any,
  actorsById: Map<string, string>,
  conversationsById: Map<string, string>,
) {
  const target = grant.target;
  switch (target?.type) {
    case 'workspace':
      return 'Entire workspace';
    case 'conversation':
      return conversationsById.get(target.conversationId) || 'Selected conversation';
    case 'actor':
      return actorsById.get(target.actorId) || 'Selected actor';
    case 'actor_in_conversation': {
      const actorName = actorsById.get(target.actorId) || 'Selected actor';
      const conversationName =
        conversationsById.get(target.conversationId) || 'Selected conversation';
      return `${actorName} in ${conversationName}`;
    }
    default:
      return 'Selected target';
  }
}

function formatTimestamp(value?: string | null) {
  if (!value) return 'Just now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Just now';
  return date.toLocaleString();
}

function IdentityPill({
  label,
  kind,
  active,
}: {
  label: string;
  kind: 'user' | 'actor';
  active: boolean;
}) {
  const Icon = kind === 'user' ? UserRound : Bot;

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground">
      <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-3" />
      </span>
      <span className="truncate">{label}</span>
      <span
        className={
          active
            ? 'rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300'
            : 'rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground'
        }
      >
        {active ? 'Can use' : 'Blocked'}
      </span>
    </div>
  );
}

function AccessPreviewCard({
  scenario,
  selectedTarget,
}: {
  scenario: AccessPreviewScenario;
  selectedTarget: string;
}) {
  return (
    <div className="overflow-hidden rounded-[26px] border border-border bg-background shadow-sm">
      <div className="border-b border-border bg-muted/30 px-4 py-4">
        <div className="flex flex-col gap-1">
          <div className="text-sm font-semibold text-foreground">{scenario.title}</div>
          <div className="text-xs text-muted-foreground">{scenario.subtitle}</div>
          <div className="text-xs text-muted-foreground">Selected target: {selectedTarget}</div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {scenario.identities.map((identity) => (
            <IdentityPill
              key={`${identity.kind}-${identity.label}-${identity.active ? 'on' : 'off'}`}
              label={identity.label}
              kind={identity.kind}
              active={identity.active}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-foreground px-3 py-2 text-sm text-background">
            {scenario.userMessage}
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div className="mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/12 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
            {scenario.actorName.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-muted-foreground">{scenario.actorName}</div>
            <div className="rounded-2xl rounded-tl-sm border border-border bg-muted/20 px-3 py-2 text-sm text-foreground">
              {scenario.actorMessage}
            </div>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div
            className={
              scenario.secondaryActorActive
                ? 'mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/12 text-xs font-semibold text-emerald-700 dark:text-emerald-300'
                : 'mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground'
            }
          >
            {scenario.secondaryActorName.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-muted-foreground">{scenario.secondaryActorName}</div>
            <div
              className={
                scenario.secondaryActorActive
                  ? 'rounded-2xl rounded-tl-sm border border-border bg-muted/20 px-3 py-2 text-sm text-foreground'
                  : 'rounded-2xl rounded-tl-sm border border-dashed border-border bg-muted/10 px-3 py-2 text-sm text-muted-foreground'
              }
            >
              {scenario.secondaryActorMessage}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PluginAccessStep({
  installation,
  resourceId,
  accessAdapter = pluginInstallationAccessAdapter,
  resourceLabel = 'installation',
  title = 'Access',
  description,
  addAccessLabel = 'Add Access',
  emptyMessage,
  dialogTitle = 'Add use access',
  dialogDescription,
  noAccessMessage = 'No use access has been granted yet.',
}: {
  installation: any | null;
  resourceId?: string | null;
  accessAdapter?: AccessAdapter;
  resourceLabel?: string;
  title?: string;
  description?: string;
  addAccessLabel?: string;
  emptyMessage?: string;
  dialogTitle?: string;
  dialogDescription?: string;
  noAccessMessage?: string;
}) {
  const { workspaceId } = useWorkspace();
  const [actors, setActors] = useState<any[]>([]);
  const [conversations, setConversations] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [grants, setGrants] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [grantScope, setGrantScope] = useState<PluginGrantScope>('workspace');
  const [conversationId, setConversationId] = useState('');
  const [actorId, setActorId] = useState('');

  const resolvedResourceId = resourceId || installation?.id || null;
  const resourceLabelLower = resourceLabel.toLowerCase();
  const resolvedDescription =
    description || `Choose who can use this ${resourceLabelLower}. Ownership and lifecycle stay in Advanced.`;
  const resolvedEmptyMessage =
    emptyMessage || `Finish setup first. Once the ${resourceLabelLower} exists, you can grant use access here.`;
  const resolvedDialogDescription =
    dialogDescription || `Choose who can use this ${resourceLabelLower}. Ownership stays where it is.`;

  const grantScopeOptions = useMemo(
    () => buildGrantScopeOptions(resourceLabelLower),
    [resourceLabelLower],
  );
  const actorOptions = useMemo(() => actors.map(normalizeActorOption), [actors]);
  const conversationOptions = useMemo(() => conversations.map(normalizeConversationOption), [conversations]);

  const actorNamesById = useMemo(
    () => new Map(actorOptions.map((actor) => [actor.id, actor.name])),
    [actorOptions],
  );
  const conversationNamesById = useMemo(
    () =>
      new Map(
        conversationOptions.map((conversation) => [
          conversation.id,
          getConversationDisplayName(conversation),
        ]),
      ),
    [conversationOptions],
  );

  const selectedScopeOption = useMemo(
    () => grantScopeOptions.find((option) => option.value === grantScope) || grantScopeOptions[0],
    [grantScope],
  );

  const previewTarget = useMemo(() => {
    if (grantScope === 'workspace') {
      return 'The entire workspace';
    }
    if (grantScope === 'conversation') {
      return conversationId ? 'The conversation you selected on the left' : 'Choose a conversation on the left';
    }
    if (grantScope === 'actor') {
      return actorId ? 'The actor you selected on the left' : 'Choose an actor on the left';
    }
    if (grantScope === 'actor_in_conversation') {
      return actorId && conversationId
        ? 'The actor + conversation pair you selected on the left'
        : 'Choose one actor and one conversation on the left';
    }
    return getScopeLabel(grantScope);
  }, [actorId, conversationId, grantScope]);

  const previewScenario = useMemo<AccessPreviewScenario>(() => {
    switch (grantScope) {
      case 'workspace':
        return {
          title: 'Workspace planning room',
          subtitle: 'Shared with the whole workspace',
          identities: [
            { label: PREVIEW_PRIMARY_USER, kind: 'user', active: true },
            { label: PREVIEW_SECONDARY_USER, kind: 'user', active: true },
            { label: PREVIEW_PRIMARY_ACTOR, kind: 'actor', active: true },
            { label: PREVIEW_SECONDARY_ACTOR, kind: 'actor', active: true },
          ],
          userMessage: `${PREVIEW_PRIMARY_USER}: Can someone pull the latest roadmap notes for this workspace?`,
          actorName: PREVIEW_PRIMARY_ACTOR,
          actorMessage:
            `Yes. This ${resourceLabelLower} is shared with the workspace, so actors can use it from any workspace conversation.`,
          secondaryActorName: PREVIEW_SECONDARY_ACTOR,
          secondaryActorMessage:
            `I can use it too, because workspace access does not limit this ${resourceLabelLower} to one room or one actor.`,
          secondaryActorActive: true,
          footer: `Best when this ${resourceLabelLower} should feel like shared workspace infrastructure.`,
        };
      case 'conversation':
        return {
          title: PREVIEW_CONVERSATION,
          subtitle: 'Only this conversation can use it',
          identities: [
            { label: PREVIEW_PRIMARY_USER, kind: 'user', active: true },
            { label: PREVIEW_SECONDARY_USER, kind: 'user', active: true },
            { label: PREVIEW_PRIMARY_ACTOR, kind: 'actor', active: true },
            { label: PREVIEW_SECONDARY_ACTOR, kind: 'actor', active: true },
          ],
          userMessage: `${PREVIEW_PRIMARY_USER}: Use this ${resourceLabelLower} for the notes in this room only.`,
          actorName: PREVIEW_PRIMARY_ACTOR,
          actorMessage:
            `I can use it here because access is tied to this conversation. Other conversations still will not see this ${resourceLabelLower}.`,
          secondaryActorName: PREVIEW_SECONDARY_ACTOR,
          secondaryActorMessage:
            `I can use it too, but only inside this same conversation with this ${resourceLabelLower}.`,
          secondaryActorActive: true,
          footer: `Useful when one shared room needs this ${resourceLabelLower} and every participant in that conversation should be able to use it.`,
        };
      case 'actor':
        return {
          title: `Any thread with ${PREVIEW_PRIMARY_ACTOR}`,
          subtitle: 'Only this actor can use it',
          identities: [
            { label: PREVIEW_PRIMARY_USER, kind: 'user', active: true },
            { label: PREVIEW_SECONDARY_USER, kind: 'user', active: true },
            { label: PREVIEW_PRIMARY_ACTOR, kind: 'actor', active: true },
            { label: PREVIEW_SECONDARY_ACTOR, kind: 'actor', active: false },
          ],
          userMessage: `${PREVIEW_PRIMARY_USER}: @${PREVIEW_PRIMARY_ACTOR} check the vendor workspace with this install.`,
          actorName: PREVIEW_PRIMARY_ACTOR,
          actorMessage:
            `I can use this ${resourceLabelLower} anywhere I appear, but other actors in the same conversation still cannot.`,
          secondaryActorName: PREVIEW_SECONDARY_ACTOR,
          secondaryActorMessage:
            `I am in the same room, but I still cannot use this ${resourceLabelLower} because access belongs only to the selected actor.`,
          secondaryActorActive: false,
          footer: `Good when one actor owns this ${resourceLabelLower} across every conversation it joins.`,
        };
      case 'actor_in_conversation':
        return {
          title: `${PREVIEW_PRIMARY_ACTOR} in ${PREVIEW_CONVERSATION}`,
          subtitle: 'Only this actor in this conversation can use it',
          identities: [
            { label: PREVIEW_PRIMARY_USER, kind: 'user', active: true },
            { label: PREVIEW_SECONDARY_USER, kind: 'user', active: true },
            { label: PREVIEW_PRIMARY_ACTOR, kind: 'actor', active: true },
            { label: PREVIEW_SECONDARY_ACTOR, kind: 'actor', active: false },
          ],
          userMessage: `${PREVIEW_PRIMARY_USER}: @${PREVIEW_PRIMARY_ACTOR} use this install for this room's follow-up.`,
          actorName: PREVIEW_PRIMARY_ACTOR,
          actorMessage:
            `I can use this ${resourceLabelLower} here, but not in other conversations and not for other actors in this room.`,
          secondaryActorName: PREVIEW_SECONDARY_ACTOR,
          secondaryActorMessage:
            `I cannot use this ${resourceLabelLower} here, because this grant is restricted to one actor and one conversation together.`,
          secondaryActorActive: false,
          footer: 'This is the narrowest option when both the actor and the room matter.',
        };
      default:
        return {
          title: previewTarget,
          subtitle: selectedScopeOption.description,
          identities: [
            { label: PREVIEW_PRIMARY_USER, kind: 'user', active: true },
            { label: PREVIEW_SECONDARY_USER, kind: 'user', active: false },
            { label: PREVIEW_PRIMARY_ACTOR, kind: 'actor', active: true },
            { label: PREVIEW_SECONDARY_ACTOR, kind: 'actor', active: false },
          ],
          userMessage: `${PREVIEW_PRIMARY_USER}: Use this ${resourceLabelLower} here.`,
          actorName: PREVIEW_PRIMARY_ACTOR,
          actorMessage: `${previewTarget} will be able to use this ${resourceLabelLower}.`,
          secondaryActorName: PREVIEW_SECONDARY_ACTOR,
          secondaryActorMessage: 'This second actor is outside the selected grant target.',
          secondaryActorActive: false,
          footer: 'This only grants use access.',
        };
    }
  }, [
    grantScope,
    previewTarget,
    resourceLabelLower,
    selectedScopeOption.description,
  ]);

  const canCreateGrant = useMemo(() => {
    if (grantScope === 'conversation') return Boolean(conversationId);
    if (grantScope === 'actor') return Boolean(actorId);
    if (grantScope === 'actor_in_conversation') return Boolean(actorId && conversationId);
    return true;
  }, [actorId, conversationId, grantScope]);

  const loadAccessState = async () => {
    if (!workspaceId || !resolvedResourceId) return;
    const [accessData, actorData, conversationData] = await Promise.all([
      accessAdapter.loadAccess(workspaceId, resolvedResourceId),
      api.getActors(workspaceId),
      api.getThreads(workspaceId),
    ]);

    setGrants(accessData.grants || []);
    setSummary(accessData.summary || null);
    const suggestedGrantScope = accessData.summary?.suggestedAccessTargetType as PluginGrantScope | undefined;
    if (suggestedGrantScope && allowedGrantScopes.includes(suggestedGrantScope)) {
      setGrantScope(suggestedGrantScope);
    }
    setActors(Array.isArray(actorData) ? actorData : actorData?.actors || []);
    setConversations(conversationData?.conversations || []);
  };

  useEffect(() => {
    if (!workspaceId || !resolvedResourceId) {
      setSummary(null);
      setGrants([]);
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        setLoading(true);
        await loadAccessState();
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [accessAdapter, resolvedResourceId, workspaceId]);

  const resetDialogState = () => {
    setConversationId('');
    setActorId('');
  };

  const createGrant = async () => {
    if (!workspaceId || !resolvedResourceId || !canCreateGrant) return;
    setSaving(true);
    try {
      await accessAdapter.grantAccess(workspaceId, resolvedResourceId, {
        accessTarget: {
          type: grantScope,
          actorId: grantScope === 'actor' || grantScope === 'actor_in_conversation' ? actorId : undefined,
          conversationId:
            grantScope === 'conversation' || grantScope === 'actor_in_conversation'
              ? conversationId
              : undefined,
        },
        permissions: summary?.requiredPermissions?.length ? summary.requiredPermissions : ['use'],
      });
      await loadAccessState();
      setDialogOpen(false);
      resetDialogState();
    } finally {
      setSaving(false);
    }
  };

  const revokeGrant = async (grantId: string) => {
    if (!workspaceId || !resolvedResourceId) return;
    await accessAdapter.revokeAccess(workspaceId, resolvedResourceId, grantId);
    await loadAccessState();
  };

  const renderTargetSelector = () => {
    if (grantScope === 'workspace') return null;

    if (grantScope === 'conversation') {
      return (
        <Field>
          <FieldLabel>Conversation</FieldLabel>
          <Select value={conversationId} onValueChange={setConversationId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a conversation" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {conversationOptions.map((conversation) => (
                  <SelectItem key={conversation.id} value={conversation.id}>
                    {getConversationDisplayName(conversation)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      );
    }

    if (grantScope === 'actor') {
      return (
        <Field>
          <FieldLabel>Actor</FieldLabel>
          <Select value={actorId} onValueChange={setActorId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select an actor" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {actorOptions.map((actor) => (
                  <SelectItem key={actor.id} value={actor.id}>
                    {actor.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      );
    }

    if (grantScope === 'actor_in_conversation') {
      return (
        <FieldGroup>
          <Field>
            <FieldLabel>Conversation</FieldLabel>
            <Select value={conversationId} onValueChange={setConversationId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a conversation" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {conversationOptions.map((conversation) => (
                    <SelectItem key={conversation.id} value={conversation.id}>
                      {getConversationDisplayName(conversation)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel>Actor</FieldLabel>
            <Select value={actorId} onValueChange={setActorId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select an actor" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {actorOptions.map((actor) => (
                    <SelectItem key={actor.id} value={actor.id}>
                      {actor.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
      );
    }

    return null;
  };

  if (!resolvedResourceId) {
    return (
      <Card className="rounded-[28px]">
          <CardContent className="p-6 text-sm text-muted-foreground">
          {resolvedEmptyMessage}
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card className="rounded-[28px]">
        <CardContent className="p-6 text-sm text-muted-foreground">
          Loading access settings...
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="rounded-[28px]">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-muted-foreground" />
              <div className="space-y-1">
                <CardTitle>{title}</CardTitle>
                <CardDescription>{resolvedDescription}</CardDescription>
              </div>
            </div>
            <Button onClick={() => setDialogOpen(true)}>
              <Plus data-icon="inline-start" />
              {addAccessLabel}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-6">Type</TableHead>
                <TableHead>Who Can Use It</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-[96px] px-6 text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grants.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="px-6 py-8 text-sm text-muted-foreground">
                    {noAccessMessage}
                  </TableCell>
                </TableRow>
              ) : (
                grants.map((grant) => (
                  <TableRow key={grant.id}>
                    <TableCell className="px-6 font-medium">
                      {getScopeLabel(grant.target?.type || 'workspace')}
                    </TableCell>
                    <TableCell className="max-w-0">
                      <div className="truncate">
                        {formatGrantTarget(grant, actorNamesById, conversationNamesById)}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimestamp(grant.createdAt || grant.grantedAt)}
                    </TableCell>
                    <TableCell className="px-6 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => revokeGrant(grant.id)}
                      >
                        <Trash2 />
                        <span className="sr-only">Remove access</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            resetDialogState();
          }
        }}
      >
        <DialogContent className="sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{resolvedDialogDescription}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
            <div className="flex flex-col gap-5">
              <RadioGroup
                value={grantScope}
                onValueChange={(value) => setGrantScope(value as PluginGrantScope)}
                className="w-full"
              >
                {grantScopeOptions.map((option) => (
                  <Field
                    key={option.value}
                    orientation="horizontal"
                    className="rounded-3xl border border-border p-4"
                  >
                    <RadioGroupItem value={option.value} id={`access-scope-${option.value}`} />
                    <FieldContent>
                      <FieldLabel htmlFor={`access-scope-${option.value}`}>{option.label}</FieldLabel>
                      <FieldDescription>{option.description}</FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </RadioGroup>

              {renderTargetSelector()}
            </div>

            <div className="rounded-3xl border border-border bg-muted/20 p-5">
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-1">
                  <h3 className="text-base font-medium">{selectedScopeOption.label} preview</h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedScopeOption.description}
                  </p>
                </div>

                <AccessPreviewCard scenario={previewScenario} selectedTarget={previewTarget} />

                <div className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                  {previewScenario.footer}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createGrant} disabled={saving || !canCreateGrant}>
              {saving ? 'Adding access...' : 'Add Access'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
