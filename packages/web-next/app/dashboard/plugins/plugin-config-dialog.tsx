'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CapabilityAuthProviderDefinition,
  CapabilityAuthSession,
  CapabilityBindingScope,
  CapabilityConfigFieldDefinition,
  CapabilityConfigFieldState,
  CapabilityReuseScope,
  LocalizedText,
} from '@synapse/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import { usePluginStore } from '@/stores/plugin-store';
import { useAuthStore } from '@/stores/auth-store';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { api } from '@/lib/api';
import {
  CapabilityBindingScopeStep,
  CapabilityReuseScopeStep,
  getAllowedReuseScopes,
  getConversationDisplayName,
} from '@/app/dashboard/capabilities/binding-visuals';

type AuthFieldState = {
  sessionId: string;
  providerKey: string;
  status: CapabilityAuthSession['status'];
  accountDisplayName?: string;
  errorMessage?: string;
};

interface Props {
  installation: any;
  onClose: () => void;
  presentation?: 'dialog' | 'page';
  onSuccess?: () => void;
}

const scopeLabels: Record<CapabilityBindingScope, string> = {
  platform: 'Platform',
  workspace: 'Workspace',
  conversation: 'Conversation',
  actor_global: 'Actor',
  actor_conversation: 'Actor + Conversation',
  user: 'User',
};

function normalizeActorOption(actor: any) {
  const definition = actor?.definition || actor;
  return {
    ...actor,
    id: actor.id,
    name: definition.name,
    title: definition.title,
    role: definition.role,
    config: definition.config || {},
  };
}

function getLocale(defaultLocale?: string) {
  if (typeof navigator !== 'undefined') {
    return navigator.languages?.[0] || navigator.language || defaultLocale || 'en';
  }
  return defaultLocale || 'en';
}

function translate(text: LocalizedText | undefined, locale: string, fallback?: string) {
  if (!text || Object.keys(text).length === 0) return fallback || '';
  return (
    text[locale] ||
    text[locale.split('-')[0]] ||
    (fallback ? text[fallback] : undefined) ||
    text.en ||
    Object.values(text)[0] ||
    ''
  );
}

function deriveConfigFields(installation: any): CapabilityConfigFieldDefinition[] {
  if (Array.isArray(installation.config_fields) && installation.config_fields.length > 0) {
    return installation.config_fields;
  }
  const schema = installation.config_schema || {};
  const properties = schema.properties || {};
  const requiredFields = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).map(([key, value]: [string, any]) => ({
    key,
    type: value.sensitive ? 'secret' : value.type === 'boolean' ? 'boolean' : 'text',
    titleI18n: { en: value.title || value.description || key },
    descriptionI18n: value.description ? { en: value.description } : undefined,
    required: requiredFields.has(key),
    defaultValue: installation.default_config?.[key],
    secret: value.sensitive === true,
  }));
}

