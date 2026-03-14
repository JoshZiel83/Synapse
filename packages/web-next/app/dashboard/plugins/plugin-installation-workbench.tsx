'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { AppCard, AppCardContent, AppCardHeader, AppCardTitle } from '@/components/app-card';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import InstallDialog from './install-dialog';
import { ScopeBadge, attachmentTypeLabels } from './plugin-ui';

interface Props {
  plugin: any;
  installations: any[];
  selectedInstallationId?: string | null;
  initialInstallation?: any | null;
  onSelectInstallation: (installationId: string) => void;
  onCreateInstallation: () => void;
  onInstallationsChanged?: (installation: any) => void | Promise<void>;
}

function getInstallationSummary(installation: any) {
  const attachmentType = installation.attachment_type;
  if (attachmentType === 'workspace') {
    return 'Managed by this workspace';
  }
  if (attachmentType === 'conversation') {
    return 'Managed inside one conversation';
  }
  if (attachmentType === 'actor_global') {
    return 'Managed by one actor';
  }
  if (attachmentType === 'actor_conversation') {
    return 'Managed by one actor in one conversation';
  }
  if (attachmentType === 'user') {
    return 'Managed by you';
  }
  return `Managed by ${attachmentTypeLabels[attachmentType] || attachmentType}`;
}

export default function PluginInstallationWorkbench({
  plugin,
  installations,
  selectedInstallationId,
  initialInstallation,
  onSelectInstallation,
  onCreateInstallation,
  onInstallationsChanged,
}: Props) {
  const { workspaceId } = useWorkspace();
  const activeInstallationId = useMemo(() => {
    if (!installations.length) return null;
    if (selectedInstallationId && installations.some((installation) => installation.id === selectedInstallationId)) {
      return selectedInstallationId;
    }
    return installations[0]?.id || null;
  }, [installations, selectedInstallationId]);

  const [selectedInstallation, setSelectedInstallation] = useState<any | null>(
    initialInstallation?.id === activeInstallationId ? initialInstallation : null,
  );
  const [loadingInstallation, setLoadingInstallation] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);

  useEffect(() => {
    if (initialInstallation?.id === activeInstallationId) {
      setSelectedInstallation(initialInstallation);
    }
  }, [activeInstallationId, initialInstallation]);

  useEffect(() => {
    if (!workspaceId || !activeInstallationId) {
      setSelectedInstallation(null);
      return;
    }

    if (initialInstallation?.id === activeInstallationId) {
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        setLoadingInstallation(true);
        const data = await api.getInstallation(workspaceId, activeInstallationId);
        if (!cancelled) {
          setSelectedInstallation(data.installation);
        }
      } finally {
        if (!cancelled) {
          setLoadingInstallation(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [activeInstallationId, initialInstallation?.id, workspaceId]);

  const resetSelectedInstallation = async () => {
    if (!workspaceId || !activeInstallationId) return;
    const data = await api.getInstallation(workspaceId, activeInstallationId);
    setSelectedInstallation(data.installation);
    setEditorVersion((value) => value + 1);
  };

  return (
    <AppCard variant="panel" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <AppCardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 px-6 py-6">
        <AppCardTitle>安装记录</AppCardTitle>
        <Button size="sm" onClick={onCreateInstallation}>
          <Plus data-icon="inline-start" />
          安装
        </Button>
      </AppCardHeader>

      <AppCardContent className="min-h-0 flex-1 p-0">
        <div className="grid min-h-0 grid-rows-[16rem_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)] xl:grid-rows-none">
          <div className="border-t border-gray-200 dark:border-white/10 xl:border-r">
            <ScrollArea className="h-full">
              <div className="flex flex-col gap-3 p-6">
                {installations.map((installation) => {
                  const selected = installation.id === activeInstallationId;
                  return (
                    <button
                      key={installation.id}
                      type="button"
                      onClick={() => onSelectInstallation(installation.id)}
                      className={cn(
                        'flex flex-col gap-3 rounded-[22px] px-4 py-4 text-left transition-colors',
                        selected
                          ? 'bg-accent text-accent-foreground'
                          : 'hover:bg-muted/60',
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <ScopeBadge scope={installation.attachment_type} />
                        <Badge variant="outline">Runtime: {installation.lifecycle_scope}</Badge>
                        <Badge variant={installation.is_enabled ? 'default' : 'secondary'}>
                          {installation.is_enabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </div>
                      <div className="space-y-1">
                        <div className="text-sm font-medium text-foreground">
                          {getInstallationSummary(installation)}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {installation.org_display_name
                            ? `${installation.org_display_name} · v${installation.plugin_version}`
                            : `Version ${installation.plugin_version}`}
                        </p>
                      </div>
                    </button>
                  );
                })}

                <button
                  type="button"
                  onClick={onCreateInstallation}
                  className="rounded-[22px] border border-dashed border-border px-4 py-4 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted/60"
                >
                  创建配置
                </button>
              </div>
            </ScrollArea>
          </div>

          <div className="min-w-0 min-h-0 border-t border-gray-200 px-6 py-6 dark:border-white/10">
            {!activeInstallationId ? (
              <div className="flex min-h-[18rem] items-center justify-center text-sm text-muted-foreground">
                Select an installation to configure it.
              </div>
            ) : loadingInstallation || !selectedInstallation ? (
              <div className="flex min-h-[18rem] items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 animate-spin" />
                Loading installation...
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <InstallDialog
                  key={`${selectedInstallation.id}:${editorVersion}`}
                  plugin={plugin}
                  initialInstallation={selectedInstallation}
                  presentation="page"
                  showPluginHeader={false}
                  pageChrome="plain"
                  onClose={() => {
                    void resetSelectedInstallation();
                  }}
                  onInstallationSaved={async (installation) => {
                    setSelectedInstallation(installation);
                    await onInstallationsChanged?.(installation);
                  }}
                  onSuccess={async (installation) => {
                    setSelectedInstallation(installation);
                    setEditorVersion((value) => value + 1);
                    await onInstallationsChanged?.(installation);
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </AppCardContent>
    </AppCard>
  );
}
