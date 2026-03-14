'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ExclamationCircleIcon } from '@heroicons/react/16/solid';
import type {
  CapabilityAttachmentType,
  CapabilityAuthProviderDefinition,
  CapabilityAuthSession,
  CapabilityConfigFieldDefinition,
  CapabilityInstallStep,
  CapabilityReuseScope,
  LocalizedText,
} from '@synapse/shared';
import { AppCard } from '@/components/app-card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { ExternalLink, HelpCircle, Loader2 } from 'lucide-react';
import { usePluginStore } from '@/stores/plugin-store';
import { useAuthStore } from '@/stores/auth-store';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { api } from '@/lib/api';
import PluginAccessStep from './plugin-access-step';
import { PluginIcon } from './plugin-ui';
import {
  CapabilityAttachmentTypeStep,
  CapabilityReuseScopeStep,
  getConversationDisplayName,
} from '@/app/dashboard/capabilities/attachment-visuals';

interface ValidationRule {
  field: string;
  rule: string;
  value?: string | number | string[];
  message: string;
}

interface Props {
  plugin: any;
  defaultActorId?: string;
  initialInstallation?: any;
  onClose: () => void;
  presentation?: 'dialog' | 'page';
  onSuccess?: (installation: any) => void | Promise<void>;
  onInstallationSaved?: (installation: any) => void | Promise<void>;
  showPluginHeader?: boolean;
  pageChrome?: 'card' | 'plain';
}

type PluginAttachmentType = Exclude<CapabilityAttachmentType, 'platform'>;
type PluginReuseScope = Exclude<CapabilityReuseScope, 'platform'>;
type AccessStep = {
  id: 'access';
  kind: 'access';
  titleI18n: LocalizedText;
  descriptionI18n?: LocalizedText;
  scope: 'plugin';
  fields: [];
  optional?: boolean;
  helpUrl?: string;
  helpTextI18n?: LocalizedText;
  action?: undefined;
  metadata?: Record<string, unknown>;
};
type InstallFlowStep = CapabilityInstallStep | AccessStep;

