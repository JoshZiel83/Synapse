'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Settings, Trash2, AlertTriangle } from 'lucide-react';
import { usePluginStore } from '@/stores/plugin-store';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { attachmentTypeColors, attachmentTypeLabels, PluginIcon, getLocale, translate } from './plugin-ui';

export default function InstalledList() {
  const router = useRouter();
  const { installations, loadingInstalled, uninstallPlugin, updateInstallation } = usePluginStore();
  const { workspaceId } = useWorkspace();
  const locale = getLocale();

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
    const fields: any[] = install.config_fields || [];
    const required = fields.filter((field) => field.required);
    if (required.length === 0) return false;
    const configData = install.config_data || {};
    const configState = new Map<string, { isConfigured?: boolean }>((install.config_state || []).map((state: any) => [state.key, state]));
    return required.some((field: any) => {
      if (field.type === 'oauth_connection') {
        return !configState.get(field.key)?.isConfigured;
      }
      if (field.secret || field.type === 'secret') {
        return !configState.get(field.key)?.isConfigured;
      }
      return !configData[field.key];
    });
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
        const attachmentType = install.attachment_type;
        return (
          <Card key={install.id} className={`bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 ${configMissing ? 'border-amber-500/20' : 'border-gray-200 dark:border-white/10'}`}>
            <CardContent className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <PluginIcon
                  iconUrl={install.plugin_icon_url}
                  title={translate(install.plugin_display_name_i18n, locale, install.default_locale || 'en') || install.plugin_display_name}
                  transport={install.transport}
                  containerClassName="h-10 w-10 rounded-lg bg-blue-500/10"
                  className="h-5 w-5"
                />
                <div>
                  <div className="flex items-center gap-2">
                    <Link href={`/dashboard/plugins/${install.plugin_id}`} className="font-medium text-sm hover:text-blue-600">
                      {translate(install.plugin_display_name_i18n, locale, install.default_locale || 'en') || install.plugin_display_name}
                    </Link>
                    <Badge variant="outline" className={`text-xs ${attachmentTypeColors[attachmentType] || 'border-gray-200 dark:border-white/10'}`}>
                      Owner: {attachmentTypeLabels[attachmentType] || attachmentType}
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
                <Button size="icon" variant="ghost" onClick={() => router.push(`/dashboard/plugins/installations/${install.id}`)}>
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

    </div>
  );
}
