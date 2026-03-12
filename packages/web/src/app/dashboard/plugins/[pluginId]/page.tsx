'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { ArrowLeft, Plus, Settings, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { api } from '@/lib/api';
import { PluginIcon, ScopeBadge, bindingScopeLabels, getLocale, translate } from '../plugin-ui';

export default function PluginDetailPage() {
  const params = useParams<{ pluginId: string }>();
  const { workspaceId } = useWorkspace();
  const [plugin, setPlugin] = useState<any>(null);
  const [installations, setInstallations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const pluginId = params.pluginId;
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
        <Link href="/dashboard/plugins" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to plugins
        </Link>
        <div className="rounded-3xl border border-dashed border-gray-300 p-10 text-center text-sm text-muted-foreground dark:border-white/10">
          Plugin not found.
        </div>
      </div>
    );
  }

  const title = translate(plugin.display_name_i18n, locale, plugin.default_locale || 'en') || plugin.display_name;
  const description = translate(plugin.long_description_i18n || plugin.description_i18n, locale, plugin.default_locale || 'en') || plugin.long_description || plugin.description;
  const primaryConfigInstallation = installations[0];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/dashboard/plugins" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to plugins
        </Link>
        <div className="flex items-center gap-2">
          {primaryConfigInstallation ? (
            <Button asChild className="gap-2">
              <Link href={`/dashboard/plugins/installations/${primaryConfigInstallation.id}`}>
                <Settings className="h-4 w-4" />
                配置
              </Link>
            </Button>
          ) : null}
          <Button asChild variant={primaryConfigInstallation ? 'outline' : 'default'} className="gap-2">
            <Link href={`/dashboard/plugins/${plugin.id}/install`}>
              <Plus className="h-4 w-4" />
              {primaryConfigInstallation ? '安装新实例' : '安装'}
            </Link>
          </Button>
        </div>
      </div>

      <section className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-gray-900">
        <div className="flex flex-col gap-5 md:flex-row md:items-start">
          <PluginIcon iconUrl={plugin.icon_url} title={title} transport={plugin.transport} containerClassName="h-20 w-20 rounded-[24px]" className="h-8 w-8" />
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
              {plugin.is_builtin ? <Badge variant="outline" className="border-blue-200 text-blue-600 dark:border-blue-500/20 dark:text-blue-300">官方</Badge> : null}
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
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">安装记录</h2>
            <p className="text-sm text-muted-foreground">Choose an installation to configure its scope, secrets, authorization, or guided setup.</p>
          </div>
          {primaryConfigInstallation ? (
            <Link href={`/dashboard/authorizations?bindingId=${primaryConfigInstallation.id}`}>
              <Button variant="ghost" className="gap-2 text-blue-600 hover:text-blue-700">
                <ShieldCheck className="h-4 w-4" />
                授权管理
              </Button>
            </Link>
          ) : null}
        </div>

        {installations.length === 0 ? (
          <div className="rounded-[28px] border border-dashed border-gray-300 bg-white p-10 text-center dark:border-white/10 dark:bg-gray-900">
            <p className="text-sm text-muted-foreground">This plugin is not installed in the current workspace yet.</p>
            <Button asChild className="mt-4">
              <Link href={`/dashboard/plugins/${plugin.id}/install`}>开始安装</Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {installations.map((installation) => (
              <Link
                key={installation.id}
                href={`/dashboard/plugins/installations/${installation.id}`}
                className="block rounded-[24px] border border-gray-200 bg-white p-5 transition-colors hover:bg-gray-50 dark:border-white/10 dark:bg-gray-900 dark:hover:bg-white/5"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <ScopeBadge scope={installation.scope_type} />
                      <Badge variant="outline" className="border-gray-200 text-gray-600 dark:border-white/10 dark:text-gray-300">
                        Runtime: {installation.lifecycle_scope}
                      </Badge>
                      <Badge variant={installation.is_enabled ? 'default' : 'secondary'}>
                        {installation.is_enabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {installation.scope_type === 'user' ? 'Installed for current user' : bindingScopeLabels[installation.scope_type] || installation.scope_type}
                    </div>
                    {installation.org_display_name ? (
                      <p className="text-xs text-muted-foreground">{installation.org_display_name} · v{installation.plugin_version}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
                      <Settings className="h-4 w-4" />
                      <span className="ml-2">去配置</span>
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
