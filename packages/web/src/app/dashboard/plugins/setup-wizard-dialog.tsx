'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Check, ChevronRight, ExternalLink, HelpCircle } from 'lucide-react';
import { usePluginStore } from '@/stores/plugin-store';
import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { useAuthStore } from '@/stores/auth-store';

interface SetupStep {
  id: string;
  title: string;
  description: string;
  scope: 'workspace' | 'plugin';
  fields: string[];
  optional?: boolean;
  helpUrl?: string;
  helpText?: string;
}

interface Props {
  plugin: any;
  scopeType?: string;
  scopeId?: string;
  lifecycleScope?: string;
  onClose: () => void;
  onComplete: () => void;
}

export default function SetupWizardDialog({ plugin, scopeType = 'workspace', scopeId, lifecycleScope, onClose, onComplete }: Props) {
  const { workspaceId } = useWorkspace();
  const { installPlugin } = usePluginStore();
  const user = useAuthStore((s) => s.user);

  const allSteps: SetupStep[] = plugin.setup_steps || [];

  const [currentStep, setCurrentStep] = useState(0);
  const [configValues, setConfigValues] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (allSteps.length === 0) {
    return null;
  }

  const step = allSteps[currentStep];
  const isLastStep = currentStep === allSteps.length - 1;
  const stepValues = configValues[step?.id] || {};

  const schema = plugin.config_schema || {};
  const schemaProperties = schema.properties || {};

  const handleFieldChange = (field: string, value: string) => {
    setConfigValues(prev => ({
      ...prev,
      [step.id]: { ...(prev[step.id] || {}), [field]: value },
    }));
    if (fieldErrors[field]) {
      setFieldErrors(prev => { const n = { ...prev }; delete n[field]; return n; });
    }
  };

  const validateStep = (): boolean => {
    const errors: Record<string, string> = {};
    const required = schema.required || [];
    for (const field of step.fields) {
      if (required.includes(field) && !stepValues[field]) {
        errors[field] = `${field} is required`;
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleNext = async () => {
    if (!step.optional && !validateStep()) return;

    setSaving(true);
    try {
      setCompletedSteps(prev => new Set(prev).add(currentStep));

      if (isLastStep) {
        // Collect all config from all steps
        const allConfig: Record<string, string> = {};
        for (const vals of Object.values(configValues)) {
          for (const [k, v] of Object.entries(vals)) {
            if (v) allConfig[k] = v;
          }
        }

        // Derive scopeId if not provided
        const finalScopeId = scopeId || (scopeType === 'workspace' ? workspaceId : scopeType === 'user' ? user?.id : undefined);

        await installPlugin(workspaceId!, {
          pluginId: plugin.id,
          scopeType,
          scopeId: finalScopeId,
          lifecycleScope,
          configData: Object.keys(allConfig).length > 0 ? allConfig : undefined,
        });
        onComplete();
      } else {
        setCurrentStep(prev => prev + 1);
        setFieldErrors({});
      }
    } catch (err: any) {
      alert('Failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = () => {
    if (isLastStep) {
      setSaving(true);
      const finalScopeId = scopeId || (scopeType === 'workspace' ? workspaceId : scopeType === 'user' ? user?.id : undefined);
      installPlugin(workspaceId!, { pluginId: plugin.id, scopeType, scopeId: finalScopeId, lifecycleScope })
        .then(() => onComplete())
        .finally(() => setSaving(false));
    } else {
      setCurrentStep(prev => prev + 1);
      setFieldErrors({});
    }
  };

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10 max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Setup {plugin.display_name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Step indicator */}
          <div className="flex items-center gap-2">
            {allSteps.map((s, i) => (
              <div key={s.id} className="flex items-center gap-1">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium border ${
                  completedSteps.has(i)
                    ? 'bg-green-500/20 border-green-500/30 text-green-400'
                    : i === currentStep
                    ? 'bg-blue-500/20 border-blue-500/30 text-blue-400'
                    : 'bg-muted/10 border-muted/20 text-muted-foreground'
                }`}>
                  {completedSteps.has(i) ? <Check className="w-3.5 h-3.5" /> : i + 1}
                </div>
                {i < allSteps.length - 1 && (
                  <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                )}
              </div>
            ))}
          </div>

          {/* Step content */}
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">{step.title}</h3>
              <p className="text-xs text-muted-foreground mt-1">{step.description}</p>
            </div>

            {step.optional && (
              <Badge variant="outline" className="text-xs border-gray-200 dark:border-white/10 text-muted-foreground">Optional</Badge>
            )}

            {step.fields.map(field => {
              const fieldSchema = schemaProperties[field] || {};
              const isSensitive = fieldSchema.sensitive === true;
              const isRequired = (schema.required || []).includes(field);
              const error = fieldErrors[field];

              return (
                <div key={field} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm">{fieldSchema.description || field}</Label>
                    {isRequired && <span className="text-xs text-red-400">*</span>}
                  </div>
                  <Input
                    type={isSensitive ? 'password' : 'text'}
                    placeholder={`Enter ${field}...`}
                    value={stepValues[field] || ''}
                    onChange={(e) => handleFieldChange(field, e.target.value)}
                    className={`bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 ${error ? 'border-red-500/50' : 'border-gray-200 dark:border-white/10'}`}
                  />
                  {error && <p className="text-xs text-red-400">{error}</p>}
                </div>
              );
            })}

            {(step.helpUrl || step.helpText) && (
              <div className="rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 p-3 space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-blue-400">
                  <HelpCircle className="w-3.5 h-3.5" />
                  Help
                </div>
                {step.helpText && (
                  <p className="text-xs text-muted-foreground">{step.helpText}</p>
                )}
                {step.helpUrl && (
                  <a
                    href={step.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                  >
                    Open documentation <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <Button onClick={handleNext} disabled={saving} className="flex-1">
              {saving ? 'Saving...' : isLastStep ? 'Complete Setup' : 'Next'}
            </Button>
            {step.optional && (
              <Button variant="outline" onClick={handleSkip} disabled={saving}>
                Skip
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
