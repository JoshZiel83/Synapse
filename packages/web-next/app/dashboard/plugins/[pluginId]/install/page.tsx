'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { api } from '@/lib/api';
import InstallDialog from '../../install-dialog';

export default function PluginInstallPage() {
  const params = useParams<{ pluginId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { workspaceId } = useWorkspace();
  const [plugin, setPlugin] = useState<any>(null);
  const [installation, setInstallation] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const pluginId = params.pluginId;
  const reconfigureInstallationId = searchParams.get('reconfigure');

  useEffect(() => {
    if (!workspaceId || !pluginId) return;
    let cancelled = false;

    const load = async () => {
      try {
        setLoading(true);
        const [pluginData, installationData] = await Promise.all([
          api.getMarketplacePlugin(pluginId),
          reconfigureInstallationId ? api.getInstallation(workspaceId, reconfigureInstallationId) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setPlugin(pluginData);
        setInstallation(installationData?.installation || null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [pluginId, reconfigureInstallationId, workspaceId]);

  if (loading) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Loading install flow...</div>;
  }

  if (!plugin) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Plugin not found.</div>;
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={`/dashboard/plugins/${plugin.id}`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to plugin
        </Link>
        <Button variant="outline" onClick={() => router.push(`/dashboard/plugins/${plugin.id}`)}>
          Cancel
        </Button>
      </div>

      <InstallDialog
        plugin={plugin}
        initialInstallation={installation}
        presentation="page"
        onClose={() => router.push(installation ? `/dashboard/plugins/installations/${installation.id}` : `/dashboard/plugins/${plugin.id}`)}
        onSuccess={() => router.push(installation ? `/dashboard/plugins/installations/${installation.id}` : `/dashboard/plugins/${plugin.id}`)}
      />
    </div>
  );
}
