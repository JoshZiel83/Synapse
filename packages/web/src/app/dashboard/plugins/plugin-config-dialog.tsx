'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePluginStore } from '@/stores/plugin-store';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { useAuthStore } from '@/stores/auth-store';
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
      case 'max_length':
        if (typeof value === 'string' && value.length > (rule.value as number))
          errors.push({ field: rule.field, message: rule.message });
        break;
      case 'pattern':
        if (typeof value === 'string' && rule.value && !new RegExp(rule.value as string).test(value))
          errors.push({ field: rule.field, message: rule.message });
        break;
    }
  }
  return errors;
}

const scopeLabels: Record<string, string> = {
  workspace: 'Workspace',
  user: 'User',
  actor: 'Actor',
  group: 'Group',
};

const scopeColors: Record<string, string> = {
  workspace: 'border-blue-500/30 text-blue-400',
  user: 'border-purple-500/30 text-purple-400',
  actor: 'border-green-500/30 text-green-400',
  group: 'border-orange-500/30 text-orange-400',
};

interface Props {
  installation: any;
  onClose: () => void;
}

export default function PluginConfigDialog({ installation, onClose }: Props) {
  const { workspaceId } = useWorkspace();
  const { updateInstallation } = usePluginStore();
  const user = useAuthStore((s) => s.user);
  const [mode, setMode] = useState<'guided' | 'json'>('guided');
  const [configData, setConfigData] = useState<Record<string, any>>(installation.config_data || {});
  const [jsonText, setJsonText] = useState(JSON.stringify(installation.config_data || {}, null, 2));
  const [scopeType, setScopeType] = useState(installation.scope_type);
  const [scopeId, setScopeId] = useState(installation.scope_id);
  const [lifecycleScope, setLifecycleScope] = useState(installation.lifecycle_scope);
  const [isEnabled, setIsEnabled] = useState<boolean>(installation.is_enabled !== false);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [actors, setActors] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);

  const configSchema = installation.config_schema || {};
  const properties = configSchema.properties || {};
  const hasConfig = Object.keys(properties).length > 0;
  const validationRules: ValidationRule[] = installation.plugin_validation_rules || [];

  // Valid lifecycle options based on scope_type
  const lifecycleOptionsMap: Record<string, string[]> = {
    workspace: ['workspace', 'group', 'actor', 'session'],
    user: ['user', 'actor', 'session'],
    actor: ['actor', 'session'],
    group: ['group', 'actor', 'session'],
  };
  const lifecycleOptions = lifecycleOptionsMap[scopeType] || ['session'];

  // Load actors/groups when needed
  useEffect(() => {
    if (workspaceId && (scopeType === 'actor' || scopeType === 'group')) {
      if (scopeType === 'actor') api.getActors(workspaceId).then(setActors).catch(() => {});
      if (scopeType === 'group') api.getGroups(workspaceId).then((r: any) => setGroups(r.groups || [])).catch(() => {});
    }
  }, [scopeType, workspaceId]);

  // Reset lifecycle when scope changes if current lifecycle is invalid
  useEffect(() => {
    if (!lifecycleOptionsMap[scopeType]?.includes(lifecycleScope)) {
      setLifecycleScope(lifecycleOptionsMap[scopeType]?.[0] || 'session');
    }
  }, [scopeType]);

  const handleGuidedChange = (key: string, value: any) => {
    setConfigData(prev => ({ ...prev, [key]: value }));
    if (fieldErrors[key]) setFieldErrors(prev => { const n = { ...prev }; delete n[key]; return n; });
  };

  const handleSave = async () => {
    if (!workspaceId) return;
    setSaving(true);
    setFieldErrors({});
    try {
      const data = mode === 'json' ? JSON.parse(jsonText) : configData;

      // Client-side validation
      if (validationRules.length > 0) {
        const errors = runClientValidation(data, validationRules);
        if (errors.length > 0) {
          const errMap: Record<string, string> = {};
          for (const e of errors) errMap[e.field] = e.message;
          setFieldErrors(errMap);
          setSaving(false);
          return;
        }
      }

      const updateData: any = {};
      if (hasConfig) updateData.configData = data;
      if (lifecycleScope !== installation.lifecycle_scope) updateData.lifecycleScope = lifecycleScope;
      if (isEnabled !== (installation.is_enabled !== false)) updateData.isEnabled = isEnabled;
      if (scopeType !== installation.scope_type || scopeId !== installation.scope_id) {
        updateData.scopeType = scopeType;
        updateData.scopeId = scopeId;
      }

      if (Object.keys(updateData).length > 0) {
        await updateInstallation(workspaceId, installation.id, updateData);
      }
      onClose();
    } catch (err: any) {
      alert('Failed to save config: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const renderField = (key: string, schema: any) => {
    const value = configData[key] || '';
    const isSensitive = schema.sensitive === true;
    const error = fieldErrors[key];

    if (schema.type === 'boolean') {
      return (
        <div key={key} className="flex items-center justify-between py-2">
          <div>
            <Label className="text-sm">{schema.description || key}</Label>
          </div>
          <Switch checked={!!value} onCheckedChange={(v) => handleGuidedChange(key, v)} />
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
          value={value}
          onChange={(e) => handleGuidedChange(key, e.target.value)}
          placeholder={isSensitive ? '••••••••' : `Enter ${key}`}
          className={`bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 ${error ? 'border-red-500/50' : 'border-gray-200 dark:border-white/10'}`}
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    );
  };

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10 max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configure {installation.plugin_display_name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Scope & lifecycle */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Scope:</Label>
              <select
                className="h-7 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-2 text-xs bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10"
                value={scopeType}
                onChange={(e) => {
                  const newScope = e.target.value;
                  setScopeType(newScope);
                  if (newScope === 'workspace') setScopeId(workspaceId);
                  else if (newScope === 'user') setScopeId(user?.id || '');
                  else if (newScope === 'actor') setScopeId(actors[0]?.id || '');
                  else if (newScope === 'group') setScopeId(groups[0]?.id || '');
                }}
              >
                {Object.entries(scopeLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              {scopeType === 'actor' && (
                <select
                  className="h-7 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-2 text-xs bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 max-w-[150px]"
                  value={scopeId}
                  onChange={(e) => setScopeId(e.target.value)}
                >
                  {actors.map((a: any) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              )}
              {scopeType === 'group' && (
                <select
                  className="h-7 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-2 text-xs bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 max-w-[150px]"
                  value={scopeId}
                  onChange={(e) => setScopeId(e.target.value)}
                >
                  {groups.map((g: any) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Lifecycle:</Label>
              <select
                className="h-7 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-2 text-xs bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10"
                value={lifecycleScope}
                onChange={(e) => setLifecycleScope(e.target.value)}
              >
                {lifecycleOptions.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Enable / Disable */}
          <div className="flex items-center justify-between py-2 border-t border-gray-200 dark:border-white/10">
            <div>
              <Label className="text-sm font-medium">启用插件</Label>
              <p className="text-xs text-muted-foreground">{isEnabled ? '插件当前已启用' : '插件当前已禁用'}</p>
            </div>
            <Switch checked={isEnabled} onCheckedChange={setIsEnabled} />
          </div>

          {/* Config editing */}
          {hasConfig ? (
            <Tabs value={mode} onValueChange={(v) => setMode(v as any)}>
              <TabsList className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border border-gray-200 dark:border-white/10 w-full">
                <TabsTrigger value="guided" className="flex-1 data-[state=active]:bg-indigo-50 data-[state=active]:text-indigo-600 dark:data-[state=active]:bg-indigo-500/20 dark:data-[state=active]:text-indigo-400">Guided</TabsTrigger>
                <TabsTrigger value="json" className="flex-1 data-[state=active]:bg-indigo-50 data-[state=active]:text-indigo-600 dark:data-[state=active]:bg-indigo-500/20 dark:data-[state=active]:text-indigo-400">JSON</TabsTrigger>
              </TabsList>

              <TabsContent value="guided" className="mt-3 space-y-3">
                {Object.entries(properties).map(([key, schema]: [string, any]) => renderField(key, schema))}
              </TabsContent>

              <TabsContent value="json" className="mt-3">
                <Textarea
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  rows={6}
                  className="font-mono text-xs bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10"
                />
              </TabsContent>
            </Tabs>
          ) : (
            <p className="text-sm text-muted-foreground">This plugin has no configurable options.</p>
          )}

          <div className="flex gap-2 pt-2">
            <Button onClick={handleSave} disabled={saving} className="flex-1">
              {saving ? 'Saving...' : 'Save'}
            </Button>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
