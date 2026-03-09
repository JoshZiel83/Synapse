'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Store, Package, Radio } from 'lucide-react';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { usePluginStore } from '@/stores/plugin-store';
import MarketplaceBrowse from './marketplace-browse';
import InstalledList from './installed-list';
import RelayList from './relay-list';

export default function PluginsPage() {
  const searchParams = useSearchParams();
  const defaultActorId = searchParams.get('actorId') || undefined;
  const defaultTab = searchParams.get('tab') || 'marketplace';
  const [tab, setTab] = useState(defaultTab);
  const { workspaceId } = useWorkspace();
  const { loadMarketplace, loadInstallations, loadOrganizations } = usePluginStore();

  useEffect(() => {
    loadMarketplace();
    loadOrganizations();
    if (workspaceId) {
      loadInstallations(workspaceId);
    }
  }, [workspaceId]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Plugins</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Browse and manage MCP plugins for your workspace
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10">
          <TabsTrigger value="marketplace" className="data-[state=active]:bg-indigo-50 data-[state=active]:text-indigo-600 dark:data-[state=active]:bg-indigo-500/20 dark:data-[state=active]:text-indigo-400 gap-2">
            <Store className="w-4 h-4" />
            Marketplace
          </TabsTrigger>
          <TabsTrigger value="installed" className="data-[state=active]:bg-indigo-50 data-[state=active]:text-indigo-600 dark:data-[state=active]:bg-indigo-500/20 dark:data-[state=active]:text-indigo-400 gap-2">
            <Package className="w-4 h-4" />
            Installed
          </TabsTrigger>
          <TabsTrigger value="relays" className="data-[state=active]:bg-indigo-50 data-[state=active]:text-indigo-600 dark:data-[state=active]:bg-indigo-500/20 dark:data-[state=active]:text-indigo-400 gap-2">
            <Radio className="w-4 h-4" />
            Relays
          </TabsTrigger>
        </TabsList>

        <TabsContent value="marketplace" className="mt-6">
          <MarketplaceBrowse defaultActorId={defaultActorId} />
        </TabsContent>

        <TabsContent value="installed" className="mt-6">
          <InstalledList />
        </TabsContent>

        <TabsContent value="relays" className="mt-6">
          <RelayList />
        </TabsContent>
      </Tabs>
    </div>
  );
}
