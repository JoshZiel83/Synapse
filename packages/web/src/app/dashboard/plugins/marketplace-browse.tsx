'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Search, Download, Globe, Code, Puzzle } from 'lucide-react';
import { usePluginStore } from '@/stores/plugin-store';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import PluginDetailDialog from './plugin-detail-dialog';
import InstallDialog from './install-dialog';

const transportIcons: Record<string, any> = {
  http: Globe,
  builtin: Code,
  relay: Puzzle,
};

export default function MarketplaceBrowse() {
  const { marketplace, installations, loadMarketplace, loadingMarketplace } = usePluginStore();
  const { workspaceId } = useWorkspace();
  const [search, setSearch] = useState('');
  const [selectedPlugin, setSelectedPlugin] = useState<any>(null);
  const [installPlugin, setInstallPlugin] = useState<any>(null);

  const handleSearch = () => {
    loadMarketplace(search || undefined);
  };

  const isInstalled = (pluginId: string) => {
    return installations.some((i: any) => i.plugin_id === pluginId);
  };

  const installedCount = (pluginId: string) => {
    return installations.filter((i: any) => i.plugin_id === pluginId).length;
  };

  const hasRequiredConfig = (plugin: any): boolean => {
    const schema = plugin.config_schema || {};
    return (schema.required || []).length > 0;
  };

  const handleInstall = (plugin: any) => {
    setInstallPlugin(plugin);
    setSelectedPlugin(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search plugins..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="pl-10 glass-card border-blue-500/10"
          />
        </div>
        <Button onClick={handleSearch} variant="outline" className="border-blue-500/20">
          Search
        </Button>
      </div>

      {loadingMarketplace ? (
        <div className="text-center py-12 text-muted-foreground">Loading plugins...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {marketplace.map((plugin: any) => {
            const TransportIcon = transportIcons[plugin.transport] || Puzzle;
            const count = installedCount(plugin.id);
            return (
              <Card key={plugin.id} className="glass-card border-blue-500/10 hover:border-blue-500/30 transition-colors cursor-pointer" onClick={() => setSelectedPlugin(plugin)}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                        <TransportIcon className="w-5 h-5 text-blue-400" />
                      </div>
                      <div>
                        <CardTitle className="text-sm font-semibold">{plugin.display_name}</CardTitle>
                        <p className="text-xs text-muted-foreground">{plugin.org_display_name}</p>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      {plugin.is_builtin && <Badge variant="outline" className="text-xs border-blue-500/30 text-blue-400">Built-in</Badge>}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{plugin.description}</p>
                  <div className="flex items-center justify-between">
                    <div className="flex gap-1 flex-wrap">
                      {(plugin.tags || []).slice(0, 3).map((tag: string) => (
                        <Badge key={tag} variant="secondary" className="text-xs bg-blue-500/5">{tag}</Badge>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Download className="w-3 h-3" />
                      {plugin.download_count}
                    </div>
                  </div>
                  {count > 0 ? (
                    <Badge className="mt-3 bg-green-500/20 text-green-400 border-green-500/30">
                      Installed{count > 1 ? ` (${count})` : ''}
                    </Badge>
                  ) : (
                    <Button size="sm" className="mt-3 w-full" variant="outline" onClick={(e) => { e.stopPropagation(); handleInstall(plugin); }}>
                      Install
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {selectedPlugin && (
        <PluginDetailDialog
          plugin={selectedPlugin}
          installedCount={installedCount(selectedPlugin.id)}
          onInstall={() => handleInstall(selectedPlugin)}
          onClose={() => setSelectedPlugin(null)}
        />
      )}

      {installPlugin && (
        <InstallDialog
          plugin={installPlugin}
          onClose={() => setInstallPlugin(null)}
        />
      )}
    </div>
  );
}
