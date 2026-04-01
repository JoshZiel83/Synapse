'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  AccessTargetType,
  AttachmentTargetType,
  ReuseScope,
} from '@synapse/shared';
import {
  Activity,
  Bot,
  Briefcase,
  Layers3,
  MessageSquareText,
  Repeat2,
  UserRound,
  Workflow,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export type AccessVisualActor = {
  id: string;
  name: string;
  role?: string;
};

export type AccessVisualConversation = {
  id: string;
  name?: string;
  title?: string;
  participants?: Array<{ id: string; name: string }>;
};

export type AccessVisualUser = {
  id: string;
  name: string;
};

type ScopeOptionDef<T extends string> = {
  value: T;
  label: string;
  shortLabel: string;
  hint: string;
  icon: typeof Briefcase;
  tone: string;
  ring: string;
};

type ReuseOptionDef = {
  value: ReuseScope;
  label: string;
  hint: string;
  icon: typeof Workflow;
  tone: string;
  ring: string;
  lineClassName: string;
};

type FakeConversationPreview = {
  id: string;
  name: string;
  includesCurrentUser: boolean;
  users: string[];
  actors: string[];
  singleRealUser: boolean;
};

type FakeLifecycleCall = {
  id: string;
  conversationId: string;
  conversationName: string;
  users: string[];
  includesCurrentUser: boolean;
  singleRealUser: boolean;
  actorName: string;
  userPrompt: string;
  actorReply: string;
};

type FakeLifecycleNode = FakeLifecycleCall & {
  available: boolean;
  instance: { key: string; label: string } | null;
};

export const attachmentTypeOptionDefs: ScopeOptionDef<AttachmentTargetType>[] = [
  {
    value: 'workspace',
    label: 'Workspace Owner',
    shortLabel: 'Workspace',
    hint: 'Belongs to the workspace',
    icon: Briefcase,
    tone: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200',
    ring: 'ring-sky-500/20',
  },
  {
    value: 'conversation',
    label: 'Conversation Owner',
    shortLabel: 'Conversation',
    hint: 'Belongs to one conversation',
    icon: MessageSquareText,
    tone: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-500/20 dark:bg-orange-500/10 dark:text-orange-200',
    ring: 'ring-orange-500/20',
  },
  {
    value: 'actor',
    label: 'Actor Owner',
    shortLabel: 'Actor',
    hint: 'Belongs to one actor',
    icon: Bot,
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200',
    ring: 'ring-emerald-500/20',
  },
  {
    value: 'workspace_member',
    label: 'Workspace Member Owner',
    shortLabel: 'Workspace Member',
    hint: 'Belongs to one workspace user',
    icon: UserRound,
    tone: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-500/20 dark:bg-fuchsia-500/10 dark:text-fuchsia-200',
    ring: 'ring-fuchsia-500/20',
  },
];

const accessTypeOptionDefs: ScopeOptionDef<AccessTargetType>[] = [
  {
    value: 'workspace',
    label: 'Workspace Access',
    shortLabel: 'Workspace',
    hint: 'Anyone in this workspace can use this installation',
    icon: Briefcase,
    tone: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200',
    ring: 'ring-sky-500/20',
  },
  {
    value: 'conversation_workspace',
    label: 'Conversation Workspace Access',
    shortLabel: 'Conversation Workspace',
    hint: 'Only this workspace side of one conversation can use this installation',
    icon: MessageSquareText,
    tone: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-500/20 dark:bg-orange-500/10 dark:text-orange-200',
    ring: 'ring-orange-500/20',
  },
  {
    value: 'actor',
    label: 'Actor Access',
    shortLabel: 'Actor',
    hint: 'Only one actor can use this installation',
    icon: Bot,
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200',
    ring: 'ring-emerald-500/20',
  },
  {
    value: 'actor_conversation',
    label: 'Actor + Conversation Access',
    shortLabel: 'Actor + Conversation',
    hint: 'Only one actor can use this installation in one conversation',
    icon: Layers3,
    tone: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200',
    ring: 'ring-amber-500/20',
  },
  {
    value: 'workspace_member',
    label: 'Workspace Member Access',
    shortLabel: 'Workspace Member',
    hint: 'Only one workspace user can use this installation personally',
    icon: UserRound,
    tone: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-500/20 dark:bg-fuchsia-500/10 dark:text-fuchsia-200',
    ring: 'ring-fuchsia-500/20',
  },
];

const reuseOptionDefs: ReuseOptionDef[] = [
  {
    value: 'turn',
    label: 'Turn',
    hint: 'A fresh runtime for every call',
    icon: Activity,
    tone: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200',
    ring: 'ring-slate-500/10',
    lineClassName: 'stroke-slate-400',
  },
  {
    value: 'session',
    label: 'Session',
    hint: 'Reuse for one actor in one conversation',
    icon: Layers3,
    tone: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200',
    ring: 'ring-amber-500/20',
    lineClassName: 'stroke-amber-400',
  },
  {
    value: 'workspace',
    label: 'Workspace',
    hint: 'One shared runtime for the workspace',
    icon: Briefcase,
    tone: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200',
    ring: 'ring-sky-500/20',
    lineClassName: 'stroke-sky-400',
  },
  {
    value: 'conversation',
    label: 'Conversation',
    hint: 'One runtime per conversation',
    icon: MessageSquareText,
    tone: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-500/20 dark:bg-orange-500/10 dark:text-orange-200',
    ring: 'ring-orange-500/20',
    lineClassName: 'stroke-orange-400',
  },
  {
    value: 'actor',
    label: 'Actor',
    hint: 'One runtime per actor',
    icon: Repeat2,
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200',
    ring: 'ring-emerald-500/20',
    lineClassName: 'stroke-emerald-400',
  },
];

const lifecycleOptionMap: Record<AttachmentTargetType, ReuseScope[]> = {
  workspace: ['turn', 'session', 'conversation', 'actor', 'workspace'],
  conversation: ['turn', 'session', 'conversation', 'actor', 'workspace'],
  actor: ['turn', 'session', 'conversation', 'actor', 'workspace'],
  workspace_member: ['turn', 'session', 'conversation', 'actor', 'workspace'],
};

export function getAllowedReuseScopes(attachmentType: AttachmentTargetType) {
  const allowedScopes = new Set(lifecycleOptionMap[attachmentType] || ['turn']);
  return reuseOptionDefs
    .map((option) => option.value)
    .filter((scope) => allowedScopes.has(scope));
}

export function getConversationDisplayName(conversation: AccessVisualConversation | null | undefined) {
  if (!conversation) return 'Untitled conversation';
  if (conversation.name && conversation.name.trim()) return conversation.name;
  if (conversation.title && conversation.title.trim()) return conversation.title;
  const participantNames = (conversation.participants || [])
    .map((participant) => participant.name)
    .filter(Boolean);
  if (participantNames.length > 0) return participantNames.join(', ');
  return 'Untitled conversation';
}

function getScopeOption(scope: AttachmentTargetType) {
  return attachmentTypeOptionDefs.find((option) => option.value === scope) || attachmentTypeOptionDefs[0];
}

function getReuseOption(scope: ReuseScope) {
  return reuseOptionDefs.find((option) => option.value === scope) || reuseOptionDefs[0];
}

function pickAlternativeActorName(
  primaryActorName: string,
  actors: AccessVisualActor[],
  fallbackName: string,
) {
  const candidate = actors.find((actor) => actor.name && actor.name !== primaryActorName)?.name;
  if (candidate) return candidate;
  return fallbackName === primaryActorName ? `${fallbackName} 2` : fallbackName;
}

function buildFakeConversations(selectedActorName: string, secondaryActorName: string): FakeConversationPreview[] {
  return [
    {
      id: 'product-sprint',
      name: 'Product Sprint',
      includesCurrentUser: true,
      users: ['You'],
      actors: [selectedActorName, secondaryActorName],
      singleRealUser: true,
    },
    {
      id: 'infra-triage',
      name: 'Infra Triage',
      includesCurrentUser: false,
      users: ['Chen', 'Omar'],
      actors: [selectedActorName, secondaryActorName],
      singleRealUser: false,
    },
    {
      id: 'research-board',
      name: 'Research Board',
      includesCurrentUser: true,
      users: ['You', 'Iris'],
      actors: [selectedActorName, secondaryActorName],
      singleRealUser: false,
    },
  ];
}

function buildFakeLifecycleCalls(primaryActorName: string, secondaryActorName: string): FakeLifecycleCall[] {
  return [
    {
      id: 'call-1',
      conversationId: 'solo-planning',
      conversationName: 'Solo Planning',
      users: ['You'],
      includesCurrentUser: true,
      singleRealUser: true,
      actorName: primaryActorName,
      userPrompt: '@Secretary summarize the release blockers',
      actorReply: `${primaryActorName} inspects the current blockers`,
    },
    {
      id: 'call-2',
      conversationId: 'solo-planning',
      conversationName: 'Solo Planning',
      users: ['You'],
      includesCurrentUser: true,
      singleRealUser: true,
      actorName: secondaryActorName,
      userPrompt: '@Researcher pull the vendor notes from last week',
      actorReply: `${secondaryActorName} compares the vendor notes in the same chat`,
    },
    {
      id: 'call-3',
      conversationId: 'solo-planning',
      conversationName: 'Solo Planning',
      users: ['You'],
      includesCurrentUser: true,
      singleRealUser: true,
      actorName: primaryActorName,
      userPrompt: '@Secretary follow up in the same release chat',
      actorReply: `${primaryActorName} continues inside the same conversation`,
    },
    {
      id: 'call-4',
      conversationId: 'infra-triage',
      conversationName: 'Infra Triage',
      users: ['Chen', 'Omar'],
      includesCurrentUser: false,
      singleRealUser: false,
      actorName: primaryActorName,
      userPrompt: '@Secretary check the latest infra incident notes',
      actorReply: `${primaryActorName} works where you are not present at all`,
    },
    {
      id: 'call-5',
      conversationId: 'research-board',
      conversationName: 'Research Board',
      users: ['You', 'Iris'],
      includesCurrentUser: true,
      singleRealUser: false,
      actorName: primaryActorName,
      userPrompt: '@Secretary compare the top three vendors for everyone',
      actorReply: `${primaryActorName} works in a group with another real user present`,
    },
    {
      id: 'call-6',
      conversationId: 'research-board',
      conversationName: 'Research Board',
      users: ['You', 'Iris'],
      includesCurrentUser: true,
      singleRealUser: false,
      actorName: secondaryActorName,
      userPrompt: `@${secondaryActorName} dig into pricing details`,
      actorReply: `${secondaryActorName} handles a second actor flow in the same group`,
    },
    {
      id: 'call-7',
      conversationId: 'research-board',
      conversationName: 'Research Board',
      users: ['You', 'Iris'],
      includesCurrentUser: true,
      singleRealUser: false,
      actorName: primaryActorName,
      userPrompt: '@Secretary wrap up the board discussion for everyone',
      actorReply: `${primaryActorName} speaks again in the same multi-user conversation`,
    },
  ];
}

function pickSelectedActorName(actors: AccessVisualActor[], selectedActorId?: string) {
  if (selectedActorId) {
    const selected = actors.find((actor) => actor.id === selectedActorId);
    if (selected?.name) return selected.name;
  }
  if (actors[0]?.name) return actors[0].name;
  return 'Secretary';
}

function pickSecondaryActorName(actors: AccessVisualActor[], selectedActorId?: string) {
  const primaryActorName = pickSelectedActorName(actors, selectedActorId);
  return pickAlternativeActorName(primaryActorName, actors, 'Researcher');
}

function pickSelectedUserName(
  users: AccessVisualUser[],
  selectedUserId?: string,
  fallbackName = 'You',
) {
  if (selectedUserId) {
    const selected = users.find((user) => user.id === selectedUserId);
    if (selected?.name) return selected.name;
  }
  if (users[0]?.name) return users[0].name;
  return fallbackName;
}

function pickConversationChoices(conversations: AccessVisualConversation[]) {
  return conversations
    .map((conversation) => ({
      ...conversation,
      name: getConversationDisplayName(conversation),
    }))
    .sort((left, right) => getConversationDisplayName(left).localeCompare(getConversationDisplayName(right)));
}

function ScopeOptionCard({
  option,
  active,
  onClick,
}: {
  option: ScopeOptionDef<string>;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = option.icon;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-2xl border p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm',
        option.tone,
        active ? `ring-4 ${option.ring}` : 'opacity-80 hover:opacity-100',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-white/70 p-2 shadow-sm dark:bg-black/20">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">{option.label}</div>
          <div className="mt-1 text-xs opacity-80">{option.hint}</div>
        </div>
      </div>
    </button>
  );
}

function ReuseOptionCard({
  option,
  active,
  onClick,
}: {
  option: ReuseOptionDef;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = option.icon;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-2xl border p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm',
        option.tone,
        active ? `ring-4 ${option.ring}` : 'opacity-80 hover:opacity-100',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-white/70 p-2 shadow-sm dark:bg-black/20">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">{option.label}</div>
          <div className="mt-1 text-xs opacity-80">{option.hint}</div>
        </div>
      </div>
    </button>
  );
}

const unavailableStripeStyle = {
  backgroundImage:
    'repeating-linear-gradient(-45deg, rgba(148,163,184,0.18) 0px, rgba(148,163,184,0.18) 8px, rgba(255,255,255,0.82) 8px, rgba(255,255,255,0.82) 16px)',
};

function MiniIdentity({
  label,
  kind,
  active,
}: {
  label: string;
  kind: 'user' | 'actor';
  active: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[10px] font-medium text-gray-600 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-gray-300">
      <span
        className={cn(
          'inline-flex h-4 w-4 items-center justify-center rounded-full',
          kind === 'user' ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-slate-200',
        )}
      >
        {kind === 'user' ? <UserRound className="h-2.5 w-2.5" /> : <Bot className="h-2.5 w-2.5" />}
      </span>
      <span className="max-w-[92px] truncate">{label}</span>
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          active ? 'bg-emerald-400' : 'bg-gray-300 dark:bg-gray-600',
        )}
      />
    </div>
  );
}

function MiniUserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[78%] rounded-2xl rounded-tr-sm bg-slate-900 px-3 py-2 text-[11px] leading-4 text-white shadow-sm dark:bg-slate-100 dark:text-slate-900">
        {text}
      </div>
    </div>
  );
}

function MiniActorBubble({
  actorName,
  text,
  active,
  instanceNumber,
  selected,
}: {
  actorName: string;
  text: string;
  active: boolean;
  instanceNumber?: number;
  selected?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 rounded-[18px] p-2 transition-all duration-200">
      <div className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700 ring-2 ring-white dark:bg-white/10 dark:text-slate-200 dark:ring-gray-900">
        <Bot className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-1.5">
          <span className="text-[10px] font-medium text-gray-500 dark:text-gray-400">{actorName}</span>
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              active ? 'bg-emerald-400' : 'bg-gray-300 dark:bg-gray-600',
            )}
          />
        </div>
        <div
          className={cn(
            'relative rounded-2xl rounded-tl-sm border px-3 py-2 text-[11px] leading-4 text-slate-700 shadow-sm dark:text-slate-200',
            active
              ? selected
                ? 'border-emerald-300 bg-emerald-50 ring-2 ring-emerald-200 dark:border-emerald-400/30 dark:bg-emerald-500/12 dark:ring-emerald-500/30'
                : 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/20 dark:bg-emerald-500/10'
              : 'border-gray-200 bg-white dark:border-white/10 dark:bg-white/5',
          )}
          style={active ? undefined : unavailableStripeStyle}
        >
          {typeof instanceNumber === 'number' ? (
            <span className="absolute -right-2 -top-2 inline-flex h-5 w-5 items-center justify-center rounded-full border border-red-200 bg-red-500 text-[10px] font-semibold text-white shadow-sm dark:border-red-400/30">
              {instanceNumber}
            </span>
          ) : null}
          {text}
        </div>
      </div>
    </div>
  );
}