export default function PluginConfigDialog({ installation, onClose, presentation = 'dialog', onSuccess }: Props) {
  const { workspaceId } = useWorkspace();
  const { updateInstallation } = usePluginStore();
  const { user } = useAuthStore();
  const currentUserId = user?.id || user?.userId || '';

  const locale = useMemo(() => getLocale(installation.default_locale), [installation.default_locale]);
  const configFields = useMemo(() => deriveConfigFields(installation), [installation]);
  const configState = useMemo<CapabilityConfigFieldState[]>(() => installation.config_state || [], [installation.config_state]);
  const authProviders = useMemo<CapabilityAuthProviderDefinition[]>(() => installation.auth_providers || [], [installation.auth_providers]);
  const authProviderMap = useMemo(() => new Map(authProviders.map((provider) => [provider.key, provider])), [authProviders]);
  const configStateMap = useMemo(() => new Map(configState.map((state) => [state.key, state])), [configState]);

  const [mode, setMode] = useState<'guided' | 'json'>('guided');
  const [configData, setConfigData] = useState<Record<string, any>>(installation.config_data || {});
  const [jsonText, setJsonText] = useState(JSON.stringify(installation.config_data || {}, null, 2));
  const [scopeType, setScopeType] = useState<CapabilityBindingScope>(installation.scope_type);
  const [selectedActorId, setSelectedActorId] = useState<string>(installation.actor_id || '');
  const [selectedConversationId, setSelectedConversationId] = useState<string>(installation.conversation_id || '');
  const [selectedUserId, setSelectedUserId] = useState<string>(installation.user_id || currentUserId);
  const [lifecycleScope, setLifecycleScope] = useState<CapabilityReuseScope>(installation.lifecycle_scope);
  const [isEnabled, setIsEnabled] = useState<boolean>(installation.is_enabled !== false);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [actors, setActors] = useState<any[]>([]);
  const [conversations, setConversations] = useState<any[]>([]);
  const [authFields, setAuthFields] = useState<Record<string, AuthFieldState>>({});
  const authPollers = useRef<Record<string, number>>({});

  const lifecycleOptions = getAllowedReuseScopes(scopeType);

  useEffect(() => {
    if (!workspaceId) return;
    if (scopeType === 'actor_global' || scopeType === 'actor_conversation') {
      api.getActors(workspaceId).then((result: any) => {
        const actorList = result?.actors ?? result ?? [];
        setActors(Array.isArray(actorList) ? actorList.map(normalizeActorOption) : []);
      }).catch(() => {});
    }
    if (scopeType === 'conversation' || scopeType === 'actor_conversation') {
      api.getGroups(workspaceId).then((res: any) => setConversations(
        (res.groups || []).map((conversation: any) => ({
          ...conversation,
          name: getConversationDisplayName(conversation),
        })),
      )).catch(() => {});
    }
  }, [scopeType, workspaceId]);

  useEffect(() => {
    if (!lifecycleOptions.includes(lifecycleScope)) {
      setLifecycleScope(lifecycleOptions[0] || 'conversation');
    }
  }, [lifecycleOptions, lifecycleScope, scopeType]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type !== 'synapse:mcp-auth' || typeof event.data.sessionId !== 'string') {
        return;
      }
      for (const [fieldKey, state] of Object.entries(authFields)) {
        if (state.sessionId === event.data.sessionId) {
          void refreshAuthField(fieldKey, state.sessionId);
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [authFields]);

  useEffect(() => () => {
    Object.values(authPollers.current).forEach((poller) => window.clearInterval(poller));
    authPollers.current = {};
  }, []);

  const refreshAuthField = async (fieldKey: string, sessionId: string) => {
    if (!workspaceId) return;
    try {
      const data = await api.getPluginAuthSession(workspaceId, sessionId);
      const session: CapabilityAuthSession = data.session;
      setAuthFields((previous) => ({
        ...previous,
        [fieldKey]: {
          sessionId,
          providerKey: previous[fieldKey]?.providerKey || '',
          status: session.status,
          accountDisplayName: typeof session.resultPreview?.displayName === 'string' ? session.resultPreview.displayName : undefined,
          errorMessage: session.errorMessage,
        },
      }));
      if (['completed', 'failed', 'expired', 'consumed'].includes(session.status) && authPollers.current[fieldKey]) {
        window.clearInterval(authPollers.current[fieldKey]);
        delete authPollers.current[fieldKey];
      }
    } catch (error: any) {
      setAuthFields((previous) => ({
        ...previous,
        [fieldKey]: {
          sessionId,
          providerKey: previous[fieldKey]?.providerKey || '',
          status: 'failed',
          errorMessage: error.message,
        },
      }));
      if (authPollers.current[fieldKey]) {
        window.clearInterval(authPollers.current[fieldKey]);
        delete authPollers.current[fieldKey];
      }
    }
  };

  const beginAuth = async (field: CapabilityConfigFieldDefinition) => {
    if (!workspaceId) return;
    const providerKey = field.authProviderKey;
    if (!providerKey) {
      setFieldErrors((previous) => ({ ...previous, [field.key]: 'No auth provider is configured for this field.' }));
      return;
    }
    const result = await api.startPluginAuth(workspaceId, installation.plugin_id, providerKey);
    const session: CapabilityAuthSession = result.session;
    setAuthFields((previous) => ({
      ...previous,
      [field.key]: {
        sessionId: session.id,
        providerKey,
        status: session.status,
      },
    }));

    if (authPollers.current[field.key]) {
      window.clearInterval(authPollers.current[field.key]);
    }
    authPollers.current[field.key] = window.setInterval(() => {
      void refreshAuthField(field.key, session.id);
    }, 2000);

    const popup = window.open(result.authorizeUrl, `mcp-auth-${field.key}`, 'width=720,height=820,noopener,noreferrer');
    if (!popup) {
      setFieldErrors((previous) => ({ ...previous, [field.key]: 'Popup blocked. Please allow popups and try again.' }));
    }
  };

  const handleGuidedChange = (key: string, value: any) => {
    setConfigData((previous) => ({ ...previous, [key]: value }));
    if (fieldErrors[key]) {
      setFieldErrors((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
  };

  const renderField = (field: CapabilityConfigFieldDefinition) => {
    const value = configData[field.key];
    const error = fieldErrors[field.key];
    const state = configStateMap.get(field.key);
    const authState = authFields[field.key];
    const provider = field.authProviderKey ? authProviderMap.get(field.authProviderKey) : undefined;
    const label = translate(field.titleI18n, locale, installation.default_locale || 'en') || field.key;
    const description = translate(field.descriptionI18n, locale, installation.default_locale || 'en');
    const placeholder = translate(field.placeholderI18n, locale, installation.default_locale || 'en');

    if (field.type === 'boolean') {
      return (
        <div key={field.key} className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-white/10 px-3 py-2">
          <div className="space-y-1 pr-3">
            <Label className="text-sm font-medium">{label}</Label>
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
          <Switch checked={Boolean(value)} onCheckedChange={(checked) => handleGuidedChange(field.key, checked)} />
        </div>
      );
    }

    if (field.type === 'select') {
      return (
        <div key={field.key} className="space-y-1">
          <Label className="text-sm font-medium">{label}</Label>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
          <select
            className="w-full h-9 rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-gray-900 px-3 text-sm"
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => handleGuidedChange(field.key, event.target.value)}
          >
            <option value="">Select...</option>
            {(field.options || []).map((option) => (
              <option key={option.value} value={option.value}>
                {translate(option.labelI18n, locale, installation.default_locale || 'en') || option.value}
              </option>
            ))}
          </select>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      );
    }

    if (field.type === 'textarea') {
      return (
        <div key={field.key} className="space-y-1">
          <Label className="text-sm font-medium">{label}</Label>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
          <Textarea
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => handleGuidedChange(field.key, event.target.value)}
            placeholder={placeholder}
            rows={4}
            className="bg-white dark:bg-gray-900"
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      );
    }

    if (field.type === 'oauth_connection') {
      const providerLabel = provider
        ? translate(provider.displayNameI18n, locale, installation.default_locale || 'en') || provider.key
        : field.authProviderKey || 'provider';
      const configuredName = authState?.accountDisplayName || state?.accountDisplayName;
      return (
        <div key={field.key} className="space-y-2 rounded-lg border border-gray-200 dark:border-white/10 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Label className="text-sm font-medium">{label}</Label>
                <Badge variant="outline">{providerLabel}</Badge>
              </div>
              {description && <p className="text-xs text-muted-foreground">{description}</p>}
              {(authState || state) && (
                <p className="text-xs text-muted-foreground">
                  {authState?.status === 'pending' && (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Waiting for authorization...
                    </span>
                  )}
                  {authState?.status === 'completed' && `Connected${configuredName ? ` as ${configuredName}` : ''}.`}
                  {!authState && state?.isConfigured && `Configured${configuredName ? ` as ${configuredName}` : ''}.`}
                  {authState?.status === 'failed' && (authState.errorMessage || 'Authorization failed.')}
                </p>
              )}
            </div>
            <Button type="button" variant="outline" onClick={() => beginAuth(field)}>
              {(authState?.status === 'completed' || state?.isConfigured) ? 'Reconnect' : 'Connect'}
            </Button>
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      );
    }

    const maskedValue = state?.maskedValue;
    const help = maskedValue ? `Current value: ${maskedValue}. Leave blank to keep it.` : undefined;
    return (
      <div key={field.key} className="space-y-1">
        <Label className="text-sm font-medium">{label}</Label>
        {(description || help) && (
          <p className="text-xs text-muted-foreground">
            {description}
            {description && help ? ' ' : ''}
            {help}
          </p>
        )}
        <Input
          type={field.type === 'number' ? 'number' : field.type === 'secret' ? 'password' : 'text'}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(event) => handleGuidedChange(field.key, field.type === 'number' ? Number(event.target.value) : event.target.value)}
          placeholder={field.type === 'secret' && maskedValue ? maskedValue : placeholder}
          className="bg-white dark:bg-gray-900"
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    );
  };

  const handleSave = async () => {
    if (!workspaceId) return;
    setSaving(true);
    setFieldErrors({});
    try {
      const data = mode === 'json' ? JSON.parse(jsonText) : configData;
      const authSessionIds = Object.fromEntries(
        Object.entries(authFields)
          .filter(([, state]) => state.status === 'completed')
          .map(([fieldKey, state]) => [fieldKey, state.sessionId]),
      );

      const updateData: any = {
        authSessionIds: Object.keys(authSessionIds).length > 0 ? authSessionIds : undefined,
      };

      if (configFields.length > 0) {
        updateData.configData = data;
      }
      if (lifecycleScope !== installation.lifecycle_scope) updateData.lifecycleScope = lifecycleScope;
      if (isEnabled !== (installation.is_enabled !== false)) updateData.isEnabled = isEnabled;
      if (
        scopeType !== installation.scope_type ||
        selectedActorId !== (installation.actor_id || '') ||
        selectedConversationId !== (installation.conversation_id || '') ||
        selectedUserId !== (installation.user_id || '')
      ) {
        updateData.scopeType = scopeType;
        updateData.actorId = scopeType === 'actor_global' || scopeType === 'actor_conversation' ? selectedActorId : null;
        updateData.conversationId = scopeType === 'conversation' || scopeType === 'actor_conversation' ? selectedConversationId : null;
        updateData.userId = scopeType === 'user' ? selectedUserId || currentUserId : null;
      }

      await updateInstallation(workspaceId, installation.id, updateData);
      onSuccess?.();
      onClose();
    } catch (error: any) {
      alert(`Failed to save config: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const content = (
    <div className="space-y-4">
      {presentation === 'page' ? (
        <div className="space-y-1">
          <h2 className="text-xl font-semibold text-foreground">
            {translate(installation.plugin_display_name_i18n, locale, installation.default_locale || 'en') || installation.plugin_display_name}
          </h2>
          <p className="text-sm text-muted-foreground">
            Update this installation directly or reconnect any required authorizations.
          </p>
        </div>
      ) : null}

      <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{scopeLabels[scopeType]}</Badge>
            <Badge variant="outline">{lifecycleScope}</Badge>
            <Badge variant={isEnabled ? 'default' : 'secondary'}>{isEnabled ? 'Enabled' : 'Disabled'}</Badge>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-white/10 px-3 py-2">
            <div>
              <Label className="text-sm font-medium">Enable plugin</Label>
              <p className="text-xs text-muted-foreground">Disable this plugin without removing the installation.</p>
            </div>
            <Switch checked={isEnabled} onCheckedChange={setIsEnabled} />
          </div>

          <div className="space-y-4">
            <CapabilityBindingScopeStep
              value={scopeType}
              onChange={setScopeType}
              actors={actors}
              conversations={conversations}
              selectedActorId={selectedActorId}
              onActorChange={setSelectedActorId}
              selectedConversationId={selectedConversationId}
              onConversationChange={setSelectedConversationId}
              currentUserLabel={user?.name || user?.email || 'You'}
            />

            <CapabilityReuseScopeStep
              bindingScope={scopeType}
              value={lifecycleScope}
              onChange={setLifecycleScope}
              actors={actors}
              conversations={conversations}
              selectedActorId={selectedActorId}
              selectedConversationId={selectedConversationId}
            />
          </div>

          {configFields.length > 0 ? (
            <Tabs value={mode} onValueChange={(value) => setMode(value as 'guided' | 'json')}>
              <TabsList className="w-full">
                <TabsTrigger value="guided" className="flex-1">Guided</TabsTrigger>
                <TabsTrigger value="json" className="flex-1">JSON</TabsTrigger>
              </TabsList>

              <TabsContent value="guided" className="mt-4 space-y-4">
                {configFields.map((field) => renderField(field))}
              </TabsContent>

              <TabsContent value="json" className="mt-4">
                <Textarea
                  value={jsonText}
                  onChange={(event) => setJsonText(event.target.value)}
                  rows={10}
                  className="font-mono text-xs"
                />
              </TabsContent>
            </Tabs>
          ) : (
            <p className="text-sm text-muted-foreground">This plugin has no configurable options.</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
      </div>
    </div>
  );

  if (presentation === 'page') {
    return <div className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-gray-900">{content}</div>;
  }

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto bg-white dark:bg-gray-900">
        <DialogHeader>
          <DialogTitle>{translate(installation.plugin_display_name_i18n, locale, installation.default_locale || 'en') || installation.plugin_display_name}</DialogTitle>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}
