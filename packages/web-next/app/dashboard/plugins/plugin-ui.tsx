'use client';

import { BadgeCheck, Globe, Code, Puzzle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { resolveFileUrl } from '@/lib/utils';

export function getLocale(defaultLocale?: string) {
  if (typeof navigator !== 'undefined') {
    return navigator.languages?.[0] || navigator.language || defaultLocale || 'en';
  }
  return defaultLocale || 'en';
}

export function translate(text: Record<string, string> | undefined, locale: string, fallback?: string) {
  if (!text || Object.keys(text).length === 0) return fallback || '';
  return text[locale] || text[locale.split('-')[0]] || text[fallback || ''] || text.en || Object.values(text)[0] || fallback || '';
}

export const attachmentTypeLabels: Record<string, string> = {
  platform: 'Platform',
  workspace: 'Workspace',
  conversation: 'Conversation',
  actor_global: 'Actor',
  actor_conversation: 'Actor in Conversation',
  user: 'Personal',
};

export const attachmentTypeColors: Record<string, string> = {
  platform: 'border-violet-500/30 text-violet-500 dark:text-violet-300',
  workspace: 'border-blue-500/30 text-blue-500 dark:text-blue-300',
  conversation: 'border-orange-500/30 text-orange-500 dark:text-orange-300',
  actor_global: 'border-green-500/30 text-green-500 dark:text-green-300',
  actor_conversation: 'border-amber-500/30 text-amber-500 dark:text-amber-300',
  user: 'border-fuchsia-500/30 text-fuchsia-500 dark:text-fuchsia-300',
};

export const transportLabels: Record<string, string> = {
  http: 'Remote MCP',
  builtin: 'Built-in',
  relay: 'Relay',
  stdio: 'Local',
};

type PluginInstallationSummaryShape = {
  attachment_type?: string | null;
  lifecycle_scope?: string | null;
  is_enabled?: boolean | null;
};

const ownershipSummaryByAttachmentType: Record<string, string> = {
  workspace: 'Owned by this workspace',
  conversation: 'Owned by one conversation',
  actor_global: 'Owned by one actor',
  actor_conversation: 'Owned by one actor in one conversation',
  user: 'Owned by you',
  platform: 'Owned by the platform',
};

const lifecycleSummaryByScope: Record<string, string> = {
  turn: 'fresh for every run',
  user: 'reused per user',
  workspace: 'reused across the workspace',
  conversation: 'reused per conversation',
  actor_global: 'reused per actor',
  actor_conversation: 'reused per actor in each conversation',
  platform: 'reused platform-wide',
};

export function getPluginInstallationTitle(installation: PluginInstallationSummaryShape) {
  const attachmentType = installation.attachment_type;
  if (attachmentType === 'workspace') {
    return 'Workspace configuration';
  }
  if (attachmentType === 'conversation') {
    return 'Conversation configuration';
  }
  if (attachmentType === 'actor_global') {
    return 'Actor configuration';
  }
  if (attachmentType === 'actor_conversation') {
    return 'Actor + conversation configuration';
  }
  if (attachmentType === 'user') {
    return 'Personal configuration';
  }
  return `${attachmentTypeLabels[attachmentType || ''] || attachmentType || 'Plugin'} configuration`;
}

export function getPluginInstallationDetails(installation: PluginInstallationSummaryShape) {
  const ownershipSummary =
    ownershipSummaryByAttachmentType[installation.attachment_type || ''] ||
    `Owned by ${attachmentTypeLabels[installation.attachment_type || ''] || installation.attachment_type || 'this scope'}`;
  const lifecycleSummary =
    lifecycleSummaryByScope[installation.lifecycle_scope || ''] ||
    `reuse: ${installation.lifecycle_scope || 'turn'}`;
  const statusSummary = installation.is_enabled ? 'enabled' : 'disabled';
  return `${ownershipSummary}, ${lifecycleSummary}, ${statusSummary}.`;
}

export function PluginIcon({
  iconUrl,
  title,
  transport,
  verified = false,
  className = 'h-7 w-7',
  containerClassName = 'h-[60px] w-[60px] rounded-[18px]',
}: {
  iconUrl?: string | null;
  title: string;
  transport?: string;
  verified?: boolean;
  className?: string;
  containerClassName?: string;
}) {
  const Icon = transport === 'http' ? Globe : transport === 'builtin' ? Code : Puzzle;
  const resolvedIconUrl = resolveFileUrl(iconUrl);

  return (
    <div className="relative flex-shrink-0">
      <div className={`flex items-center justify-center overflow-hidden border border-slate-200 bg-slate-100 text-slate-700 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-slate-200 ${containerClassName}`}>
        {resolvedIconUrl ? (
          <img src={resolvedIconUrl} alt={title} className="h-full w-full object-cover" />
        ) : (
          <Icon className={className} />
        )}
      </div>
      {verified ? (
        <div className="absolute -bottom-1 -right-1 rounded-full bg-background p-0.5 shadow-sm ring-1 ring-border/80">
          <BadgeCheck className="size-4 fill-sky-500 text-sky-500" />
          <span className="sr-only">Verified official plugin</span>
        </div>
      ) : null}
    </div>
  );
}

export function ScopeBadge({ scope }: { scope: string }) {
  return (
    <Badge variant="outline" className={attachmentTypeColors[scope] || 'border-gray-200 text-gray-600 dark:border-white/10 dark:text-gray-300'}>
      {attachmentTypeLabels[scope] || scope}
    </Badge>
  );
}