function ScopeConversationCard({
  conversation,
  currentUserName,
  available,
  primaryActorName,
  secondaryActorName,
  primaryActorActive,
  secondaryActorActive,
}: {
  conversation: FakeConversationPreview;
  currentUserName: string;
  available: boolean;
  primaryActorName: string;
  secondaryActorName: string;
  primaryActorActive: boolean;
  secondaryActorActive: boolean;
}) {
  const promptSpeaker = conversation.includesCurrentUser ? currentUserName : conversation.users[0];
  const promptText = conversation.includesCurrentUser
    ? `@${primaryActorName} 帮我同步一下这个群的最新进展`
    : `@${primaryActorName} 帮我继续处理这个群里的待办`;

  return (
    <div className="overflow-hidden rounded-[26px] border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-gray-900">
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 bg-gray-50/80 px-4 py-3 dark:border-white/10 dark:bg-white/[0.03]">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-gray-900 dark:text-white">{conversation.name}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {conversation.users.map((userName) => (
              <MiniIdentity
                key={`${conversation.id}-${userName}`}
                label={userName}
                kind="user"
                active={available && (conversation.includesCurrentUser || userName !== currentUserName)}
              />
            ))}
            {conversation.actors.map((actorName) => (
              <MiniIdentity
                key={`${conversation.id}-${actorName}`}
                label={actorName}
                kind="actor"
                active={available && (actorName === primaryActorName ? primaryActorActive : secondaryActorActive)}
              />
            ))}
          </div>
        </div>
        <div
          className={cn(
            'shrink-0 rounded-full border px-3 py-1 text-[11px] font-medium',
            available
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300'
              : 'border-gray-200 bg-white text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400',
          )}
        >
          {available ? '可用' : '不可用'}
        </div>
      </div>

      <div className="space-y-3 p-4" style={available ? undefined : unavailableStripeStyle}>
        <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-gray-400 dark:text-gray-500">
          {conversation.includesCurrentUser
            ? conversation.singleRealUser
              ? `${currentUserName} 是群内唯一真实用户`
              : `${currentUserName} 在群内，但还有其他真实用户`
            : `${currentUserName} 不在群内`}
        </div>
        <MiniUserBubble text={`${promptSpeaker}: ${promptText}`} />
        <MiniActorBubble
          actorName={primaryActorName}
          text={`${primaryActorName} 会在这里读取工具、连接或技能。`}
          active={available && primaryActorActive}
        />
        <MiniActorBubble
          actorName={secondaryActorName}
          text={`${secondaryActorName} 代表另一个 Actor，看它是否也能使用。`}
          active={available && secondaryActorActive}
        />
      </div>
    </div>
  );
}

