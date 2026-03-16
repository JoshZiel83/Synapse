'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { api } from '@/lib/api';
import PluginInstallationWorkbench from '../plugin-installation-workbench';
import PluginHeroCard from '../plugin-hero-card';

export default function PluginDetailPage() {
  const params = useParams<{ pluginId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { workspaceId } = useWorkspace();
  const [plugin, setPlugin] = useState<any>(null);
  const [installations, setInstallations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const pluginId = params.pluginId;
  const selectedInstallationId = searchParams.get('installationId');

  useEffect(() => {
    if (!workspaceId || !pluginId) return;
    let cancelled = false;

    const load = async () => {
      try {
        setLoading(true);
        const [pluginData, installData] = await Promise.all([
          api.getMarketplacePlugin(pluginId),
          api.getInstallations(workspaceId, new URLSearchParams({ pluginId }).toString()),
        ]);
        if (cancelled) return;
        setPlugin(pluginData);
        setInstallations(installData);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [pluginId, workspaceId]);

  if (loading) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Loading plugin details...</div>;
  }

  if (!plugin) {
    return (
      <div className="space-y-4">
        <Button type="button" variant="outline" size="sm" onClick={() => router.push('/dashboard/plugins')}>
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
        <div className="rounded-3xl border border-dashed border-gray-300 p-10 text-center text-sm text-muted-foreground dark:border-white/10">
          Plugin not found.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-6 lg:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => router.push('/dashboard/plugins')}>
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
      </div>

      <PluginHeroCard plugin={plugin} />

      <div>
        <PluginInstallationWorkbench
          plugin={plugin}
          installations={installations}
          selectedInstallationId={selectedInstallationId}
          onSelectInstallation={(installationId) => {
            const nextParams = new URLSearchParams(searchParams.toString());
            nextParams.set('installationId', installationId);
            router.replace(`/dashboard/plugins/${plugin.id}?${nextParams.toString()}`, { scroll: false });
          }}
          onCreateInstallation={() => router.push(`/dashboard/plugins/${plugin.id}/install`)}
          onInstallationsChanged={async () => {
            if (!workspaceId) return;
            const installData = await api.getInstallations(workspaceId, new URLSearchParams({ pluginId }).toString());
            setInstallations(installData);
          }}
        />
      </div>
    </div>
  );
}
