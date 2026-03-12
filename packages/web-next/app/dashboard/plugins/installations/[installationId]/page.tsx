'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Sparkles, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { api } from '@/lib/api';
import PluginConfigDialog from '../../plugin-config-dialog';
import { PluginIcon, ScopeBadge, getLocale, translate } from '../../plugin-ui';

export default function PluginInstallationPage() {
  const params = useParams<{ installationId: string }>();
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const [installation, setInstallation] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const installationId = params.installationId;
  const locale = useMemo(() => getLocale(installation?.default_locale), [installation?.default_locale]);

  useEffect(() => {
    if (!workspaceId || !installationId) return;
    let cancelled = false;

    const load = async () => {
      try {
        setLoading(true);
        const data = await api.getInstallation(workspaceId, installationId);
        if (!cancelled) setInstallation(data.installation);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [installationId, workspaceId]);

  if (loading) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Loading installation...</div>;
  }

  if (!installation) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Installation not found.</div>;
  }

  const title = translate(installation.plugin_display_name_i18n, locale, installation.default_locale || 'en') || installation.plugin_display_name;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={`/dashboard/plugins/${installation.plugin_id}`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to plugin
        </Link>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" className="gap-2">
            <Link href={`/dashboard/plugins/${installation.plugin_id}/install?reconfigure=${installation.id}`}>
              <Sparkles className="h-4 w-4" />
              重新按流程配置
            </Link>
          </Button>
          <Button asChild variant="outline" className="gap-2">
            <Link href={`/dashboard/authorizations?bindingId=${installation.id}`}>
              <ShieldCheck className="h-4 w-4" />
              授权管理
            </Link>
          </Button>
        </div>
      </div>

      <section className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-gray-900">
        <div className="flex items-center gap-4">
          <PluginIcon iconUrl={installation.plugin_icon_url} title={title} transport={installation.transport} containerClassName="h-16 w-16 rounded-[20px]" className="h-7 w-7" />
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
              <ScopeBadge scope={installation.scope_type} />
            </div>
            <p className="text-sm text-muted-foreground">
              Adjust configuration, reconnect OAuth providers, or change the binding scope for this installation.
            </p>
          </div>
        </div>
      </section>

      <PluginConfigDialog
        installation={installation}
        presentation="page"
        onClose={() => router.push(`/dashboard/plugins/${installation.plugin_id}`)}
        onSuccess={() => router.push(`/dashboard/plugins/${installation.plugin_id}`)}
      />
    </div>
  );
}
