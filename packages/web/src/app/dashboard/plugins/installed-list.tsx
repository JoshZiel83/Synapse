'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Settings, Trash2, Globe, Code, Puzzle, AlertTriangle } from 'lucide-react';
import { usePluginStore } from '@/stores/plugin-store';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import PluginConfigDialog from './plugin-config-dialog';

const scopeColors: Record<string, string> = {
  workspace: 'border-blue-500/30 text-blue-400',
  conversation: 'border-orange-500/30 text-orange-400',
  actor_global: 'border-green-500/30 text-green-400',
  actor_conversation: 'border-amber-500/30 text-amber-400',
  user: 'border-fuchsia-500/30 text-fuchsia-400',
};

const scopeLabels: Record<string, string> = {
  workspace: 'Workspace',
  conversation: 'Conversation',
  actor_global: 'Actor',
  actor_conversation: 'Actor + Conversation',
  user: 'User',
};

export default function InstalledList() {
  const { installations, loadingInstalled, uninstallPlugin, updateInstallation } = usePluginStore();
  const { workspaceId } = useWorkspace();
  const [configInstall, setConfigInstall] = useState<any>(null);

  const handleToggle = async (install: any, enabled: boolean) => {
    if (!workspaceId) return;
    await updateInstallation(workspaceId, install.id, { isEnabled: enabled });
  };

  const handleUninstall = async (installId: string) => {
    if (!workspaceId) return;
    if (!confirm('Are you sure you want to uninstall this plugin?')) return;
    await uninstallPlugin(workspaceId, installId);
  };

  const hasRequiredConfigMissing = (install: any): boolean => {
    const schema = install.config_schema || {};
    const required: string[] = schema.required || [];
    if (required.length === 0) return false;
    const configData = install.config_data || {};
    return required.some((field: string) => !configData[field]);
  };

  if (loadingInstalled) {
    return <div className="text-center py-12 text-muted-foreground">Loading installed plugins...</div>;
  }

  if (installations.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">No plugins installed yet.</p>
        <p className="text-sm text-muted-foreground mt-1">Browse the Marketplace to find plugins.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {installations.map((install: any) => {
        const configMissing = hasRequiredConfigMissing(install);
        return (
          <Card key={install.id} className={`bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 ${configMissing ? 'border-amber-500/20' : 'border-gray-200 dark:border-white/10'}`}>
            <CardContent className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                  {install.transport === 'http' ? <Globe className="w-5 h-5 text-blue-400" /> :
                   install.transport === 'builtin' ? <Code className="w-5 h-5 text-blue-400" /> :
                   <Puzzle className="w-5 h-5 text-blue-400" />}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-sm">{install.plugin_display_name}</p>
                    <Badge variant="outline" className={`text-xs ${scopeColors[install.scope_type] || 'border-gray-200 dark:border-white/10'}`}>
                      {scopeLabels[install.scope_type] || install.scope_type}
                    </Badge>
                    <Badge variant="outline" className="text-xs border-gray-200 dark:border-white/10 text-muted-foreground">
                      {install.lifecycle_scope}
                    </Badge>
                    {configMissing && (
                      <Badge variant="outline" className="text-xs border-amber-500/30 text-amber-400 gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        Config Required
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{install.org_display_name} · v{install.plugin_version}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Switch
                  checked={install.is_enabled}
                  onCheckedChange={(checked) => handleToggle(install, checked)}
                />
                <Button size="icon" variant="ghost" onClick={() => setConfigInstall(install)}>
                  <Settings className="w-4 h-4" />
                </Button>
                <Button size="icon" variant="ghost" className="text-red-400 hover:text-red-300" onClick={() => handleUninstall(install.id)}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {configInstall && (
        <PluginConfigDialog
          installation={configInstall}
          onClose={() => setConfigInstall(null)}
        />
      )}
    </div>
  );
}