type AuthFieldState = {
  sessionId: string;
  providerKey: string;
  status: CapabilityAuthSession['status'];
  accountDisplayName?: string;
  errorMessage?: string;
  authConnectionId?: string;
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

const installLifecycleOptionMap: Record<PluginAttachmentType, PluginReuseScope[]> = {
  workspace: ['workspace', 'conversation', 'actor_global', 'user', 'turn'],
  conversation: ['conversation', 'actor_conversation', 'turn'],
  actor_global: ['actor_global', 'turn'],
  actor_conversation: ['actor_conversation', 'turn'],
  user: ['user', 'conversation', 'actor_conversation', 'turn'],
};

function getInstallAllowedReuseScopes(attachmentType: PluginAttachmentType) {
  return installLifecycleOptionMap[attachmentType] || ['turn'];
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

function deriveConfigFields(plugin: any): CapabilityConfigFieldDefinition[] {
  if (Array.isArray(plugin.config_fields) && plugin.config_fields.length > 0) {
    return plugin.config_fields;
  }
  const schema = plugin.config_schema || {};
  const properties = schema.properties || {};
  const requiredFields = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).map(([key, value]: [string, any]) => ({
    key,
    type: value.sensitive ? 'secret' : value.type === 'boolean' ? 'boolean' : 'text',
    titleI18n: { en: value.title || value.description || key },
    descriptionI18n: value.description ? { en: value.description } : undefined,
    required: requiredFields.has(key),
    defaultValue: plugin.default_config?.[key],
    secret: value.sensitive === true,
  }));
}

function deriveInstallFlow(plugin: any, configFields: CapabilityConfigFieldDefinition[], locale: string): CapabilityInstallStep[] {
  const baseSteps = Array.isArray(plugin.install_flow?.steps) && plugin.install_flow.steps.length > 0
    ? plugin.install_flow.steps.filter((step: CapabilityInstallStep) => step.kind !== 'confirm')
    : [{
        id: 'configure',
        kind: 'form' as const,
        titleI18n: { [locale]: 'Configure plugin' },
        descriptionI18n: { [locale]: 'Provide the required configuration for this plugin.' },
        scope: 'plugin',
        fields: configFields.map((field) => field.key),
      }];

  return [
    ...baseSteps,
    {
      id: 'attachment-scope',
      kind: 'attachment_scope',
      titleI18n: { [locale]: 'Choose owner' },
      descriptionI18n: { [locale]: 'Choose where this installation belongs. Access is set later.' },
      scope: 'plugin',
      fields: [],
    },
    {
      id: 'reuse-scope',
      kind: 'reuse_scope',
      titleI18n: { [locale]: 'Choose lifecycle' },
      descriptionI18n: { [locale]: 'Decide how runtimes are reused.' },
      scope: 'plugin',
      fields: [],
    },
  ];
}

function buildInitialConfig(plugin: any, configFields: CapabilityConfigFieldDefinition[]) {
  const initial = { ...(plugin.default_config || {}) } as Record<string, unknown>;
  for (const field of configFields) {
    if (initial[field.key] !== undefined) continue;
    if (field.defaultValue !== undefined) {
      initial[field.key] = field.defaultValue;
      continue;
    }
    if (field.type === 'boolean') {
      initial[field.key] = false;
    }
  }
  return initial;
}

function runClientValidation(
  config: Record<string, unknown>,
  authFields: Record<string, AuthFieldState>,
  rules: ValidationRule[],
  configFields: CapabilityConfigFieldDefinition[],
  fieldKeys?: string[],
) {
  const errors: Record<string, string> = {};
  const allowed = fieldKeys ? new Set(fieldKeys) : null;

  for (const field of configFields) {
    if (allowed && !allowed.has(field.key)) continue;
    const value = config[field.key];
    if (field.required) {
      if (field.type === 'oauth_connection') {
        if (!authFields[field.key] || authFields[field.key].status !== 'completed') {
          errors[field.key] = 'Authorization is required.';
        }
      } else if (field.type === 'boolean') {
        continue;
      } else if (value === undefined || value === null || value === '') {
        errors[field.key] = 'This field is required.';
      }
    }
  }

  for (const rule of rules) {
    if (allowed && !allowed.has(rule.field)) continue;
    const value = config[rule.field];
    if (errors[rule.field]) continue;
    switch (rule.rule) {
      case 'required':
        if (value === undefined || value === null || value === '') errors[rule.field] = rule.message;
        break;
      case 'min_length':
        if (typeof value === 'string' && value.length < Number(rule.value)) errors[rule.field] = rule.message;
        break;
      case 'max_length':
        if (typeof value === 'string' && value.length > Number(rule.value)) errors[rule.field] = rule.message;
        break;
      case 'pattern':
        if (typeof value === 'string' && rule.value && !new RegExp(String(rule.value)).test(value)) {
          errors[rule.field] = rule.message;
        }
        break;
    }
  }

  return errors;
}

export default function InstallDialog({
  plugin,
  defaultActorId,
  initialInstallation,
  onClose,
  presentation = 'dialog',
  onSuccess,
  onInstallationSaved,
  showPluginHeader = true,
  pageChrome = 'card',
}: Props) {
  const { workspaceId } = useWorkspace();
  const { installPlugin, updateInstallation } = usePluginStore();
  const { user } = useAuthStore();
  const currentUserId = user?.id || user?.userId || '';

  const locale = useMemo(() => getLocale(plugin.default_locale), [plugin.default_locale]);
  const configFields = useMemo(() => deriveConfigFields(plugin), [plugin]);
  const setupSteps = useMemo(() => deriveInstallFlow(plugin, configFields, locale), [plugin, configFields, locale]);
  const authProviders = useMemo<CapabilityAuthProviderDefinition[]>(() => plugin.auth_providers || [], [plugin.auth_providers]);
  const authProviderMap = useMemo(() => new Map(authProviders.map((provider) => [provider.key, provider])), [authProviders]);
  const allowedAttachmentTypes = useMemo<PluginAttachmentType[]>(
    () => ['workspace', 'conversation', 'actor_global', 'actor_conversation', 'user'],
    [],
  );
  const initialAttachmentType = initialInstallation?.attachment_type as PluginAttachmentType | undefined;
  const initialAttachmentActorId = initialInstallation?.attachment_actor_id || '';
  const initialAttachmentConversationId = initialInstallation?.attachment_conversation_id || '';

  const [selectedAttachmentType, setSelectedAttachmentType] = useState<PluginAttachmentType>(
    initialAttachmentType ||
    ((defaultActorId ? 'actor_global' : (plugin.default_instance_scope || 'workspace')) as PluginAttachmentType),
  );
  const [lifecycleScope, setLifecycleScope] = useState<PluginReuseScope>(
    ((initialInstallation?.lifecycle_scope as PluginReuseScope | undefined) ||
      plugin.lifecycle_scope ||
      plugin.default_reuse_scope ||
      'conversation') as PluginReuseScope,
  );
  const [selectedActorId, setSelectedActorId] = useState(initialAttachmentActorId || defaultActorId || '');
  const [selectedConversationId, setSelectedConversationId] = useState(initialAttachmentConversationId || '');
  const [actors, setActors] = useState<any[]>([]);
  const [conversations, setConversations] = useState<any[]>([]);
  const [configData, setConfigData] = useState<Record<string, unknown>>(() => ({
    ...buildInitialConfig(plugin, configFields),
    ...(initialInstallation?.config_data || {}),
  }));
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [authFields, setAuthFields] = useState<Record<string, AuthFieldState>>({});
  const [currentInstallation, setCurrentInstallation] = useState<any>(initialInstallation || null);
  const authPollers = useRef<Record<string, number>>({});

  const validationRules: ValidationRule[] = plugin.validation_rules || [];
  const installSteps = useMemo<InstallFlowStep[]>(() => {
    if (presentation !== 'page') {
      return setupSteps;
    }

    return [
      ...setupSteps,
      {
        id: 'access',
        kind: 'access',
        titleI18n: { [locale]: 'Access' },
        descriptionI18n: { [locale]: 'Grant this installation to the users, actors, and conversations that should be able to use it.' },
        scope: 'plugin',
        fields: [],
      },
    ];
  }, [locale, presentation, setupSteps]);
  const currentStep = installSteps[currentStepIndex];
  const accessStepIndex = useMemo(
    () => installSteps.findIndex((step) => step.kind === 'access'),
    [installSteps],
  );
  const lastSetupStepIndex = setupSteps.length - 1;
  const installLifecycleOptions = useMemo(
    () => getInstallAllowedReuseScopes(selectedAttachmentType),
    [selectedAttachmentType],
  );

  useEffect(() => {
    if ((selectedAttachmentType === 'actor_global' || selectedAttachmentType === 'actor_conversation') && workspaceId) {
      api.getActors(workspaceId).then((result: any) => {
        const actorList = result?.actors ?? result ?? [];
        setActors(Array.isArray(actorList) ? actorList.map(normalizeActorOption) : []);
      }).catch(() => {});
    }
    if ((selectedAttachmentType === 'conversation' || selectedAttachmentType === 'actor_conversation') && workspaceId) {
      api.getGroups(workspaceId).then((res: any) => setConversations(
        (res.groups || []).map((conversation: any) => ({
          ...conversation,
          name: getConversationDisplayName(conversation),
        })),
      )).catch(() => {});
    }
  }, [selectedAttachmentType, workspaceId]);

  useEffect(() => {
    const valid = installLifecycleOptions;
    if (!valid.includes(lifecycleScope)) {
      setLifecycleScope((valid[0] || 'conversation') as PluginReuseScope);
    }
  }, [installLifecycleOptions, lifecycleScope]);

  useEffect(() => {
    setCurrentInstallation(initialInstallation || null);
  }, [initialInstallation]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type !== 'synapse:mcp-auth' || typeof event.data.sessionId !== 'string') {
        return;
      }
      for (const [fieldKey, state] of Object.entries(authFields)) {
        if (state.sessionId === event.data.sessionId) {
          void refreshAuthField(fieldKey, event.data.sessionId);
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
          authConnectionId: session.authConnectionId,
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

  const beginAuth = async (field: CapabilityConfigFieldDefinition, providerKey?: string) => {
    if (!workspaceId) return;
    const resolvedProviderKey = providerKey || field.authProviderKey;
    if (!resolvedProviderKey) {
      setFieldErrors((previous) => ({ ...previous, [field.key]: 'No auth provider is configured for this field.' }));
      return;
    }

    const result = await api.startPluginAuth(workspaceId, plugin.id, resolvedProviderKey);
    const session: CapabilityAuthSession = result.session;
    setAuthFields((previous) => ({
      ...previous,
      [field.key]: {
        sessionId: session.id,
        providerKey: resolvedProviderKey,
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

  const handleFieldChange = (key: string, value: unknown) => {
    setConfigData((previous) => ({ ...previous, [key]: value }));
    if (fieldErrors[key]) {
      setFieldErrors((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
  };

  const validateCurrentState = (fieldKeys?: string[]) => {
    const errors = runClientValidation(configData, authFields, validationRules, configFields, fieldKeys);

    if ((selectedAttachmentType === 'actor_global' || selectedAttachmentType === 'actor_conversation') && !selectedActorId) {
      errors.__scope = 'Please select an actor.';
    }
    if ((selectedAttachmentType === 'conversation' || selectedAttachmentType === 'actor_conversation') && !selectedConversationId) {
      errors.__scope = 'Please select a conversation.';
    }
    if (selectedAttachmentType === 'user' && !currentUserId) {
      errors.__scope = 'Current user is unavailable. Please refresh and try again.';
    }
    return errors;
  };

  const nextStep = () => {
    const errors = validateCurrentState(currentStep?.fields || []);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setCurrentStepIndex((index) => Math.min(index + 1, installSteps.length - 1));
  };

  const previousStep = () => {
    setCurrentStepIndex((index) => Math.max(index - 1, 0));
  };

  const persistInstallation = async ({ continueToAccess = false }: { continueToAccess?: boolean } = {}) => {
    if (!workspaceId) return;

    const errors = validateCurrentState();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    try {
      const authSessionIds = Object.fromEntries(
        Object.entries(authFields)
          .filter(([, state]) => state.status === 'completed')
          .map(([fieldKey, state]) => [fieldKey, state.sessionId]),
      );

      let installation: any;
      const installationId = currentInstallation?.id || initialInstallation?.id;

      if (installationId) {
        installation = await updateInstallation(workspaceId, installationId, {
          attachmentType: selectedAttachmentType,
          actorId: selectedAttachmentType === 'actor_global' || selectedAttachmentType === 'actor_conversation' ? selectedActorId : null,
          conversationId: selectedAttachmentType === 'conversation' || selectedAttachmentType === 'actor_conversation' ? selectedConversationId : null,
          userId: selectedAttachmentType === 'user' ? currentUserId : null,
          lifecycleScope,
          configData,
          authSessionIds: Object.keys(authSessionIds).length > 0 ? authSessionIds : undefined,
        });
      } else {
        installation = await installPlugin(workspaceId, {
          pluginId: plugin.id,
          attachmentType: selectedAttachmentType,
          actorId: selectedAttachmentType === 'actor_global' || selectedAttachmentType === 'actor_conversation' ? selectedActorId : undefined,
          conversationId: selectedAttachmentType === 'conversation' || selectedAttachmentType === 'actor_conversation' ? selectedConversationId : undefined,
          userId: selectedAttachmentType === 'user' ? currentUserId : undefined,
          lifecycleScope,
          configData,
          authSessionIds: Object.keys(authSessionIds).length > 0 ? authSessionIds : undefined,
        });
      }
      setCurrentInstallation(installation);
      await onInstallationSaved?.(installation);

      if (continueToAccess && accessStepIndex >= 0) {
        setCurrentStepIndex(accessStepIndex);
      } else if (onSuccess) {
        await onSuccess(installation);
      } else {
        onClose();
      }
    } catch (error: any) {
      alert(`Install failed: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const finalizeFlow = async () => {
    if (onSuccess && currentInstallation) {
      await onSuccess(currentInstallation);
      return;
    }

    onClose();
  };

  const renderStepBreadcrumbs = () => (
    <Breadcrumb>
      <BreadcrumbList className="gap-2">
        {installSteps.map((step, index) => {
          const label = translate(step.titleI18n, locale, plugin.default_locale || 'en') || step.id;
          const isCurrent = index === currentStepIndex;
          const isComplete = index < currentStepIndex;

          return (
            <Fragment key={step.id}>
              <BreadcrumbItem>
                {isCurrent ? (
                  <BreadcrumbPage className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium">
                    {label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <button
                      type="button"
                      onClick={() => {
                        if (step.kind === 'access' && !currentInstallation) return;
                        setCurrentStepIndex(index);
                      }}
                      disabled={step.kind === 'access' && !currentInstallation}
                      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium"
                    >
                      <span>{label}</span>
                    </button>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {index < installSteps.length - 1 ? <BreadcrumbSeparator /> : null}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );

  const renderStepAction = () => {
    if (!currentStep?.action) return null;
    if (currentStep.action.kind === 'oauth_authorize') {
      const providerKey = currentStep.action.providerKey;
      const field = configFields.find((item) => item.authProviderKey === providerKey || item.key === providerKey);
      if (!field) return null;
      return (
        <div className="rounded-lg border border-gray-200 dark:border-white/10 p-3">
          <Button type="button" variant="outline" onClick={() => beginAuth(field, providerKey)} className="w-full">
            {translate(currentStep.action.buttonLabelI18n, locale, plugin.default_locale || 'en') || 'Authorize'}
          </Button>
        </div>
      );
    }
    if (currentStep.action.kind === 'external_link' && currentStep.action.url) {
      return (
        <div className="rounded-lg border border-gray-200 dark:border-white/10 p-3">
          <a
            href={currentStep.action.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-blue-500 hover:text-blue-400"
          >
            {translate(currentStep.action.buttonLabelI18n, locale, plugin.default_locale || 'en') || 'Open link'}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      );
    }
    return null;
  };

  const renderField = (field: CapabilityConfigFieldDefinition) => {
    const value = configData[field.key];
    const error = fieldErrors[field.key];
    const provider = field.authProviderKey ? authProviderMap.get(field.authProviderKey) : undefined;
    const authState = authFields[field.key];
    const label = translate(field.titleI18n, locale, plugin.default_locale || 'en') || field.key;
    const description = translate(field.descriptionI18n, locale, plugin.default_locale || 'en');
    const placeholder = translate(field.placeholderI18n, locale, plugin.default_locale || 'en');

    if (field.type === 'boolean') {
      const fieldId = `config-${field.key}`;
      const descriptionId = `${fieldId}-description`;
      return (
        <div key={field.key} className="space-y-2">
          <div className="flex gap-3">
            <div className="flex h-6 shrink-0 items-center">
              <Checkbox
                id={fieldId}
                checked={Boolean(value)}
                onCheckedChange={(checked) => handleFieldChange(field.key, checked === true)}
                aria-describedby={description ? descriptionId : undefined}
              />
            </div>
            <div className="text-sm/6">
              <label htmlFor={fieldId} className="font-medium text-gray-900 dark:text-white">
                {label}
                {field.required && <span className="ml-1 text-xs text-red-500">*</span>}
              </label>
              {description && (
                <p id={descriptionId} className="text-gray-500 dark:text-gray-400">
                  {description}
                </p>
              )}
            </div>
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
      );
    }

    if (field.type === 'select') {
      return (
        <div key={field.key} className="space-y-1">
          <div className="flex items-center gap-2">
            <Label className="block text-sm/6 font-medium text-gray-900 dark:text-white">{label}</Label>
            {field.required && <span className="text-xs text-red-500">*</span>}
          </div>
          {description && <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{description}</p>}
          <div className="mt-2 grid grid-cols-1">
            <select
              className={`col-start-1 row-start-1 block w-full appearance-none rounded-md bg-white py-1.5 pl-3 text-base outline-1 -outline-offset-1 sm:text-sm/6 dark:bg-white/5 ${
                error
                  ? 'pr-10 text-red-900 outline-red-300 focus:outline-2 focus:-outline-offset-2 focus:outline-red-600 dark:text-red-400 dark:outline-red-500/50 dark:focus:outline-red-400'
                  : 'pr-8 text-gray-900 outline-gray-300 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:text-white dark:outline-white/10 dark:focus:outline-indigo-500'
              }`}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => handleFieldChange(field.key, event.target.value)}
            >
              <option value="">Select...</option>
              {(field.options || []).map((option) => (
                <option key={option.value} value={option.value}>
                  {translate(option.labelI18n, locale, plugin.default_locale || 'en') || option.value}
                </option>
              ))}
            </select>
            {error && (
              <ExclamationCircleIcon
                aria-hidden="true"
                className="pointer-events-none col-start-1 row-start-1 mr-3 size-5 self-center justify-self-end text-red-500 sm:size-4 dark:text-red-400"
              />
            )}
          </div>
          {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
      );
    }

    if (field.type === 'textarea') {
      return (
        <div key={field.key} className="space-y-1">
          <div className="flex items-center gap-2">
            <Label className="block text-sm/6 font-medium text-gray-900 dark:text-white">{label}</Label>
            {field.required && <span className="text-xs text-red-500">*</span>}
          </div>
          {description && <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{description}</p>}
          <Textarea
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => handleFieldChange(field.key, event.target.value)}
            placeholder={placeholder}
            rows={4}
            className={`mt-2 block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 placeholder:text-gray-400 outline-1 -outline-offset-1 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:placeholder:text-gray-500 ${
              error
                ? 'outline-red-300 focus:outline-2 focus:-outline-offset-2 focus:outline-red-600 dark:outline-red-500/50 dark:text-red-400 dark:placeholder:text-red-400/70 dark:focus:outline-red-400'
                : 'outline-gray-300 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:outline-white/10 dark:focus:outline-indigo-500'
            }`}
          />
          {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
      );
    }

    if (field.type === 'oauth_connection') {
      const providerLabel = provider
        ? translate(provider.displayNameI18n, locale, plugin.default_locale || 'en') || provider.key
        : field.authProviderKey || 'provider';
      return (
        <div key={field.key} className="space-y-2 rounded-lg border border-gray-200 dark:border-white/10 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Label className="block text-sm/6 font-medium text-gray-900 dark:text-white">{label}</Label>
                {field.required && <span className="text-xs text-red-500">*</span>}
                <Badge variant="outline">{providerLabel}</Badge>
              </div>
              {description && <p className="text-sm text-gray-500 dark:text-gray-400">{description}</p>}
            </div>
            <Button type="button" variant="outline" onClick={() => beginAuth(field)} className="shrink-0">
              {authState?.status === 'completed' ? 'Reconnect' : 'Connect'}
            </Button>
          </div>
          {authState && (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {authState.status === 'pending' && (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Waiting for authorization...
                </span>
              )}
              {authState.status === 'completed' && (
                <span>Connected{authState.accountDisplayName ? ` as ${authState.accountDisplayName}` : ''}.</span>
              )}
              {authState.status === 'failed' && <span className="text-red-500">{authState.errorMessage || 'Authorization failed.'}</span>}
              {authState.status === 'expired' && <span className="text-red-500">Authorization session expired. Start again.</span>}
            </div>
          )}
          {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
      );
    }

    const inputType = field.type === 'number' ? 'number' : field.type === 'secret' ? 'password' : 'text';
    return (
      <div key={field.key} className="space-y-1">
        <div className="flex items-center gap-2">
          <Label className="block text-sm/6 font-medium text-gray-900 dark:text-white">{label}</Label>
          {field.required && <span className="text-xs text-red-500">*</span>}
        </div>
        {description && <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{description}</p>}
        <div className="mt-2 grid grid-cols-1">
          <Input
            type={inputType}
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(event) => handleFieldChange(field.key, field.type === 'number' ? Number(event.target.value) : event.target.value)}
            placeholder={placeholder}
            aria-invalid={error ? 'true' : 'false'}
            className={`col-start-1 row-start-1 ${
              error
                ? 'pr-10 border-red-300 text-red-900 placeholder:text-red-300 focus-visible:ring-red-600 dark:border-red-500/50 dark:text-red-400 dark:placeholder:text-red-400/70 dark:focus-visible:ring-red-400'
                : 'pr-10'
            }`}
          />
          {error && (
            <ExclamationCircleIcon
              aria-hidden="true"
              className="pointer-events-none col-start-1 row-start-1 mr-3 size-5 self-center justify-self-end text-red-500 sm:size-4 dark:text-red-400"
            />
          )}
        </div>
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  };

  const renderStepBody = () => (
    <div className="space-y-5">
        {currentStep && (
          <div className="space-y-3">
            <div className="space-y-1">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                {translate(currentStep.titleI18n, locale, plugin.default_locale || 'en') || currentStep.id}
              </h3>
              {currentStep.descriptionI18n && (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {translate(currentStep.descriptionI18n, locale, plugin.default_locale || 'en')}
                </p>
              )}
            </div>
            {currentStep.helpUrl && (
              <a
                href={currentStep.helpUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-500 hover:text-blue-400"
              >
                <HelpCircle className="h-3.5 w-3.5" />
                {translate(currentStep.helpTextI18n, locale, plugin.default_locale || 'en') || 'Open setup guide'}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}

        {currentStep?.kind === 'attachment_scope' && (
          <div className="space-y-4">
            <CapabilityAttachmentTypeStep
              value={selectedAttachmentType}
              onChange={(value) => setSelectedAttachmentType(value as PluginAttachmentType)}
              allowedScopes={allowedAttachmentTypes}
              actors={actors}
              conversations={conversations}
              selectedActorId={selectedActorId}
              onActorChange={setSelectedActorId}
              selectedConversationId={selectedConversationId}
              onConversationChange={setSelectedConversationId}
              error={fieldErrors.__scope}
            />
          </div>
        )}

        {currentStep?.kind === 'reuse_scope' && (
          <CapabilityReuseScopeStep
            attachmentType={selectedAttachmentType}
            value={lifecycleScope}
            onChange={(value) => setLifecycleScope(value as PluginReuseScope)}
            actors={actors}
            conversations={conversations}
            selectedActorId={selectedActorId}
            selectedConversationId={selectedConversationId}
            allowedReuseScopes={installLifecycleOptions}
          />
        )}

        {currentStep?.kind === 'access' && (
          <PluginAccessStep installation={currentInstallation} />
        )}

        {(currentStep?.kind === 'form' || currentStep?.kind === 'oauth' || currentStep?.kind === 'check') && currentStep?.fields.length > 0 && (
          <div className="space-y-4 border-t border-gray-200 pt-4 dark:border-white/10">
            {currentStep.fields.map((fieldKey) => {
              const field = configFields.find((item) => item.key === fieldKey);
              return field ? renderField(field) : null;
            })}
          </div>
        )}

    </div>
  );

  const renderStepFooter = () => (
    <div className="flex items-center justify-between gap-2">
      <Button variant="outline" onClick={onClose}>
        {currentStep?.kind === 'access' ? 'Close' : 'Cancel'}
      </Button>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={previousStep} disabled={currentStepIndex === 0 || saving}>
          Back
        </Button>
        {currentStep?.kind === 'access' ? (
          <Button onClick={finalizeFlow} disabled={saving}>
            Done
          </Button>
        ) : currentStepIndex < lastSetupStepIndex ? (
          <Button onClick={nextStep} disabled={saving}>
            Next
          </Button>
        ) : (
          <Button onClick={() => persistInstallation({ continueToAccess: presentation === 'page' && accessStepIndex >= 0 })} disabled={saving}>
            {saving
              ? (currentInstallation || initialInstallation ? 'Saving...' : 'Installing...')
              : presentation === 'page' && accessStepIndex >= 0
                ? (currentInstallation || initialInstallation ? 'Save & Continue to Access' : 'Install & Continue to Access')
                : (currentInstallation || initialInstallation ? 'Save Setup' : 'Install')}
          </Button>
        )}
      </div>
    </div>
  );

  const pageContent = (
    <>
      {showPluginHeader ? (
        <div className="border-b border-gray-200 px-6 py-6 dark:border-white/10">
          <div className="flex">
            <div className="mr-4 shrink-0">
              <PluginIcon
                iconUrl={plugin.icon_url}
                title={translate(plugin.display_name_i18n, locale, plugin.default_locale || 'en') || plugin.display_name}
                transport={plugin.transport}
                className="h-8 w-8"
                containerClassName="h-16 w-16 rounded-none border border-gray-300 bg-white dark:border-white/15 dark:bg-gray-900"
              />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                {translate(plugin.display_name_i18n, locale, plugin.default_locale || 'en') || plugin.display_name}
              </h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {translate(plugin.description_i18n, locale, plugin.default_locale || 'en') || 'Install this plugin by following its guided setup flow.'}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className={pageChrome === 'card' ? 'flex min-h-0 flex-1 flex-col' : 'flex min-h-0 flex-1 flex-col'}>
        <div className="sticky top-0 z-10 border-b border-gray-200 bg-card px-6 py-4 dark:border-white/10">
          {renderStepBreadcrumbs()}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-6 py-6">
            {renderStepBody()}
          </div>
        </ScrollArea>
        <div className="border-t border-gray-200 px-6 py-4 dark:border-white/10">
          {renderStepFooter()}
        </div>
      </div>
    </>
  );

  const content = presentation === 'page' ? (
    pageChrome === 'card' ? (
      <AppCard variant="panel" className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        {pageContent}
      </AppCard>
    ) : (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">{pageContent}</div>
    )
  ) : (
    <div className="space-y-5">
      {renderStepBody()}
      {renderStepFooter()}
    </div>
  );

  if (presentation === 'page') return content;

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto bg-white dark:bg-gray-900">
        <DialogHeader>
          <DialogTitle>{translate(plugin.display_name_i18n, locale, plugin.default_locale || 'en') || plugin.display_name}</DialogTitle>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}
