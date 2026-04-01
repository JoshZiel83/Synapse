'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Globe, Code, Puzzle, Wrench, Key } from 'lucide-react';
import { resolveFileUrl } from '@/lib/utils';

function getLocale(defaultLocale?: string) {
  if (typeof navigator !== 'undefined') {
    return navigator.languages?.[0] || navigator.language || defaultLocale || 'en';
  }
  return defaultLocale || 'en';
}

function translate(text: Record<string, string> | undefined, locale: string, fallback?: string) {
  if (!text || Object.keys(text).length === 0) return fallback || '';
  return text[locale] || text[locale.split('-')[0]] || text[fallback || ''] || text.en || Object.values(text)[0] || fallback || '';
}

interface Props {
  plugin: any;
  installedCount: number;
  onInstall: () => void;
  onClose: () => void;
}

const transportLabels: Record<string, string> = {
  http: 'Remote MCP (HTTP)',
  builtin: 'Built-in',
  stdio: 'Local (stdio)',
  relay: 'Relay Tunnel',
};

const attachmentTypeLabels: Record<string, string> = {
  workspace: 'Workspace',
  conversation: 'Conversation',
  actor: 'Actor',
  actor_conversation: 'Actor in Conversation',
  workspace_member: 'Workspace Member',
};

const reuseScopeLabels: Record<string, string> = {
  turn: 'Turn',
  session: 'Session',
  conversation: 'Conversation',
  actor: 'Actor',
  workspace: 'Workspace',
};

export default function PluginDetailDialog({ plugin, installedCount, onInstall, onClose }: Props) {
  const tools = plugin.tools_manifest || [];
  const configFields = plugin.config_fields || [];
  const hasRequiredConfig = configFields.some((field: any) => field.required);
  const locale = getLocale(plugin.default_locale);
  const iconUrl = resolveFileUrl(plugin.icon_url);

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10 max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-lg bg-blue-500/10 flex items-center justify-center">
              {iconUrl ? (
                <img src={iconUrl} alt={plugin.display_name} className="w-8 h-8 rounded-md object-contain" />
              ) : plugin.transport === 'http' ? <Globe className="w-6 h-6 text-blue-400" /> :
                plugin.transport === 'builtin' ? <Code className="w-6 h-6 text-blue-400" /> :
                  <Puzzle className="w-6 h-6 text-blue-400" />}
            </div>
            <div>
              <DialogTitle>{translate(plugin.display_name_i18n, locale, plugin.default_locale || 'en') || plugin.display_name}</DialogTitle>
              <p className="text-sm text-muted-foreground">{plugin.org_display_name} · v{plugin.version}</p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <p className="text-sm text-muted-foreground">
            {translate(plugin.long_description_i18n || plugin.description_i18n, locale, plugin.default_locale || 'en') || plugin.long_description || plugin.description}
          </p>

          <div className="flex gap-2 flex-wrap">
            <Badge variant="outline" className="border-gray-200 dark:border-white/10">{transportLabels[plugin.transport] || plugin.transport}</Badge>
            <Badge variant="outline" className="border-gray-200 dark:border-white/10">
              Default owner: {attachmentTypeLabels[plugin.default_instance_scope] || plugin.default_instance_scope || 'Workspace'}
            </Badge>
            <Badge variant="outline" className="border-gray-200 dark:border-white/10">
              Runtime: {reuseScopeLabels[plugin.lifecycle_scope] || plugin.lifecycle_scope}
            </Badge>
            {(plugin.categories || []).map((category: any) => (
              <Badge key={category.slug} variant="outline" className="border-blue-500/20 text-blue-500 dark:text-blue-300">
                {translate(category.displayNameI18n, locale, category.defaultLocale || 'en') || category.displayName}
              </Badge>
            ))}
            {(plugin.tags || []).map((tag: string) => (
              <Badge key={tag} variant="secondary" className="bg-gray-50 dark:bg-white/5">{tag}</Badge>
            ))}
          </div>

          {/* Config requirements notice */}
          {hasRequiredConfig && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2 mb-1">
                <Key className="w-4 h-4 text-amber-400" />
                <span className="text-xs font-medium text-amber-300">Requires configuration</span>
              </div>
              <p className="text-xs text-muted-foreground">
                This plugin requires an API key or other configuration to function.
              </p>
            </div>
          )}

          {tools.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                <Wrench className="w-4 h-4 text-blue-400" />
                Tools ({tools.length})
              </h4>
              <div className="space-y-2">
                {tools.map((tool: any) => (
                  <div key={tool.name} className="p-2 rounded bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10">
                    <p className="text-sm font-mono font-medium text-blue-400">{tool.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">{tool.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            {installedCount > 0 ? (
              <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                Installed{installedCount > 1 ? ` (${installedCount} instances)` : ''}
              </Badge>
            ) : null}
            <Button onClick={onInstall} className="flex-1">
              {installedCount > 0 ? 'Create Another Installation' : 'Install'}
            </Button>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
