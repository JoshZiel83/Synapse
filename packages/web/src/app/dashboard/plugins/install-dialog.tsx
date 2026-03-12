'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ExternalLink, HelpCircle } from 'lucide-react';
import { usePluginStore } from '@/stores/plugin-store';
import { useAuthStore } from '@/stores/auth-store';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { api } from '@/lib/api';

interface ValidationRule {
  field: string;
  rule: string;
  value?: string | number | string[];
  message: string;
}

function runClientValidation(config: Record<string, unknown>, rules: ValidationRule[]): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  for (const rule of rules) {
    const value = config[rule.field];
    switch (rule.rule) {
      case 'required':
        if (!value) errors.push({ field: rule.field, message: rule.message });
        break;
      case 'min_length':
        if (typeof value === 'string' && value.length < (rule.value as number))
          errors.push({ field: rule.field, message: rule.message });
        break;
    }
  }
  return errors;
}

interface Props {
  plugin: any;
  defaultActorId?: string;
  onClose: () => void;
}

const scopeOptions = [
  { value: 'workspace', label: 'Workspace', description: 'Available to all actors in this workspace' },
  { value: 'conversation', label: 'Conversation', description: 'Available to all actors in a specific conversation' },
  { value: 'actor_global', label: 'Actor', description: 'Available to a specific actor across all conversations' },
  { value: 'actor_conversation', label: 'Actor + Conversation', description: 'Available only to a specific actor within one conversation' },
  { value: 'user', label: 'User', description: 'Installed privately by the current user and shareable later through grants' },
];

const lifecycleOptions: Record<string, { value: string; label: string }[]> = {
  workspace: [
    { value: 'workspace', label: 'Workspace (shared instance)' },
    { value: 'conversation', label: 'Conversation (per-conversation instance)' },
    { value: 'actor_global', label: 'Actor (shared across conversations)' },
    { value: 'actor_conversation', label: 'Actor + Conversation (scoped instance)' },
    { value: 'user', label: 'User (per-user shared instance)' },
    { value: 'turn', label: 'Turn (per-request instance)' },
  ],
  conversation: [
    { value: 'conversation', label: 'Conversation (shared instance)' },
    { value: 'actor_conversation', label: 'Actor + Conversation (scoped instance)' },
    { value: 'turn', label: 'Turn (per-request instance)' },
  ],
  actor_global: [
    { value: 'actor_global', label: 'Actor (shared across conversations)' },
    { value: 'actor_conversation', label: 'Actor + Conversation (scoped instance)' },
    { value: 'turn', label: 'Turn (per-request instance)' },
  ],
  actor_conversation: [
    { value: 'actor_conversation', label: 'Actor + Conversation (scoped instance)' },
    { value: 'turn', label: 'Turn (per-request instance)' },
  ],
  user: [
    { value: 'user', label: 'User (shared across your conversations)' },
    { value: 'workspace', label: 'Workspace (shared instance)' },
    { value: 'conversation', label: 'Conversation (per-conversation instance)' },
    { value: 'actor_global', label: 'Actor (shared across conversations)' },
    { value: 'actor_conversation', label: 'Actor + Conversation (scoped instance)' },
    { value: 'turn', label: 'Turn (per-request instance)' },
  ],
};

