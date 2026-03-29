'use client';

import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ExclamationCircleIcon } from '@heroicons/react/16/solid';
import type {
  AttachmentScope,
  PluginAuthBindingDefinition,
  PluginAuthSession,
  PluginConfigFieldDefinition,
  PluginInstallStep,
  ReuseScope,
  LocalizedText,
} from '@synapse/shared';
import { AppCard } from '@/components/app-card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { Check, ExternalLink, HelpCircle, Loader2 } from 'lucide-react';
import { usePluginStore } from '@/stores/plugin-store';
import { useAuthStore } from '@/stores/auth-store';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { api } from '@/lib/api';
import PluginAccessStep from './plugin-access-step';
import { PluginIcon } from './plugin-ui';
import {
  AccessAttachmentTypeStep,
  AccessReuseScopeStep,
  type AccessVisualConversation,
  getConversationDisplayName,
} from '@/app/dashboard/access/attachment-visuals';

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
  pageChrome?: 'card' | 'plain' | 'tab';
  includePlacementSteps?: boolean;
  includeAccessStep?: boolean;
  defaultAttachmentType?: PluginAttachmentType;
  defaultLifecycleScope?: PluginReuseScope;
  createDefaultWorkspaceAccess?: boolean;
  closeLabel?: string;
}

type PluginAttachmentType = Exclude<AttachmentScope, 'platform'>;
type PluginReuseScope = Exclude<ReuseScope, 'platform'>;
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
type InstallFlowStep = PluginInstallStep | AccessStep;

type AuthFieldState = {
  sessionId: string;
  bindingKey: string;
  status: PluginAuthSession['status'];
  phase?: PluginAuthSession['phase'];
  challenge?: PluginAuthSession['challenge'];
  accountDisplayName?: string;
  errorMessage?: string;
  authConnectionId?: string;
  resultPreview?: Record<string, unknown>;
};

type AuthChallengeMetadata = {
  title?: string;
  description?: string;
  actionLabel?: string;
  scanUrl?: string;
  userCode?: string;
};

