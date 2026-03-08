'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Globe, Code, Puzzle, Wrench, Key } from 'lucide-react';

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

export default function PluginDetailDialog({ plugin, installedCount, onInstall, onClose }: Props) {
  const tools = plugin.tools_manifest || [];
  const configSchema = plugin.config_schema || {};
  const hasRequiredConfig = (configSchema.required || []).length > 0;

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="glass-card border-blue-500/10 max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-lg bg-blue-500/10 flex items-center justify-center">
              {plugin.transport === 'http' ? <Globe className="w-6 h-6 text-blue-400" /> :
               plugin.transport === 'builtin' ? <Code className="w-6 h-6 text-blue-400" /> :
               <Puzzle className="w-6 h-6 text-blue-400" />}
            </div>
            <div>
              <DialogTitle>{plugin.display_name}</DialogTitle>
              <p className="text-sm text-muted-foreground">{plugin.org_display_name} · v{plugin.version}</p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <p className="text-sm text-muted-foreground">{plugin.long_description || plugin.description}</p>

          <div className="flex gap-2 flex-wrap">
            <Badge variant="outline" className="border-blue-500/20">{transportLabels[plugin.transport] || plugin.transport}</Badge>
            <Badge variant="outline" className="border-blue-500/20">Scope: {plugin.lifecycle_scope}</Badge>
            {(plugin.tags || []).map((tag: string) => (
              <Badge key={tag} variant="secondary" className="bg-blue-500/5">{tag}</Badge>
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
                  <div key={tool.name} className="p-2 rounded bg-blue-500/5 border border-blue-500/10">
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
                Installed{installedCount > 1 ? ` (${installedCount} scopes)` : ''}
              </Badge>
            ) : null}
            <Button onClick={onInstall} className="flex-1">
              Install{installedCount > 0 ? ' at Another Scope' : ''}
            </Button>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