export default function InstallDialog({ plugin, defaultActorId, onClose }: Props) {
  const { workspaceId } = useWorkspace();
  const { installPlugin } = usePluginStore();
  const { user } = useAuthStore();
  const currentUserId = user?.id || user?.userId || '';

  const [scopeType, setScopeType] = useState(
    defaultActorId ? 'actor_global' : (plugin.default_binding_scope || 'workspace'),
  );
  const [lifecycleScope, setLifecycleScope] = useState(plugin.lifecycle_scope || 'conversation');
  const [selectedActorId, setSelectedActorId] = useState(defaultActorId || '');
  const [selectedConversationId, setSelectedConversationId] = useState('');
  const [actors, setActors] = useState<any[]>([]);
  const [conversations, setConversations] = useState<any[]>([]);
  const [configData, setConfigData] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const configSchema = plugin.config_schema || {};
  const properties = configSchema.properties || {};
  const hasConfig = Object.keys(properties).length > 0;
  const validationRules: ValidationRule[] = plugin.validation_rules || [];
  const setupSteps = plugin.setup_steps || [];

  useEffect(() => {
    if ((scopeType === 'actor_global' || scopeType === 'actor_conversation') && workspaceId) {
      api.getActors(workspaceId).then(setActors).catch(() => {});
    }
    if ((scopeType === 'conversation' || scopeType === 'actor_conversation') && workspaceId) {
      api.getGroups(workspaceId).then((res: any) => setConversations(res.groups || [])).catch(() => {});
    }
  }, [scopeType, workspaceId]);

  // Reset lifecycle when scope changes if current lifecycle is invalid
  useEffect(() => {
    const validOptions = lifecycleOptions[scopeType] || [];
    if (!validOptions.find(o => o.value === lifecycleScope)) {
      setLifecycleScope(validOptions[0]?.value || 'conversation');
    }
  }, [scopeType, lifecycleScope]);

  const handleInstall = async () => {
    if (!workspaceId) return;

    // Validate config
    if (validationRules.length > 0 && hasConfig) {
      const errors = runClientValidation(configData, validationRules);
      if (errors.length > 0) {
        const errMap: Record<string, string> = {};
        for (const e of errors) errMap[e.field] = e.message;
        setFieldErrors(errMap);
        return;
      }
    }

    if ((scopeType === 'actor_global' || scopeType === 'actor_conversation') && !selectedActorId) {
      alert('Please select an actor');
      return;
    }
    if ((scopeType === 'conversation' || scopeType === 'actor_conversation') && !selectedConversationId) {
      alert('Please select a conversation');
      return;
    }
    if (scopeType === 'user' && !currentUserId) {
      alert('Current user is unavailable. Please refresh and try again.');
      return;
    }

    setSaving(true);
    try {
      await installPlugin(workspaceId, {
        pluginId: plugin.id,
        scopeType: scopeType as 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user',
        actorId: scopeType === 'actor_global' || scopeType === 'actor_conversation' ? selectedActorId : undefined,
        conversationId: scopeType === 'conversation' || scopeType === 'actor_conversation' ? selectedConversationId : undefined,
        userId: scopeType === 'user' ? currentUserId : undefined,
        lifecycleScope: lifecycleScope as 'turn' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user',
        configData: hasConfig ? configData : undefined,
      });
      onClose();
    } catch (err: any) {
      alert('Install failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10 max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Install {plugin.display_name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Scope selector */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Install Scope</Label>
            <div className="grid grid-cols-2 gap-2">
              {scopeOptions.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setScopeType(opt.value)}
                  className={`p-2 rounded-lg border text-center text-xs transition-colors ${
                    scopeType === opt.value
                      ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                      : 'border-gray-200 dark:border-white/10 hover:border-blue-500/30 text-muted-foreground'
                  }`}
                >
                  <div className="font-medium">{opt.label}</div>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {scopeOptions.find(o => o.value === scopeType)?.description}
            </p>
          </div>

          {scopeType === 'actor_global' && (
            <div className="space-y-1">
              <Label className="text-sm">Select Actor</Label>
              <select
                className="w-full h-9 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-3 text-sm bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10"
                value={selectedActorId}
                onChange={(e) => setSelectedActorId(e.target.value)}
              >
                <option value="">Choose an actor...</option>
                {actors.map((actor: any) => (
                  <option key={actor.id} value={actor.id}>{actor.name} ({actor.role})</option>
                ))}
              </select>
            </div>
          )}

          {scopeType === 'conversation' && (
            <div className="space-y-1">
              <Label className="text-sm">Select Conversation</Label>
              <select
                className="w-full h-9 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-3 text-sm bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10"
                value={selectedConversationId}
                onChange={(e) => setSelectedConversationId(e.target.value)}
              >
                <option value="">Choose a conversation...</option>
                {conversations.map((conversation: any) => (
                  <option key={conversation.id} value={conversation.id}>{conversation.name}</option>
                ))}
              </select>
            </div>
          )}

          {scopeType === 'actor_conversation' && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-sm">Select Actor</Label>
                <select
                  className="w-full h-9 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-3 text-sm bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10"
                  value={selectedActorId}
                  onChange={(e) => setSelectedActorId(e.target.value)}
                >
                  <option value="">Choose an actor...</option>
                  {actors.map((actor: any) => (
                    <option key={actor.id} value={actor.id}>{actor.name} ({actor.role})</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-sm">Select Conversation</Label>
                <select
                  className="w-full h-9 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-3 text-sm bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10"
                  value={selectedConversationId}
                  onChange={(e) => setSelectedConversationId(e.target.value)}
                >
                  <option value="">Choose a conversation...</option>
                  {conversations.map((conversation: any) => (
                    <option key={conversation.id} value={conversation.id}>{conversation.name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {scopeType === 'user' && (
            <div className="space-y-1">
              <Label className="text-sm">Installed For</Label>
              <div className="h-9 rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-gray-900 px-3 text-sm flex items-center text-muted-foreground">
                {user?.name || user?.email || 'Current user'}
              </div>
            </div>
          )}

          {/* Lifecycle scope selector */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Instance Lifecycle</Label>
            <select
              className="w-full h-9 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-3 text-sm bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10"
              value={lifecycleScope}
              onChange={(e) => setLifecycleScope(e.target.value)}
            >
              {(lifecycleOptions[scopeType] || []).map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Config fields */}
          {hasConfig && (
            <div className="space-y-3 border-t border-gray-200 dark:border-white/10 pt-3">
              <Label className="text-sm font-medium">Configuration</Label>
              {Object.entries(properties).map(([key, schema]: [string, any]) => {
                const isSensitive = schema.sensitive === true;
                const error = fieldErrors[key];

                if (schema.type === 'boolean') {
                  return (
                    <div key={key} className="flex items-center justify-between py-1">
                      <div>
                        <Label className="text-sm">{schema.description || key}</Label>
                      </div>
                      <Switch
                        checked={!!configData[key]}
                        onCheckedChange={(v) => setConfigData(prev => ({ ...prev, [key]: v }))}
                      />
                    </div>
                  );
                }

                return (
                  <div key={key} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Label className="text-sm">{schema.description || key}</Label>
                      {(configSchema.required || []).includes(key) && <span className="text-xs text-red-400">*</span>}
                    </div>
                    <Input
                      type={isSensitive ? 'password' : 'text'}
                      value={configData[key] || ''}
                      onChange={(e) => {
                        setConfigData(prev => ({ ...prev, [key]: e.target.value }));
                        if (error) setFieldErrors(prev => { const n = { ...prev }; delete n[key]; return n; });
                      }}
                      placeholder={isSensitive ? '••••••••' : `Enter ${key}`}
                      className={`bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 ${error ? 'border-red-500/50' : 'border-gray-200 dark:border-white/10'}`}
                    />
                    {error && <p className="text-xs text-red-400">{error}</p>}
                  </div>
                );
              })}

              {/* Help from setup steps */}
              {setupSteps.length > 0 && setupSteps[0].helpUrl && (
                <div className="rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-blue-400">
                    <HelpCircle className="w-3.5 h-3.5" />
                    Help
                  </div>
                  {setupSteps[0].helpText && (
                    <p className="text-xs text-muted-foreground">{setupSteps[0].helpText}</p>
                  )}
                  <a
                    href={setupSteps[0].helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                  >
                    Open documentation <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <Button onClick={handleInstall} disabled={saving} className="flex-1">
              {saving ? 'Installing...' : 'Install'}
            </Button>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
