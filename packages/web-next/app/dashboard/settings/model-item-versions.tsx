'use client';

import { useEffect, useState } from 'react';
import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, History, Clock } from 'lucide-react';

interface ConfigVersion {
  id: string;
  item_id: string;
  version: number;
  provider_type: string;
  engine_kind?: string;
  base_url: string;
  model_name: string;
  max_tokens: number;
  input_token_cost_micros: number;
  output_token_cost_micros: number;
  capability_tags: string[];
  created_at: string;
}

export default function ModelItemVersions({
  groupId,
  itemId,
  scope = 'workspace',
  onBack,
}: {
  groupId: string;
  itemId: string;
  scope?: 'workspace' | 'platform' | 'workspace_member';
  onBack: () => void;
}) {
  const { workspaceId } = useWorkspace();
  const [versions, setVersions] = useState<ConfigVersion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId && scope === 'workspace') return;
    setLoading(true);
    const request =
      scope === 'platform'
        ? api.getPlatformItemVersions(groupId, itemId)
        : scope === 'workspace_member'
          ? api.getWorkspaceMemberItemVersions(workspaceId!, groupId, itemId)
          : api.getItemVersions(workspaceId!, groupId, itemId);
    request
      .then((res) => setVersions(res.versions || []))
      .catch((err) => console.error('Failed to load versions:', err))
      .finally(() => setLoading(false));
  }, [workspaceId, groupId, itemId, scope]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <History className="w-5 h-5 text-blue-400" />
            Configuration History
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Each edit creates an immutable version snapshot
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
        </div>
      ) : versions.length === 0 ? (
        <p className="text-muted-foreground text-center py-8">No versions found</p>
      ) : (
        <div className="grid gap-3">
          {versions.map((v, idx) => (
            <Card key={v.id} className={`bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10 ${idx === 0 ? 'border-emerald-500/20' : ''}`}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Badge className={`text-xs ${idx === 0
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                      : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                    }`}>
                      v{v.version} {idx === 0 && '(current)'}
                    </Badge>
                    <Badge className="bg-violet-500/10 text-violet-400 border-violet-500/20 text-xs">
                      {v.provider_type}
                    </Badge>
                    {v.engine_kind ? (
                      <Badge className="bg-slate-500/10 text-slate-300 border-slate-500/20 text-xs">
                        {v.engine_kind}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    {new Date(v.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="text-xs text-muted-foreground block">Model</span>
                    <span className="text-foreground">{v.model_name}</span>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground block">Base URL</span>
                    <span className="text-foreground truncate block">{v.base_url}</span>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground block">Max Tokens</span>
                    <span className="text-foreground">{v.max_tokens}</span>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground block">Capabilities</span>
                    <span className="text-foreground">
                      {v.capability_tags?.length ? v.capability_tags.join(', ') : 'None'}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
