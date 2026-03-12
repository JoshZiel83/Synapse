'use client';

import { Globe, Code, Puzzle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

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

export const bindingScopeLabels: Record<string, string> = {
  platform: 'Platform',
  workspace: 'Workspace',
  conversation: 'Conversation',
  actor_global: 'Actor',
  actor_conversation: 'Actor + Conversation',
  user: 'User',
};

export const bindingScopeColors: Record<string, string> = {
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

export function PluginIcon({
  iconUrl,
  title,
  transport,
  className = 'h-7 w-7',
  containerClassName = 'h-[60px] w-[60px] rounded-[18px]',
}: {
  iconUrl?: string | null;
  title: string;
  transport?: string;
  className?: string;
  containerClassName?: string;
}) {
  const Icon = transport === 'http' ? Globe : transport === 'builtin' ? Code : Puzzle;

  return (
    <div className={`flex flex-shrink-0 items-center justify-center overflow-hidden border border-slate-200 bg-slate-100 text-slate-700 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-slate-200 ${containerClassName}`}>
      {iconUrl ? (
        <img src={iconUrl} alt={title} className="h-full w-full object-cover" />
      ) : (
        <Icon className={className} />
      )}
    </div>
  );
}

export function ScopeBadge({ scope }: { scope: string }) {
  return (
    <Badge variant="outline" className={bindingScopeColors[scope] || 'border-gray-200 text-gray-600 dark:border-white/10 dark:text-gray-300'}>
      {bindingScopeLabels[scope] || scope}
    </Badge>
  );
}
