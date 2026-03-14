'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { AppCard, AppCardContent } from '@/components/app-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { api } from '@/lib/api';
import PluginInstallationWorkbench from '../plugin-installation-workbench';
import { PluginIcon, getLocale, translate } from '../plugin-ui';

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
  const locale = useMemo(() => getLocale(plugin?.default_locale), [plugin?.default_locale]);

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

  const title = translate(plugin.display_name_i18n, locale, plugin.default_locale || 'en') || plugin.display_name;
  const description = translate(plugin.long_description_i18n || plugin.description_i18n, locale, plugin.default_locale || 'en') || plugin.long_description || plugin.description;
  const activeInstallationId = installations.some((installation) => installation.id === selectedInstallationId)
    ? selectedInstallationId
    : installations[0]?.id;

  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-6 lg:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => router.push('/dashboard/plugins')}>
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
      </div>

      <AppCard variant="panel">
        <AppCardContent className="p-6">
          <div className="flex flex-col gap-5 md:flex-row md:items-start">
            <PluginIcon
              iconUrl={plugin.icon_url}
              title={title}
              transport={plugin.transport}
              verified={plugin.is_builtin}
              containerClassName="h-20 w-20 rounded-[24px]"
              className="h-8 w-8"
            />
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
                {plugin.org_display_name ? <Badge variant="secondary" className="bg-gray-100 text-gray-700 dark:bg-white/5 dark:text-gray-300">{plugin.org_display_name}</Badge> : null}
              </div>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
              <div className="flex flex-wrap gap-2">
                {(plugin.categories || []).map((category: any) => (
                  <Badge key={category.slug} variant="outline" className="border-blue-200 text-blue-600 dark:border-blue-500/20 dark:text-blue-300">
                    {translate(category.displayNameI18n, locale, category.defaultLocale || 'en') || category.displayName}
                  </Badge>
                ))}
                {(plugin.tags || []).map((tag: string) => (
                  <Badge key={tag} variant="secondary" className="bg-gray-100 text-gray-700 dark:bg-white/5 dark:text-gray-300">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </AppCardContent>
      </AppCard>

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
