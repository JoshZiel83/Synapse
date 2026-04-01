'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AttachmentTargetType, ReuseScope } from '@synapse/shared';
import { REUSE_SCOPES } from '@synapse/shared';
import { Layers3, Save } from 'lucide-react';

import { useWorkspace } from '@/app/dashboard/workspace-provider';
import {
  AccessAttachmentTypeStep,
  AccessReuseScopeStep,
  getConversationDisplayName,
} from '@/app/dashboard/access/attachment-visuals';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { toast } from 'sonner';

type PluginAttachmentType = AttachmentTargetType;
type PluginReuseScope = ReuseScope;

const allowedAttachmentTypes: PluginAttachmentType[] = [
  'workspace',
  'conversation',
  'actor',
  'workspace_user',
];

function normalizeActorOption(actor: any) {
  const definition = actor?.definition || actor;
  return {
    id: actor.id,
    name: definition.name || definition.title || 'Untitled actor',
  };
}

function normalizeConversationOption(group: any) {
  return {
    id: group.id,
    name: getConversationDisplayName(group),
    title: group.title,
    participants: group.participants,
  };
}

function normalizeSupportedReuseScopes(value: unknown): PluginReuseScope[] {
  const supported = Array.isArray(value)
    ? value.filter((scope): scope is PluginReuseScope =>
        typeof scope === 'string' && REUSE_SCOPES.includes(scope as PluginReuseScope),
      )
    : [];
  return supported.length > 0 ? supported : [...REUSE_SCOPES];
}

export default function PluginAdvancedStep({
  installation,
  onSaved,
}: {
  installation: any | null;
  onSaved?: (installation: any) => void | Promise<void>;
}) {
  const { workspaceId } = useWorkspace();

  const [actors, setActors] = useState<any[]>([]);
  const [conversations, setConversations] = useState<any[]>([]);
  const [selectedAttachmentType, setSelectedAttachmentType] = useState<PluginAttachmentType>('workspace');
  const [selectedActorId, setSelectedActorId] = useState('');
  const [selectedConversationId, setSelectedConversationId] = useState('');
  const [lifecycleScope, setLifecycleScope] = useState<PluginReuseScope>('turn');
  const [saving, setSaving] = useState(false);
  const [scopeError, setScopeError] = useState('');

  useEffect(() => {
    if (!workspaceId) return;

    let cancelled = false;

    const load = async () => {
      try {
        const [actorData, conversationData] = await Promise.all([
          api.getActors(workspaceId),
          api.getThreads(workspaceId),
        ]);

        if (cancelled) return;
        setActors((Array.isArray(actorData) ? actorData : []).map(normalizeActorOption));
        setConversations((conversationData?.conversations || []).map(normalizeConversationOption));
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load advanced plugin options:', error);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!installation) return;

    setSelectedAttachmentType(
      (installation.attachment_target?.type || 'workspace') as PluginAttachmentType,
    );
    setSelectedActorId(installation.attachment_target?.actorId || '');
    setSelectedConversationId(installation.attachment_target?.conversationId || '');
    setLifecycleScope((installation.lifecycle_scope || 'turn') as PluginReuseScope);
    setScopeError('');
  }, [installation]);

  const allowedReuseScopes = useMemo(
    () =>
      normalizeSupportedReuseScopes(
        installation?.supported_reuse_scopes ||
        installation?.plugin_supported_reuse_scopes,
      ),
    [installation?.plugin_supported_reuse_scopes, installation?.supported_reuse_scopes],
  );

  useEffect(() => {
    if (allowedReuseScopes.includes(lifecycleScope)) return;
    setLifecycleScope(allowedReuseScopes[0] || 'turn');
  }, [allowedReuseScopes, lifecycleScope]);

  async function saveAdvancedSettings() {
    if (!workspaceId || !installation?.id) return;

    if (selectedAttachmentType === 'actor' && !selectedActorId) {
      setScopeError('Please select an actor.');
      return;
    }

    if (selectedAttachmentType === 'conversation' && !selectedConversationId) {
      setScopeError('Please select a conversation.');
      return;
    }

    setScopeError('');
    setSaving(true);
    try {
      const result = await api.updateInstallation(workspaceId, installation.id, {
        attachmentTarget: {
          type: selectedAttachmentType,
          actorId: selectedAttachmentType === 'actor' ? selectedActorId : undefined,
          conversationId:
            selectedAttachmentType === 'conversation' ? selectedConversationId : undefined,
        },
        lifecycleScope,
      });
      const savedInstallation = result?.installation || result;
      await onSaved?.(savedInstallation);
      toast.success('Advanced settings updated');
    } catch (error) {
      console.error('Failed to update advanced plugin settings:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update advanced settings');
    } finally {
      setSaving(false);
    }
  }

  if (!installation?.id) {
    return (
      <Card className="rounded-[28px]">
        <CardContent className="p-6 text-sm text-muted-foreground">
          Finish installation first. Advanced owner and lifecycle settings appear here after the installation exists.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-[28px]">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Layers3 className="size-5 text-muted-foreground" />
          <CardTitle>Advanced</CardTitle>
        </div>
        <CardDescription>
          Move where this installation belongs and change how its runtime is reused. Access stays in the Access tab.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6 pb-6">
        <AccessAttachmentTypeStep
          value={selectedAttachmentType}
          onChange={(value) => setSelectedAttachmentType(value as PluginAttachmentType)}
          allowedScopes={allowedAttachmentTypes}
          actors={actors}
          conversations={conversations}
          selectedActorId={selectedActorId}
          onActorChange={setSelectedActorId}
          selectedConversationId={selectedConversationId}
          onConversationChange={setSelectedConversationId}
          error={scopeError || undefined}
        />

        <AccessReuseScopeStep
          attachmentType={selectedAttachmentType}
          value={lifecycleScope}
          onChange={(value) => setLifecycleScope(value as PluginReuseScope)}
          actors={actors}
          conversations={conversations}
          selectedActorId={selectedActorId}
          selectedConversationId={selectedConversationId}
          allowedReuseScopes={allowedReuseScopes}
        />

        <div className="flex justify-end">
          <Button type="button" onClick={() => void saveAdvancedSettings()} disabled={saving}>
            <Save data-icon="inline-start" />
            {saving ? 'Saving...' : 'Save Advanced Settings'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