export function AccessAttachmentTypeStep({
  value,
  onChange,
  allowedScopes,
  actors,
  conversations,
  selectedActorId,
  onActorChange,
  selectedConversationId,
  onConversationChange,
  error,
}: {
  value: AttachmentTargetType;
  onChange: (value: AttachmentTargetType) => void;
  allowedScopes?: AttachmentTargetType[];
  actors: AccessVisualActor[];
  conversations: AccessVisualConversation[];
  selectedActorId?: string;
  onActorChange?: (value: string) => void;
  selectedConversationId?: string;
  onConversationChange?: (value: string) => void;
  error?: string;
}) {
  const allowedScopeSet = allowedScopes ? new Set(allowedScopes) : null;
  const availableOptions = attachmentTypeOptionDefs
    .filter((option) => !allowedScopeSet || allowedScopeSet.has(option.value));
  const activeScope = availableOptions.find((option) => option.value === value) || availableOptions[0];
  const conversationChoices = pickConversationChoices(conversations);
  const selectedActorName = actors.find((actor) => actor.id === selectedActorId)?.name || 'No actor selected';
  const selectedConversationName =
    conversationChoices.find((conversation) => conversation.id === selectedConversationId)?.name ||
    'No conversation selected';

  const detailContent = (() => {
    switch (value) {
      case 'workspace':
        return {
          title: 'Workspace owner',
          description: 'The installation belongs to the workspace and is managed at the workspace level.',
          fields: null,
        };
      case 'workspace_member':
        return {
          title: 'Workspace user owner',
          description: 'The installation belongs to one workspace user and is kept personal to that identity.',
          fields: null,
        };
      case 'conversation':
        return {
          title: 'Conversation owner',
          description: 'Pick the single conversation that this installation should belong to.',
          fields: (
            <Field>
              <FieldLabel>Conversation</FieldLabel>
              <Select value={selectedConversationId} onValueChange={onConversationChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a conversation" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {conversationChoices.map((conversation) => (
                      <SelectItem key={conversation.id} value={conversation.id}>
                        {conversation.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Current selection: {selectedConversationName}
              </FieldDescription>
            </Field>
          ),
        };
      case 'actor':
        return {
          title: 'Actor owner',
          description: 'Pick the single actor that should own and manage this installation.',
          fields: (
            <Field>
              <FieldLabel>Actor</FieldLabel>
              <Select value={selectedActorId} onValueChange={onActorChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select an actor" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {actors.map((actor) => (
                      <SelectItem key={actor.id} value={actor.id}>
                        {actor.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Current selection: {selectedActorName}
              </FieldDescription>
            </Field>
          ),
        };
      default:
        return {
          title: 'Owner',
          description: activeScope?.hint || 'Choose where this installation belongs.',
          fields: null,
        };
    }
  })();

  return (
    <div className="space-y-5">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <RadioGroup
          value={value}
          onValueChange={(nextValue) => onChange(nextValue as AttachmentTargetType)}
          className="w-full"
        >
          {availableOptions.map((option) => (
            <Field
              key={option.value}
              orientation="horizontal"
              className="rounded-3xl border border-border p-4"
            >
              <RadioGroupItem value={option.value} id={`owner-scope-${option.value}`} />
              <FieldContent>
                <FieldLabel htmlFor={`owner-scope-${option.value}`}>{option.label}</FieldLabel>
                <FieldDescription>{option.hint}</FieldDescription>
              </FieldContent>
            </Field>
          ))}
        </RadioGroup>

        <div className="rounded-[28px] border border-border bg-muted/20 p-5">
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-1">
              <div className="text-base font-medium text-foreground">{detailContent.title}</div>
              <p className="text-sm text-muted-foreground">{detailContent.description}</p>
            </div>

            {detailContent.fields ? (
              detailContent.fields
            ) : (
              <div className="rounded-2xl border border-dashed border-border bg-background p-4 text-sm text-muted-foreground">
                No extra selection is needed for this owner type.
              </div>
            )}
          </div>
        </div>
      </div>

  {error ? <p className="text-xs text-red-500">{error}</p> : null}
    </div>
  );
}

export function AccessGrantScopeStep({
  value,
  onChange,
  allowedScopes,
  actors,
  conversations,
  users,
  selectedActorId,
  onActorChange,
  selectedConversationId,
  onConversationChange,
  selectedUserId,
  onUserChange,
  currentUserLabel,
  error,
}: {
  value: AccessTargetType;
  onChange: (value: AccessTargetType) => void;
  allowedScopes?: AccessTargetType[];
  actors: AccessVisualActor[];
  conversations: AccessVisualConversation[];
  users: AccessVisualUser[];
  selectedActorId?: string;
  onActorChange?: (value: string) => void;
  selectedConversationId?: string;
  onConversationChange?: (value: string) => void;
  selectedUserId?: string;
  onUserChange?: (value: string) => void;
  currentUserLabel?: string;
  error?: string;
}) {
  const allowedScopeSet = allowedScopes ? new Set(allowedScopes) : null;
  const activeScope = accessTypeOptionDefs.find((option) => option.value === value) || accessTypeOptionDefs[0];
  const selectedActorName = pickSelectedActorName(actors, selectedActorId);
  const secondaryActorName = pickSecondaryActorName(actors, selectedActorId);
  const fakeConversations = buildFakeConversations(selectedActorName, secondaryActorName);
  const conversationChoices = pickConversationChoices(conversations);
  const selectedUserName = pickSelectedUserName(users, selectedUserId, currentUserLabel || 'You');

  const isConversationActive = (conversation: FakeConversationPreview, index: number) => {
    switch (value) {
      case 'workspace':
        return true;
      case 'conversation_workspace':
      case 'actor_conversation':
        return index === 0;
      case 'actor':
        return true;
      case 'workspace_member':
        return conversation.includesCurrentUser && conversation.singleRealUser;
      default:
        return false;
    }
  };

  const isActorActive = (conversation: FakeConversationPreview, actorName: string, index: number) => {
    switch (value) {
      case 'workspace':
        return true;
      case 'conversation_workspace':
        return index === 0;
      case 'actor':
        return actorName === selectedActorName;
      case 'actor_conversation':
        return index === 0 && actorName === selectedActorName;
      case 'workspace_member':
        return conversation.includesCurrentUser && conversation.singleRealUser;
      default:
        return false;
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {accessTypeOptionDefs
          .filter((option) => !allowedScopeSet || allowedScopeSet.has(option.value))
          .map((option) => (
            <ScopeOptionCard
              key={option.value}
              option={option}
              active={value === option.value}
              onClick={() => onChange(option.value)}
            />
          ))}
      </div>

      {(value === 'actor' || value === 'actor_conversation') && (
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Authorized actor</Label>
          <div className="flex flex-wrap gap-2">
            {actors.length > 0 ? actors.map((actor) => (
              <Button
                key={actor.id}
                type="button"
                variant={selectedActorId === actor.id ? 'default' : 'outline'}
                className="rounded-full"
                onClick={() => onActorChange?.(actor.id)}
              >
                {actor.name}
              </Button>
            )) : (
              <div className="text-xs text-muted-foreground">The preview uses a fake actor until your workspace has actors.</div>
            )}
          </div>
        </div>
      )}

      {(value === 'conversation_workspace' || value === 'actor_conversation') && (
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Authorized conversation</Label>
          <div className="flex flex-wrap gap-2">
            {conversationChoices.length > 0 ? conversationChoices.map((conversation) => (
              <Button
                key={conversation.id}
                type="button"
                variant={selectedConversationId === conversation.id ? 'default' : 'outline'}
                className="rounded-full"
                onClick={() => onConversationChange?.(conversation.id)}
              >
                {conversation.name}
              </Button>
            )) : (
              <div className="text-xs text-muted-foreground">The preview uses fake conversations until your workspace has real ones.</div>
            )}
          </div>
        </div>
      )}

      {value === 'workspace_member' && (
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Authorized user</Label>
          <div className="flex flex-wrap gap-2">
            {users.length > 0 ? users.map((member) => (
              <Button
                key={member.id}
                type="button"
                variant={selectedUserId === member.id ? 'default' : 'outline'}
                className="rounded-full"
                onClick={() => onUserChange?.(member.id)}
              >
                {member.name}
              </Button>
            )) : (
              <div className="text-xs text-muted-foreground">No workspace users are available yet.</div>
            )}
          </div>
        </div>
      )}

      <div className="rounded-[28px] border border-gray-200 bg-gradient-to-br from-white via-gray-50 to-white p-5 shadow-sm dark:border-white/10 dark:from-gray-900 dark:via-gray-950 dark:to-gray-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Access preview</div>
            <div className="mt-1 text-xs text-muted-foreground">This only explains which contexts can use the installation. Ownership stays where it is.</div>
          </div>
          <Badge variant="outline" className={activeScope.tone}>
            {activeScope.shortLabel}
          </Badge>
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-3">
          {fakeConversations.map((conversation, index) => {
            const conversationActive = isConversationActive(conversation, index);
            const primaryActorActive = isActorActive(conversation, selectedActorName, index);
            const conversationSecondaryActorName = conversation.actors.find((actorName) => actorName !== selectedActorName) || secondaryActorName;
            const secondaryActorActive = isActorActive(conversation, conversationSecondaryActorName, index);

            return (
              <ScopeConversationCard
                key={conversation.id}
                conversation={conversation}
                currentUserName={selectedUserName}
                available={conversationActive}
                primaryActorName={selectedActorName}
                secondaryActorName={conversationSecondaryActorName}
                primaryActorActive={primaryActorActive}
                secondaryActorActive={secondaryActorActive}
              />
            );
          })}
        </div>
      </div>

      {error ? <p className="text-xs text-red-500">{error}</p> : null}
    </div>
  );
}

export function AccessReuseScopeStep({
  attachmentType,
  value,
  onChange,
  actors,
  selectedActorId,
  allowedReuseScopes,
}: {
  attachmentType: AttachmentTargetType;
  value: ReuseScope;
  onChange: (value: ReuseScope) => void;
  actors: AccessVisualActor[];
  conversations?: AccessVisualConversation[];
  selectedActorId?: string;
  selectedConversationId?: string;
  allowedReuseScopes?: ReuseScope[];
}) {
  const allowedOptions = (allowedReuseScopes || getAllowedReuseScopes(attachmentType)).map(getReuseOption);
  const primaryActorName = pickSelectedActorName(actors, selectedActorId);
  const secondaryActorName = pickSecondaryActorName(actors, selectedActorId);
  const calls = buildFakeLifecycleCalls(primaryActorName, secondaryActorName);
  const selectedReuseOption = getReuseOption(value);
  const instanceTone = selectedReuseOption.tone;

  const instanceForCall = (call: FakeLifecycleCall) => {
    switch (value) {
      case 'workspace':
        return { key: 'workspace', label: 'Workspace runtime' };
      case 'conversation':
        return { key: `conversation:${call.conversationId}`, label: `${call.conversationName}` };
      case 'actor':
        return { key: `actor:${call.actorName}`, label: `${call.actorName}` };
      case 'session':
        return {
          key: `conversation:${call.conversationId}:actor:${call.actorName}`,
          label: `${call.actorName} @ ${call.conversationName}`,
        };
      case 'turn':
      default:
        return { key: `turn:${call.id}`, label: `Turn ${call.id.split('-')[1]}` };
    }
  };

  const isCallAvailable = (_call: FakeLifecycleCall) => true;

  const callNodes = useMemo(
    () => calls.map((call) => {
      const available = isCallAvailable(call);
      return {
        ...call,
        available,
        instance: available ? instanceForCall(call) : null,
      } satisfies FakeLifecycleNode;
    }),
    [calls, value, attachmentType, primaryActorName],
  );

  const conversationCards = useMemo(() => {
    const grouped = new Map<string, {
      conversationId: string;
      conversationName: string;
      users: string[];
      includesCurrentUser: boolean;
      singleRealUser: boolean;
      calls: typeof callNodes;
    }>();
    for (const call of callNodes) {
      const existing = grouped.get(call.conversationId);
      if (existing) {
        existing.calls.push(call);
      } else {
        grouped.set(call.conversationId, {
          conversationId: call.conversationId,
          conversationName: call.conversationName,
          users: call.users,
          includesCurrentUser: call.includesCurrentUser,
          singleRealUser: call.singleRealUser,
          calls: [call],
        });
      }
    }
    return Array.from(grouped.values());
  }, [callNodes]);

  const instanceNumberByKey = useMemo(
    () => {
      const uniqueKeys = Array.from(
        new Set(
          callNodes
            .map((call) => call.instance?.key)
            .filter((key): key is string => Boolean(key)),
        ),
      );
      return new Map(uniqueKeys.map((key, index) => [key, index + 1]));
    },
    [callNodes],
  );

  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedCallId(callNodes.find((call) => call.available)?.id || null);
  }, [value, primaryActorName, secondaryActorName, attachmentType]);

  const selectedInstanceKey =
    callNodes.find((call) => call.id === selectedCallId)?.instance?.key ||
    callNodes.find((call) => call.available)?.instance?.key ||
    '';

  return (
    <div className="space-y-5">
      <Field>
        <FieldLabel>Lifecycle</FieldLabel>
        <Select value={value} onValueChange={(nextValue) => onChange(nextValue as ReuseScope)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a lifecycle" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {allowedOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      <div className="rounded-[28px] border border-gray-200 bg-gradient-to-br from-white via-gray-50 to-white p-5 shadow-sm dark:border-white/10 dark:from-gray-900 dark:via-gray-950 dark:to-gray-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-semibold text-foreground">Preview</div>
          <Badge variant="outline" className={instanceTone}>
            {selectedReuseOption.label}
          </Badge>
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-3">
          {conversationCards.map((conversation) => (
            <div
              key={conversation.conversationId}
              className="overflow-hidden rounded-[24px] border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-gray-900"
            >
              <div className="border-b border-gray-100 bg-gray-50/80 px-4 py-3 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-gray-900 dark:text-white">{conversation.conversationName}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {conversation.users.map((userName) => (
                        <MiniIdentity
                          key={`${conversation.conversationId}-${userName}`}
                          label={userName}
                          kind="user"
                          active
                        />
                      ))}
                      {Array.from(new Set(conversation.calls.map((call) => call.actorName))).map((actorName) => (
                        <MiniIdentity
                          key={`${conversation.conversationId}-${actorName}`}
                          label={actorName}
                          kind="actor"
                          active
                        />
                      ))}
                    </div>
                  </div>
                  <div
                    className={cn(
                      'shrink-0 rounded-full border px-3 py-1 text-[11px] font-medium',
                      conversation.includesCurrentUser
                        ? conversation.singleRealUser
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300'
                          : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300'
                        : 'border-gray-200 bg-white text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400',
                    )}
                  >
                    {conversation.includesCurrentUser
                      ? conversation.singleRealUser
                        ? '你是唯一真实用户'
                        : '你和其他真实用户都在'
                      : '只有其他真实用户'}
                  </div>
                </div>
              </div>
              <div className="space-y-4 p-4">
                {conversation.calls.map((call) => {
                  const isSelected = Boolean(call.instance && call.instance.key === selectedInstanceKey);
                  return (
                    <div key={call.id} className="space-y-2">
                      <MiniUserBubble text={call.userPrompt} />
                      <button
                        type="button"
                        onClick={() => {
                          if (!call.available) return;
                          setSelectedCallId(call.id);
                        }}
                        className={cn(
                          'block w-full rounded-[20px] text-left transition-all duration-200',
                          call.available ? (isSelected ? 'scale-[1.01]' : 'hover:scale-[1.01]') : 'cursor-default',
                        )}
                      >
                        <div
                          className={cn(
                            'rounded-[20px] p-2',
                            !call.available
                              ? 'border border-gray-200/80 bg-white/90 dark:border-white/10 dark:bg-white/[0.03]'
                              : 'bg-transparent',
                          )}
                          style={call.available ? undefined : unavailableStripeStyle}
                        >
                          <MiniActorBubble
                            actorName={call.actorName}
                            text={call.actorReply}
                            active={call.available}
                            instanceNumber={call.instance ? instanceNumberByKey.get(call.instance.key) : undefined}
                            selected={call.available && isSelected}
                          />
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