type FeishuAppScopeStatusView = {
  status?: string;
  canQuery?: boolean;
  checkedAt?: string;
  message?: string;
  consoleUrl?: string;
  queryError?: string;
  enabledScopes: string[];
  missingScopes: string[];
  missingFeatures: Array<{
    key?: string;
    title?: string;
    missingScopes: string[];
    mayRequireAppReview?: boolean;
  }>;
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

function getStringArrayValue(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isMissingFieldValue(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function getAuthChallengeMetadata(authState?: AuthFieldState): AuthChallengeMetadata {
  const metadata = authState?.challenge?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  const record = metadata as Record<string, unknown>;
  return {
    title: typeof record.title === 'string' ? record.title : undefined,
    description: typeof record.description === 'string' ? record.description : undefined,
    actionLabel: typeof record.actionLabel === 'string' ? record.actionLabel : undefined,
    scanUrl: typeof record.scanUrl === 'string' ? record.scanUrl : undefined,
    userCode: typeof record.userCode === 'string' ? record.userCode : undefined,
  };
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getFeishuAppScopeStatus(authState?: AuthFieldState): FeishuAppScopeStatusView | undefined {
  const scopeStatus = asRecord(authState?.resultPreview).appScopeStatus;
  if (!scopeStatus || typeof scopeStatus !== 'object' || Array.isArray(scopeStatus)) {
    return undefined;
  }

  const record = scopeStatus as Record<string, unknown>;
  const missingFeatures = Array.isArray(record.missingFeatures)
    ? record.missingFeatures.map((item) => {
        const feature = asRecord(item);
        return {
          key: typeof feature.key === 'string' ? feature.key : undefined,
          title: typeof feature.title === 'string' ? feature.title : undefined,
          mayRequireAppReview: feature.mayRequireAppReview === true,
          missingScopes: Array.isArray(feature.missingScopes)
            ? feature.missingScopes.filter((scope): scope is string => typeof scope === 'string')
            : [],
        };
      })
    : [];

  return {
    status: typeof record.status === 'string' ? record.status : undefined,
    canQuery: typeof record.canQuery === 'boolean' ? record.canQuery : undefined,
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : undefined,
    message: typeof record.message === 'string' ? record.message : undefined,
    consoleUrl: typeof record.consoleUrl === 'string' ? record.consoleUrl : undefined,
    queryError: typeof record.queryError === 'string' ? record.queryError : undefined,
    enabledScopes: Array.isArray(record.enabledScopes)
      ? record.enabledScopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
    missingScopes: Array.isArray(record.missingScopes)
      ? record.missingScopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
    missingFeatures,
  };
}

function deriveConfigFields(plugin: any): PluginConfigFieldDefinition[] {
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

function deriveInstallFlow(
  plugin: any,
  configFields: PluginConfigFieldDefinition[],
  locale: string,
  options?: { includePlacementSteps?: boolean },
): PluginInstallStep[] {
  const baseSteps = Array.isArray(plugin.install_flow?.steps) && plugin.install_flow.steps.length > 0
    ? plugin.install_flow.steps.filter((step: PluginInstallStep) => step.kind !== 'confirm')
    : [{
        id: 'configure',
        kind: 'form' as const,
        titleI18n: { [locale]: 'Configure plugin' },
        descriptionI18n: { [locale]: 'Provide the required configuration for this plugin.' },
        scope: 'plugin',
        fields: configFields.map((field) => field.key),
      }];

  if (options?.includePlacementSteps === false) {
    return baseSteps;
  }

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

function buildInitialConfig(plugin: any, configFields: PluginConfigFieldDefinition[]) {
  const initial = { ...(plugin.default_config || {}) } as Record<string, unknown>;
  for (const field of configFields) {
    if (initial[field.key] !== undefined) continue;
    if (field.defaultValue !== undefined) {
      initial[field.key] = field.defaultValue;
      continue;
    }
    if (field.type === 'boolean') {
      initial[field.key] = false;
      continue;
    }
    if (field.type === 'multiselect') {
      initial[field.key] = [];
    }
  }
  return initial;
}

function buildInitialAuthFields(
  config: Record<string, unknown>,
  configFields: PluginConfigFieldDefinition[],
) {
  const authState: Record<string, AuthFieldState> = {};
  for (const field of configFields) {
    if (field.type !== 'auth_connection') continue;
    const value = config[field.key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const ref = value as Record<string, unknown>;
    if (typeof ref.connectionId !== 'string') continue;
    authState[field.key] = {
      sessionId: '',
      bindingKey:
        typeof ref.bindingKey === 'string'
          ? ref.bindingKey
          : field.authBindingKey || '',
      status: 'completed',
      accountDisplayName:
        typeof ref.accountDisplayName === 'string'
          ? ref.accountDisplayName
          : undefined,
      authConnectionId: ref.connectionId,
    };
  }
  return authState;
}

function hasStoredAuthConnection(value: unknown) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).connectionId === 'string',
  );
}

function getAuthPendingMessage(authState: AuthFieldState) {
  const metadata = getAuthChallengeMetadata(authState);
  if (metadata.description) {
    return metadata.description;
  }
  if (authState.phase === 'pending_confirm') {
    return 'Authorization scanned. Confirm it in the provider app.';
  }
  if (authState.challenge?.kind === 'qr_code') {
    return 'Scan the QR code to authorize this account.';
  }
  return 'Waiting for authorization...';
}

function AuthQrCodeImage({ value, label }: { value: string; label: string }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void QRCode.toDataURL(value, {
      width: 220,
      margin: 1,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    })
      .then((nextImageUrl: string) => {
        if (!cancelled) {
          setImageUrl(nextImageUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setImageUrl(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  if (!imageUrl) {
    return (
      <div className="flex h-40 w-40 items-center justify-center rounded-md border border-gray-200 bg-white p-2 text-xs text-muted-foreground dark:border-white/10">
        Generating QR code...
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={imageUrl}
      alt={`${label} QR code`}
      className="h-40 w-40 rounded-md border border-gray-200 bg-white object-contain p-2 dark:border-white/10"
      loading="lazy"
      decoding="async"
    />
  );
}

function runClientValidation(
  config: Record<string, unknown>,
  authFields: Record<string, AuthFieldState>,
  rules: ValidationRule[],
  configFields: PluginConfigFieldDefinition[],
  fieldKeys?: string[],
) {
  const errors: Record<string, string> = {};
  const allowed = fieldKeys ? new Set(fieldKeys) : null;

  for (const field of configFields) {
    if (allowed && !allowed.has(field.key)) continue;
    const value = config[field.key];
    if (field.required) {
      if (field.type === 'auth_connection') {
        const hasSavedConnection = hasStoredAuthConnection(value);
        const authStatus = authFields[field.key]?.status;
        if (!hasSavedConnection && authStatus !== 'completed' && authStatus !== 'consumed') {
          errors[field.key] = 'Authorization is required.';
        }
      } else if (field.type === 'boolean') {
        continue;
      } else if (isMissingFieldValue(value)) {
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
        if (isMissingFieldValue(value)) errors[rule.field] = rule.message;
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
  includePlacementSteps = true,
  includeAccessStep,
  defaultAttachmentType,
  defaultLifecycleScope,
  createDefaultWorkspaceAccess = false,
  closeLabel = 'Cancel',
}: Props) {
  const { workspaceId } = useWorkspace();
  const { installPlugin, updateInstallation } = usePluginStore();
  const { user } = useAuthStore();
  const currentUserId = user?.id || '';

  const locale = useMemo(() => getLocale(plugin.default_locale), [plugin.default_locale]);
  const configFields = useMemo(() => deriveConfigFields(plugin), [plugin]);
  const setupSteps = useMemo(
    () => deriveInstallFlow(plugin, configFields, locale, { includePlacementSteps }),
    [configFields, includePlacementSteps, locale, plugin],
  );
  const authBindings = useMemo<PluginAuthBindingDefinition[]>(() => plugin.auth_bindings || [], [plugin.auth_bindings]);
  const authBindingMap = useMemo(() => new Map(authBindings.map((binding) => [binding.key, binding])), [authBindings]);
  const allowedAttachmentTypes = useMemo<PluginAttachmentType[]>(
    () => ['workspace', 'conversation', 'actor_global', 'actor_conversation', 'user'],
    [],
  );
  const initialAttachmentType = initialInstallation?.attachment_type as PluginAttachmentType | undefined;
  const initialAttachmentActorId = initialInstallation?.attachment_actor_id || '';
  const initialAttachmentConversationId = initialInstallation?.attachment_conversation_id || '';

  const [selectedAttachmentType, setSelectedAttachmentType] = useState<PluginAttachmentType>(
    initialAttachmentType ||
    (defaultAttachmentType || (defaultActorId ? 'actor_global' : (plugin.default_instance_scope || 'workspace')) as PluginAttachmentType),
  );
  const [lifecycleScope, setLifecycleScope] = useState<PluginReuseScope>(
    ((initialInstallation?.lifecycle_scope as PluginReuseScope | undefined) ||
      defaultLifecycleScope ||
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
  const [authInspecting, setAuthInspecting] = useState<Record<string, boolean>>({});
  const [authFields, setAuthFields] = useState<Record<string, AuthFieldState>>(() =>
    buildInitialAuthFields(
      {
        ...buildInitialConfig(plugin, configFields),
        ...(initialInstallation?.config_data || {}),
      },
      configFields,
    ),
  );
  const [currentInstallation, setCurrentInstallation] = useState<any>(initialInstallation || null);
  const authPollers = useRef<Record<string, number>>({});

  const validationRules: ValidationRule[] = plugin.validation_rules || [];
  const resolvedIncludeAccessStep = includeAccessStep ?? presentation === 'page';
  const installSteps = useMemo<InstallFlowStep[]>(() => {
    if (!resolvedIncludeAccessStep) {
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
  }, [locale, resolvedIncludeAccessStep, setupSteps]);
  const currentStep = installSteps[currentStepIndex];
  const accessStepIndex = useMemo(
    () => installSteps.findIndex((step) => step.kind === 'access'),
    [installSteps],
  );
  const currentAuthStepField = useMemo(() => {
    if (currentStep?.kind !== 'auth') {
      return null;
    }
    const authStepFields = currentStep.fields
      .map((fieldKey) => configFields.find((field) => field.key === fieldKey))
      .filter((field): field is PluginConfigFieldDefinition => Boolean(field))
      .filter((field) => field.type === 'auth_connection');
    return authStepFields.length === 1 ? authStepFields[0] : null;
  }, [configFields, currentStep]);
  const lastSetupStepIndex = setupSteps.length - 1;
  const installLifecycleOptions = useMemo(
    () => getInstallAllowedReuseScopes(selectedAttachmentType),
    [selectedAttachmentType],
  );
  const currentAuthStepState = currentAuthStepField ? authFields[currentAuthStepField.key] : undefined;
  const currentAuthStepValue = currentAuthStepField ? configData[currentAuthStepField.key] : undefined;
  const autoStartedAuthStepRef = useRef('');

  useEffect(() => {
    if ((selectedAttachmentType === 'actor_global' || selectedAttachmentType === 'actor_conversation') && workspaceId) {
      api.getActors(workspaceId).then((result) => {
        const actorList = result?.actors ?? result ?? [];
        setActors(Array.isArray(actorList) ? actorList.map(normalizeActorOption) : []);
      }).catch(() => {});
    }
    if ((selectedAttachmentType === 'conversation' || selectedAttachmentType === 'actor_conversation') && workspaceId) {
      api.getConversations(workspaceId).then((res) => setConversations(
        (res.conversations || []).map((conversation: AccessVisualConversation) => ({
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
    setAuthFields((previous) => ({
      ...buildInitialAuthFields(configData, configFields),
      ...previous,
    }));
  }, [configData, configFields]);

  useEffect(() => {
    if (!currentAuthStepField || currentStep?.kind !== 'auth') {
      autoStartedAuthStepRef.current = '';
      return;
    }

    if (hasStoredAuthConnection(currentAuthStepValue)) {
      return;
    }

    if (
      currentAuthStepState?.status === 'pending' ||
      currentAuthStepState?.status === 'completed' ||
      currentAuthStepState?.status === 'consumed'
    ) {
      return;
    }

    const autoStartKey = [
      currentStep.id,
      currentAuthStepField.key,
      currentInstallation?.id || initialInstallation?.id || 'new',
      typeof configData.locale === 'string' ? configData.locale : '',
    ].join(':');

    if (autoStartedAuthStepRef.current === autoStartKey) {
      return;
    }

    autoStartedAuthStepRef.current = autoStartKey;
    void beginAuth(currentAuthStepField);
  }, [
    configData.locale,
    currentAuthStepField,
    currentAuthStepState?.status,
    currentAuthStepValue,
    currentInstallation?.id,
    currentStep,
    initialInstallation?.id,
  ]);

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
      const session: PluginAuthSession = data.session;
      setAuthFields((previous) => ({
        ...previous,
        [fieldKey]: {
          sessionId,
          bindingKey: previous[fieldKey]?.bindingKey || '',
          status: session.status,
          phase: session.phase,
          challenge: session.challenge,
          accountDisplayName: typeof session.resultPreview?.displayName === 'string' ? session.resultPreview.displayName : undefined,
          errorMessage: session.errorMessage,
          authConnectionId: session.authConnectionId,
          resultPreview: session.resultPreview,
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
          bindingKey: previous[fieldKey]?.bindingKey || '',
          status: 'failed',
          phase: undefined,
          challenge: previous[fieldKey]?.challenge,
          errorMessage: error.message,
          resultPreview: previous[fieldKey]?.resultPreview,
        },
      }));
      if (authPollers.current[fieldKey]) {
        window.clearInterval(authPollers.current[fieldKey]);
        delete authPollers.current[fieldKey];
      }
    }
  };

  const beginAuth = async (field: PluginConfigFieldDefinition, bindingKey?: string) => {
    if (!workspaceId) return;
    const resolvedBindingKey = bindingKey || field.authBindingKey;
    if (!resolvedBindingKey) {
      setFieldErrors((previous) => ({ ...previous, [field.key]: 'No auth binding is configured for this field.' }));
      return;
    }

    setFieldErrors((previous) => {
      const next = { ...previous };
      delete next[field.key];
      return next;
    });

    try {
      const result = await api.startPluginAuth(workspaceId, plugin.id, resolvedBindingKey, {
        installationId: currentInstallation?.id || initialInstallation?.id,
        draftConfig: configData,
      });
      const session: PluginAuthSession = result.session;
      setAuthFields((previous) => ({
        ...previous,
        [field.key]: {
          sessionId: session.id,
          bindingKey: resolvedBindingKey,
          status: session.status,
          phase: session.phase,
          challenge: session.challenge,
          resultPreview: session.resultPreview,
        },
      }));

      if (authPollers.current[field.key]) {
        window.clearInterval(authPollers.current[field.key]);
      }
      authPollers.current[field.key] = window.setInterval(() => {
        void refreshAuthField(field.key, session.id);
      }, 2000);

      if (session.challenge?.kind === 'redirect' && session.challenge.url) {
        if (session.challenge.openMode === 'replace') {
          window.location.assign(session.challenge.url);
          return;
        }

        const popup = window.open(session.challenge.url, `mcp-auth-${field.key}`, 'width=720,height=820,noopener,noreferrer');
        if (!popup) {
          setFieldErrors((previous) => ({ ...previous, [field.key]: 'Popup blocked. Please allow popups and try again.' }));
        }
      } else if (session.challenge?.kind && session.challenge.kind !== 'qr_code' && session.challenge.kind !== 'none') {
        setFieldErrors((previous) => ({ ...previous, [field.key]: 'This auth flow returned an unsupported challenge type.' }));
      }
    } catch (error: any) {
      setFieldErrors((previous) => ({
        ...previous,
        [field.key]: error?.message || 'Unable to start the auth flow.',
      }));
    }
  };

  const inspectAuthSession = async (fieldKey: string) => {
    const authState = authFields[fieldKey];
    if (!workspaceId || !authState?.sessionId) {
      return;
    }

    setAuthInspecting((previous) => ({ ...previous, [fieldKey]: true }));
    try {
      const data = await api.inspectPluginAuthSession(workspaceId, authState.sessionId);
      const session: PluginAuthSession = data.session;
      setAuthFields((previous) => ({
        ...previous,
        [fieldKey]: {
          ...(previous[fieldKey] || authState),
          sessionId: session.id,
          bindingKey: previous[fieldKey]?.bindingKey || authState.bindingKey,
          status: session.status,
          phase: session.phase,
          challenge: session.challenge,
          accountDisplayName: typeof session.resultPreview?.displayName === 'string' ? session.resultPreview.displayName : previous[fieldKey]?.accountDisplayName,
          errorMessage: session.errorMessage,
          authConnectionId: session.authConnectionId,
          resultPreview: session.resultPreview,
        },
      }));
    } catch (error: any) {
      setFieldErrors((previous) => ({
        ...previous,
        [fieldKey]: error?.message || 'Unable to refresh app scopes.',
      }));
    } finally {
      setAuthInspecting((previous) => ({ ...previous, [fieldKey]: false }));
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
          .filter(([, state]) => state.status === 'completed' && state.sessionId)
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
        if (createDefaultWorkspaceAccess) {
          await api.grantPluginInstallationAccess(workspaceId, installation.id, {
            grantScope: 'workspace',
            permissions: installation.authorization?.requiredPermissions || installation.revision?.authorization?.requiredPermissions || ['use'],
          });
        }
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

  const renderStepNavigator = () => (
    <div className="space-y-3">
      <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        Step {currentStepIndex + 1} of {installSteps.length}
      </div>

      <div className="flex flex-wrap gap-2">
        {installSteps.map((step, index) => {
          const label = translate(step.titleI18n, locale, plugin.default_locale || 'en') || step.id;
          const isCurrent = index === currentStepIndex;
          const isComplete = index < currentStepIndex;
          const isLocked = step.kind === 'access' && !currentInstallation;

          return (
            <button
              key={step.id}
              type="button"
              onClick={() => {
                if (isLocked) return;
                setCurrentStepIndex(index);
              }}
              disabled={isLocked}
              className={
                isCurrent
                  ? 'inline-flex items-center gap-2 rounded-2xl border border-foreground/15 bg-accent px-3 py-2 text-sm font-medium text-foreground shadow-sm'
                  : isComplete
                    ? 'inline-flex items-center gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300'
                    : isLocked
                      ? 'inline-flex items-center gap-2 rounded-2xl border border-border/70 bg-muted/20 px-3 py-2 text-sm font-medium text-muted-foreground opacity-55'
                      : 'inline-flex items-center gap-2 rounded-2xl border border-border/70 bg-background px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground'
              }
            >
              <span
                className={
                  isCurrent
                    ? 'flex size-6 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold text-background'
                    : isComplete
                      ? 'flex size-6 items-center justify-center rounded-full bg-emerald-500 text-white'
                      : 'flex size-6 items-center justify-center rounded-full border border-border bg-background text-[11px] font-semibold text-muted-foreground'
                }
              >
                {isComplete ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const renderStepAction = () => {
    if (!currentStep?.action) return null;
    if (currentStep.action.kind === 'auth_start') {
      const bindingKey = currentStep.action.bindingKey;
      const field = configFields.find((item) => item.authBindingKey === bindingKey || item.key === bindingKey);
      if (!field) return null;
      return (
        <div className="rounded-lg border border-gray-200 dark:border-white/10 p-3">
          <Button type="button" variant="outline" onClick={() => beginAuth(field, bindingKey)} className="w-full">
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

  const renderField = (field: PluginConfigFieldDefinition) => {
    const value = configData[field.key];
    const error = fieldErrors[field.key];
    const binding = field.authBindingKey ? authBindingMap.get(field.authBindingKey) : undefined;
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

    if (field.type === 'multiselect') {
      const selectedValues = new Set(getStringArrayValue(value));
      return (
        <div key={field.key} className="space-y-3">
          <div className="flex items-center gap-2">
            <Label className="block text-sm/6 font-medium text-gray-900 dark:text-white">{label}</Label>
            {field.required && <span className="text-xs text-red-500">*</span>}
          </div>
          {description && <p className="text-sm text-gray-500 dark:text-gray-400">{description}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {(field.options || []).map((option) => {
              const optionLabel =
                translate(option.labelI18n, locale, plugin.default_locale || 'en') || option.value;
              const optionDescription = translate(
                option.descriptionI18n,
                locale,
                plugin.default_locale || 'en',
              );
              const checked = selectedValues.has(option.value);
              return (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors ${
                    checked
                      ? 'border-foreground/20 bg-accent/60'
                      : 'border-border/70 bg-background hover:bg-muted/40'
                  }`}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(nextChecked) => {
                      const current = getStringArrayValue(configData[field.key]);
                      const next = nextChecked === true
                        ? Array.from(new Set([...current, option.value]))
                        : current.filter((item) => item !== option.value);
                      handleFieldChange(field.key, next);
                    }}
                    className="mt-0.5"
                  />
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-foreground">{optionLabel}</div>
                    {optionDescription && (
                      <p className="text-sm text-muted-foreground">{optionDescription}</p>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
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

    if (field.type === 'auth_connection') {
      const bindingLabel = binding
        ? translate(binding.displayNameI18n, locale, plugin.default_locale || 'en') || binding.key
        : field.authBindingKey || 'binding';
      const challengeMetadata = getAuthChallengeMetadata(authState);
      const feishuScopeStatus = getFeishuAppScopeStatus(authState);
      const canInspectFeishuScopes =
        binding?.driver === 'feishu_cli_setup' &&
        typeof authState?.sessionId === 'string' &&
        authState.sessionId.length > 0;
      const scanUrl =
        authState?.challenge?.kind === 'qr_code'
          ? authState.challenge.qrUrl || challengeMetadata.scanUrl || authState.challenge.url
          : undefined;
      const challengeExpiresAt = authState?.challenge?.expiresAt;
      const challengeTitle = challengeMetadata.title || label;
      const challengeActionLabel = challengeMetadata.actionLabel || 'Open authorization page';
      return (
        <div key={field.key} className="space-y-2 rounded-lg border border-gray-200 dark:border-white/10 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Label className="block text-sm/6 font-medium text-gray-900 dark:text-white">{label}</Label>
                {field.required && <span className="text-xs text-red-500">*</span>}
                <Badge variant="outline">{bindingLabel}</Badge>
              </div>
              {description && <p className="text-sm text-gray-500 dark:text-gray-400">{description}</p>}
            </div>
            <div className="flex items-center gap-2">
              {canInspectFeishuScopes && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void inspectAuthSession(field.key)}
                  className="shrink-0"
                  disabled={authInspecting[field.key] === true}
                >
                  {authInspecting[field.key] === true ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Refreshing
                    </>
                  ) : 'Refresh app scopes'}
                </Button>
              )}
              <Button type="button" variant="outline" onClick={() => beginAuth(field)} className="shrink-0">
                {authState?.status === 'completed' || authState?.status === 'consumed' ? 'Reconnect' : 'Connect'}
              </Button>
            </div>
          </div>
          {authState && (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {authState.status === 'pending' && (
                <div className="space-y-3">
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {getAuthPendingMessage(authState)}
                  </span>
                  {scanUrl && (
                    <div className="flex flex-col gap-3 rounded-lg border border-dashed border-gray-300 bg-muted/20 p-3 dark:border-white/10">
                      <div className="flex items-start gap-3">
                        <AuthQrCodeImage value={scanUrl} label={label} />
                        <div className="space-y-2">
                          <p className="font-medium text-foreground">{challengeTitle}</p>
                          <p>{getAuthPendingMessage(authState)}</p>
                          {challengeMetadata.userCode && (
                            <p className="text-xs text-muted-foreground">
                              User code: <span className="font-mono text-foreground">{challengeMetadata.userCode}</span>
                            </p>
                          )}
                          <a
                            href={scanUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-blue-500 hover:text-blue-400"
                          >
                            {challengeActionLabel}
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                          {challengeExpiresAt && (
                            <p className="text-xs text-muted-foreground">
                              Expires at {new Date(challengeExpiresAt).toLocaleString()}.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {(authState.status === 'completed' || authState.status === 'consumed') && (
                <span>Connected{authState.accountDisplayName ? ` as ${authState.accountDisplayName}` : ''}.</span>
              )}
              {authState.status === 'failed' && <span className="text-red-500">{authState.errorMessage || 'Authorization failed.'}</span>}
              {authState.status === 'expired' && <span className="text-red-500">Authorization session expired. Start again.</span>}
              {feishuScopeStatus && (
                <div className={`mt-3 space-y-3 rounded-lg border p-3 ${
                  feishuScopeStatus.status === 'ready'
                    ? 'border-emerald-200 bg-emerald-50/80 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100'
                    : feishuScopeStatus.status === 'missing_app_scopes'
                      ? 'border-amber-200 bg-amber-50/80 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100'
                      : 'border-slate-200 bg-slate-50/80 text-slate-900 dark:border-white/10 dark:bg-white/5 dark:text-slate-100'
                }`}>
                  <div className="space-y-1">
                    <p className="font-medium text-current">
                      {feishuScopeStatus.status === 'ready'
                        ? 'App scopes are ready'
                        : feishuScopeStatus.status === 'missing_app_scopes'
                          ? 'More app scopes still need review'
                          : 'App scope status is unavailable'}
                    </p>
                    {feishuScopeStatus.message && <p className="text-current/80">{feishuScopeStatus.message}</p>}
                    {feishuScopeStatus.checkedAt && (
                      <p className="text-xs text-current/70">
                        Checked at {new Date(feishuScopeStatus.checkedAt).toLocaleString()}.
                      </p>
                    )}
                  </div>
                  {feishuScopeStatus.missingFeatures.length > 0 && (
                    <div className="space-y-2">
                      <p className="font-medium text-current">Missing feature scopes</p>
                      <div className="space-y-2">
                        {feishuScopeStatus.missingFeatures.map((feature) => (
                          <div key={`${feature.key || feature.title}-${feature.missingScopes.join(',')}`} className="rounded-md bg-black/5 px-3 py-2 dark:bg-white/5">
                            <p className="font-medium text-current">
                              {feature.title || feature.key || 'Feature'}
                              {feature.mayRequireAppReview ? ' · may require review' : ''}
                            </p>
                            <p className="text-xs text-current/80">{feature.missingScopes.join(', ')}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {feishuScopeStatus.queryError && feishuScopeStatus.status === 'unavailable' && (
                    <p className="text-xs text-current/80">{feishuScopeStatus.queryError}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {feishuScopeStatus.consoleUrl && (
                      <a
                        href={feishuScopeStatus.consoleUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-500 dark:text-blue-300 dark:hover:text-blue-200"
                      >
                        Open Feishu scope console
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                    {feishuScopeStatus.enabledScopes.length > 0 && (
                      <span className="text-xs text-current/70">
                        Enabled user scopes: {feishuScopeStatus.enabledScopes.length}
                      </span>
                    )}
                  </div>
                </div>
              )}
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
              error={fieldErrors.__scope}
            />
          </div>
        )}

        {currentStep?.kind === 'reuse_scope' && (
          <AccessReuseScopeStep
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

        {(currentStep?.kind === 'form' || currentStep?.kind === 'auth' || currentStep?.kind === 'check') && currentStep?.fields.length > 0 && (
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
        {currentStep?.kind === 'access' ? 'Close' : closeLabel}
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

      <div className="flex min-h-0 flex-1 flex-col">
        {pageChrome === 'tab' ? (
          <>
            <div className="px-0 pb-4">
              {renderStepNavigator()}
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-0 py-0">
                {renderStepBody()}
              </div>
            </ScrollArea>
            <div className="pt-5">
              {renderStepFooter()}
            </div>
          </>
        ) : (
          <>
            <div className="sticky top-0 z-10 border-b border-gray-200 bg-card px-6 py-4 dark:border-white/10">
              {renderStepNavigator()}
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-6 py-6">
                {renderStepBody()}
              </div>
            </ScrollArea>
            <div className="border-t border-gray-200 px-6 py-4 dark:border-white/10">
              {renderStepFooter()}
            </div>
          </>
        )}
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
