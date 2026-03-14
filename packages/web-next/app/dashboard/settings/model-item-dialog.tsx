'use client';

import { useState, useEffect } from 'react';
import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Globe, FileText, Image, Mic, Video, FileIcon } from 'lucide-react';

interface ModelItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
  scope?: 'workspace' | 'platform' | 'user';
  item: any | null;
  onSaved: () => void;
}

const ANTHROPIC_BUILTIN_TOOLS = [
  {
    key: 'web_search',
    label: 'Web Search',
    description: 'Allow the model to search the web for real-time information',
    icon: Globe,
  },
  {
    key: 'web_fetch',
    label: 'Web Fetch',
    description: 'Allow the model to fetch and read full web page content',
    icon: FileText,
  },
];

const MULTIMODAL_TYPES = [
  { key: 'image', label: 'Images', description: 'Send images (JPEG, PNG, GIF, WebP) to the model', icon: Image },
  { key: 'audio', label: 'Audio', description: 'Send audio files (MP3, WAV, etc.) to the model', icon: Mic },
  { key: 'video', label: 'Video', description: 'Send video files to the model', icon: Video },
  { key: 'document', label: 'Documents', description: 'Send PDF and document files to the model', icon: FileIcon },
];

export default function ModelItemDialog({
  open,
  onOpenChange,
  groupId,
  scope = 'workspace',
  item,
  onSaved,
}: ModelItemDialogProps) {
  const { workspaceId } = useWorkspace();
  const [displayName, setDisplayName] = useState('');
  const [providerType, setProviderType] = useState('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelName, setModelName] = useState('');
  const [maxTokens, setMaxTokens] = useState('4096');
  const [priority, setPriority] = useState('0');
  const [weight, setWeight] = useState('100');
  const [builtinTools, setBuiltinTools] = useState<string[]>([]);
  const [multimodalTypes, setMultimodalTypes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item) {
      setDisplayName(item.display_name || '');
      setProviderType(item.provider_type || 'anthropic');
      setApiKey(''); // Never pre-fill API key for security
      setBaseUrl(item.base_url || '');
      setModelName(item.model_name || '');
      setMaxTokens(String(item.max_tokens || 4096));
      setPriority(String(item.priority ?? 0));
      setWeight(String(item.weight ?? 100));
      // Load builtin_tools and multimodal from extra_config
      const ec = item.extra_config || {};
      setBuiltinTools(Array.isArray(ec.builtin_tools) ? ec.builtin_tools : []);
      setMultimodalTypes(ec.multimodal?.supported && Array.isArray(ec.multimodal.types) ? ec.multimodal.types : []);
    } else {
      setDisplayName('');
      setProviderType('anthropic');
      setApiKey('');
      setBaseUrl('https://api.anthropic.com');
      setModelName('claude-sonnet-4-20250514');
      setMaxTokens('4096');
      setPriority('0');
      setWeight('100');
      setBuiltinTools([]);
      setMultimodalTypes([]);
    }
  }, [item, open]);

  const toggleBuiltinTool = (tool: string) => {
    setBuiltinTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]
    );
  };

  const toggleMultimodalType = (type: string) => {
    setMultimodalTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  };

  const handleSave = async () => {
    if ((!workspaceId && scope === 'workspace') || !displayName.trim()) return;
    setSaving(true);
    try {
      // Build extraConfig with builtin_tools and multimodal
      const extraConfig: Record<string, unknown> = {};
      if (providerType === 'anthropic' && builtinTools.length > 0) {
        extraConfig.builtin_tools = builtinTools;
      }
      if (multimodalTypes.length > 0) {
        extraConfig.multimodal = { supported: true, types: multimodalTypes };
      }

      if (item) {
        // Update - only send config fields if they changed
        const updateData: any = {
          displayName: displayName.trim(),
          priority: parseInt(priority),
          weight: parseInt(weight),
          extraConfig,
        };
        // Only add config fields if user provided new values
        if (modelName.trim()) updateData.modelName = modelName.trim();
        if (baseUrl.trim()) updateData.baseUrl = baseUrl.trim();
        if (apiKey.trim()) updateData.apiKey = apiKey.trim();
        if (providerType) updateData.providerType = providerType;
        updateData.maxTokens = parseInt(maxTokens);

        if (scope === 'platform') {
          await api.updatePlatformModelItem(groupId, item.id, updateData);
        } else if (scope === 'user') {
          await api.updateUserModelItem(groupId, item.id, updateData);
        } else {
          await api.updateModelItem(workspaceId!, groupId, item.id, updateData);
        }
      } else {
        // Create new
        const payload = {
          displayName: displayName.trim(),
          priority: parseInt(priority),
          weight: parseInt(weight),
          providerType,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim(),
          modelName: modelName.trim(),
          maxTokens: parseInt(maxTokens),
          extraConfig,
        };
        if (scope === 'platform') {
          await api.addPlatformModelItem(groupId, payload);
        } else if (scope === 'user') {
          await api.addUserModelItem(groupId, payload);
        } else {
          await api.addModelItem(workspaceId!, groupId, payload);
        }
      }
      onSaved();
    } catch (err) {
      console.error('Failed to save model item:', err);
    } finally {
      setSaving(false);
    }
  };

  const isValid = displayName.trim() && (item || (apiKey.trim() && baseUrl.trim() && modelName.trim()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{item ? 'Edit Model' : 'Add Model'}</DialogTitle>
          <DialogDescription>
            {item
              ? 'Update model configuration (creates new config version)'
              : 'Add a new model to this group'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 max-h-[60vh] overflow-y-auto">
          <div className="space-y-2">
            <Label>Display Name</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Claude Sonnet"
              className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/10 focus:border-blue-500/40" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Provider</Label>
              <select
                value={providerType}
                onChange={(e) => {
                  setProviderType(e.target.value);
                  if (e.target.value !== 'anthropic') setBuiltinTools([]);
                }}
                className="w-full h-10 px-3 rounded-md bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-foreground focus:border-blue-500/40 outline-none"
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>Model Name</Label>
              <Input value={modelName} onChange={(e) => setModelName(e.target.value)}
                placeholder="claude-sonnet-4-20250514"
                className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/10 focus:border-blue-500/40" />
            </div>
          </div>

          <div className="space-y-2">
            <Label>API Key</Label>
            <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              type="password" placeholder={item ? '(leave blank to keep current)' : 'sk-...'}
              className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/10 focus:border-blue-500/40" />
          </div>

          <div className="space-y-2">
            <Label>Base URL</Label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.anthropic.com"
              className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/10 focus:border-blue-500/40" />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Max Tokens</Label>
              <Input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)}
                type="number" className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/10 focus:border-blue-500/40" />
            </div>
            <div className="space-y-2">
              <Label>Priority</Label>
              <Input value={priority} onChange={(e) => setPriority(e.target.value)}
                type="number" className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/10 focus:border-blue-500/40" />
              <p className="text-xs text-muted-foreground">Lower = higher priority</p>
            </div>
            <div className="space-y-2">
              <Label>Weight</Label>
              <Input value={weight} onChange={(e) => setWeight(e.target.value)}
                type="number" min="0" max="1000"
                className="bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/10 focus:border-blue-500/40" />
            </div>
          </div>

          {/* Anthropic Built-in Tools */}
          {providerType === 'anthropic' && (
            <div className="space-y-3 pt-1">
              <Label className="text-sm">Built-in Tools (Anthropic Server-side)</Label>
              <div className="space-y-2">
                {ANTHROPIC_BUILTIN_TOOLS.map((tool) => {
                  const Icon = tool.icon;
                  const checked = builtinTools.includes(tool.key);
                  return (
                    <label
                      key={tool.key}
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all duration-200 ${
                        checked
                          ? 'border-blue-500/40 bg-blue-500/5'
                          : 'border-gray-200 dark:border-white/10 bg-background/30 hover:border-blue-500/20'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleBuiltinTool(tool.key)}
                        className="sr-only"
                      />
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                        checked
                          ? 'bg-blue-500/20 text-blue-400'
                          : 'bg-gray-50 dark:bg-white/5 text-muted-foreground'
                      }`}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-medium ${checked ? 'text-foreground' : 'text-muted-foreground'}`}>
                            {tool.label}
                          </span>
                          {checked && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                              Enabled
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground/80 mt-0.5">{tool.description}</p>
                      </div>
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                        checked ? 'bg-blue-500 border-blue-500' : 'border-muted-foreground/30'
                      }`}>
                        {checked && (
                          <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                            <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground/60">
                These tools run on Anthropic&apos;s servers. Web Search incurs additional charges ($10/1000 searches).
              </p>
            </div>
          )}

          {/* Multimodal Capabilities */}
          <div className="space-y-3 pt-1">
            <Label className="text-sm">Multimodal Capabilities</Label>
            <div className="space-y-2">
              {MULTIMODAL_TYPES.map((type) => {
                const Icon = type.icon;
                const checked = multimodalTypes.includes(type.key);
                return (
                  <label
                    key={type.key}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all duration-200 ${
                      checked
                        ? 'border-violet-500/40 bg-violet-500/5'
                        : 'border-gray-200 dark:border-white/10 bg-background/30 hover:border-blue-500/20'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleMultimodalType(type.key)}
                      className="sr-only"
                    />
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                      checked
                        ? 'bg-violet-500/20 text-violet-400'
                        : 'bg-background/50 text-muted-foreground'
                    }`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium ${checked ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {type.label}
                        </span>
                        {checked && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20">
                            Enabled
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground/80 mt-0.5">{type.description}</p>
                    </div>
                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                      checked ? 'bg-violet-500 border-violet-500' : 'border-muted-foreground/30'
                    }`}>
                      {checked && (
                        <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                          <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground/60">
              Enable multimodal input types that this model supports. Attachments of unsupported types will be sent as text descriptions.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="border-gray-200 dark:border-white/10">
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !isValid}
            className="bg-indigo-600 hover:bg-indigo-500">
            {saving ? 'Saving...' : item ? 'Update' : 'Add Model'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
