'use client';

import {
  createCanonicalContentBlockId,
  textBlocks,
  type CanonicalContentBlock,
  type InstalledSkill,
  type SkillMarketplaceEntry,
  type SkillUseScope,
} from '@synapse/shared';
import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ArrowUpRight,
  Boxes,
  ChevronRight,
  FilePlus2,
  FileText,
  FolderClosed,
  Loader2,
  Plus,
  Save,
  ScrollText,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { toast } from 'sonner';

import { useWorkspace } from '@/app/dashboard/workspace-provider';
import { CanonicalContentEditor } from '@/components/canonical-content-editor';
import { CanonicalContentRenderer } from '@/components/canonical-content-renderer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';

type TabValue = 'installed' | 'marketplace';

type ActorOption = {
  id: string;
  name: string;
  title?: string;
};

type ConversationOption = {
  id: string;
  title: string;
};

type MemberOption = {
  id: string;
  name: string;
};

type SkillFileDraft = {
  path: string;
  contentBlocks: CanonicalContentBlock[];
};

type ScopeDraft = {
  useScope: SkillUseScope;
  actorId: string | null;
  conversationId: string | null;
  userId: string | null;
  isEnabled: boolean;
};

type EditorDraft = {
  skillId?: string;
  slug: string;
  name: string;
  summary: string;
  iconUrl: string;
  tagsText: string;
  version: string;
  changelog: string;
  entryPath: string;
  files: SkillFileDraft[];
};

type FileTreeEntry =
  | { kind: 'folder'; path: string; label: string; depth: number }
  | { kind: 'file'; path: string; label: string; depth: number };

const scopeOptions: Array<{
  value: SkillUseScope;
  label: string;
  description: string;
}> = [
  {
    value: 'workspace',
    label: 'Entire workspace',
    description: 'Every conversation and actor in this workspace can use the skill.',
  },
  {
    value: 'conversation',
    label: 'One conversation',
    description: 'Only one conversation can see and use this skill.',
  },
  {
    value: 'actor_global',
    label: 'One actor',
    description: 'One actor can use this skill across its conversations.',
  },
  {
    value: 'actor_conversation',
    label: 'Actor in conversation',
    description: 'One actor can use this skill inside one conversation.',
  },
  {
    value: 'user',
    label: 'One user',
    description: 'Only one user can use this skill personally.',
  },
];

function createEmptySkillFile(path = 'SKILL.md', text = ''): SkillFileDraft {
  return {
    path,
    contentBlocks: [
      {
        id: createCanonicalContentBlockId('text'),
        type: 'text',
        text,
      },
    ],
  };
}

function normalizeFilePath(input: string) {
  return input.replace(/\\/g, '/').trim().replace(/^\/+/, '');
}

function parseTags(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatDate(value?: string) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function objectValue(value: unknown) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function normalizeActorOption(actor: unknown): ActorOption {
  const actorRecord = objectValue(actor);
  const definition = objectValue(actorRecord.definition ?? actorRecord);
  return {
    id: typeof actorRecord.id === 'string' ? actorRecord.id : '',
    name:
      typeof definition.name === 'string'
        ? definition.name
        : typeof definition.title === 'string'
          ? definition.title
          : 'Untitled actor',
    title: typeof definition.title === 'string' ? definition.title : '',
  };
}

function normalizeConversationOption(group: unknown): ConversationOption {
  const groupRecord = objectValue(group);
  return {
    id: typeof groupRecord.id === 'string' ? groupRecord.id : '',
    title: typeof groupRecord.title === 'string' ? groupRecord.title : 'Untitled conversation',
  };
}

function normalizeMemberOption(member: unknown): MemberOption {
  const memberRecord = objectValue(member);
  return {
    id: typeof memberRecord.userId === 'string' ? memberRecord.userId : '',
    name:
      typeof memberRecord.userName === 'string'
        ? memberRecord.userName
        : typeof memberRecord.userEmail === 'string'
          ? memberRecord.userEmail
          : typeof memberRecord.userId === 'string'
            ? memberRecord.userId
            : 'Unknown user',
  };
}

function findSkillFile(files: SkillFileDraft[] | undefined, path: string) {
  return files?.find((file) => file.path === path) || null;
}

function buildFileTreeEntries(files: SkillFileDraft[]): FileTreeEntry[] {
  const entries: FileTreeEntry[] = [];
  const seenFolders = new Set<string>();

  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const segments = file.path.split('/').filter(Boolean);
    const fileName = segments[segments.length - 1] || file.path;

    for (let index = 0; index < segments.length - 1; index += 1) {
      const folderPath = segments.slice(0, index + 1).join('/');
      if (seenFolders.has(folderPath)) continue;
      seenFolders.add(folderPath);
      entries.push({
        kind: 'folder',
        path: folderPath,
        label: segments[index]!,
        depth: index,
      });
    }

    entries.push({
      kind: 'file',
      path: file.path,
      label: fileName,
      depth: Math.max(segments.length - 1, 0),
    });
  }

  return entries;
}

function scopeLabel(scope: SkillUseScope) {
  return scopeOptions.find((option) => option.value === scope)?.label || scope;
}

function scopeDescription(scope: SkillUseScope) {
  return scopeOptions.find((option) => option.value === scope)?.description || '';
}

function resolveScopeTarget(
  draft: Pick<ScopeDraft, 'useScope' | 'actorId' | 'conversationId' | 'userId'>,
  actors: ActorOption[],
  conversations: ConversationOption[],
  members: MemberOption[],
) {
  switch (draft.useScope) {
    case 'workspace':
      return 'Entire workspace';
    case 'conversation':
      return conversations.find((item) => item.id === draft.conversationId)?.title || 'Choose one conversation';
    case 'actor_global':
      return actors.find((item) => item.id === draft.actorId)?.name || 'Choose one actor';
    case 'actor_conversation': {
      const actorName = actors.find((item) => item.id === draft.actorId)?.name || 'Choose actor';
      const conversationName =
        conversations.find((item) => item.id === draft.conversationId)?.title || 'choose conversation';
      return `${actorName} in ${conversationName}`;
    }
    case 'user':
      return members.find((item) => item.id === draft.userId)?.name || 'Choose one user';
    default:
      return 'Not configured';
  }
}

function createScopeDraft(skill?: InstalledSkill | null): ScopeDraft {
  return {
    useScope: skill?.useScope || 'workspace',
    actorId: skill?.actorId || null,
    conversationId: skill?.conversationId || null,
    userId: skill?.userId || null,
    isEnabled: skill?.isEnabled ?? true,
  };
}

function createMarketplaceDraft(skill?: SkillMarketplaceEntry | null): EditorDraft {
  const latestVersion = skill?.latestVersion;
  return {
    skillId: skill?.id,
    slug: skill?.slug || '',
    name: skill?.name || '',
    summary: skill?.summary || '',
    iconUrl: skill?.iconUrl || '',
    tagsText: skill?.tags.join(', ') || '',
    version: latestVersion?.version || '1.0.0',
    changelog: latestVersion?.changelog || '',
    entryPath: latestVersion?.entryPath || 'SKILL.md',
    files:
      latestVersion?.files?.map((file) => ({
        path: file.path,
        contentBlocks: file.contentBlocks,
      })) || [createEmptySkillFile()],
  };
}

function createInstalledDraft(skill?: InstalledSkill | null): EditorDraft {
  return {
    slug: skill?.slug || '',
    name: skill?.name || '',
    summary: skill?.summary || '',
    iconUrl: skill?.iconUrl || '',
    tagsText: skill?.tags.join(', ') || '',
    version: skill?.sourceVersion || '',
    changelog: '',
    entryPath: skill?.entryPath || 'SKILL.md',
    files:
      skill?.files?.map((file) => ({
        path: file.path,
        contentBlocks: file.contentBlocks,
      })) || [createEmptySkillFile()],
  };
}

function StatCard({
  title,
  value,
  detail,
  icon: Icon,
}: {
  title: string;
  value: string;
  detail: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-[24px] border border-white/40 bg-white/70 p-4 shadow-sm backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">{title}</div>
          <div className="mt-2 text-2xl font-semibold text-slate-950">{value}</div>
          <div className="mt-1 text-sm text-slate-600">{detail}</div>
        </div>
        <div className="flex size-10 items-center justify-center rounded-2xl bg-slate-950 text-white">
          <Icon />
        </div>
      </div>
    </div>
  );
}

function ScopeFields({
  value,
  onChange,
  actors,
  conversations,
  members,
}: {
  value: ScopeDraft;
  onChange: (next: ScopeDraft) => void;
  actors: ActorOption[];
  conversations: ConversationOption[];
  members: MemberOption[];
}) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel>Use scope</FieldLabel>
        <Select
          value={value.useScope}
          onValueChange={(nextValue: SkillUseScope) =>
            onChange({
              useScope: nextValue,
              actorId: nextValue === 'actor_global' || nextValue === 'actor_conversation' ? value.actorId : null,
              conversationId: nextValue === 'conversation' || nextValue === 'actor_conversation' ? value.conversationId : null,
              userId: nextValue === 'user' ? value.userId : null,
              isEnabled: value.isEnabled,
            })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder="Choose scope" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {scopeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>{scopeDescription(value.useScope)}</FieldDescription>
      </Field>

      {value.useScope === 'conversation' || value.useScope === 'actor_conversation' ? (
        <Field>
          <FieldLabel>Conversation</FieldLabel>
          <Select
            value={value.conversationId || undefined}
            onValueChange={(nextValue) => onChange({ ...value, conversationId: nextValue })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Choose conversation" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {conversations.map((conversation) => (
                  <SelectItem key={conversation.id} value={conversation.id}>
                    {conversation.title}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      ) : null}

      {value.useScope === 'actor_global' || value.useScope === 'actor_conversation' ? (
        <Field>
          <FieldLabel>Actor</FieldLabel>
          <Select
            value={value.actorId || undefined}
            onValueChange={(nextValue) => onChange({ ...value, actorId: nextValue })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Choose actor" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {actors.map((actor) => (
                  <SelectItem key={actor.id} value={actor.id}>
                    {actor.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      ) : null}

      {value.useScope === 'user' ? (
        <Field>
          <FieldLabel>User</FieldLabel>
          <Select
            value={value.userId || undefined}
            onValueChange={(nextValue) => onChange({ ...value, userId: nextValue })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Choose user" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {members.map((member) => (
                  <SelectItem key={member.id} value={member.id}>
                    {member.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
    </FieldGroup>
  );
}

function SkillEditorDialog({
  open,
  mode,
  workspaceId,
  initialSkill,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  mode: 'marketplace' | 'installed';
  workspaceId: string | null;
  initialSkill: SkillMarketplaceEntry | InstalledSkill | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (skillId?: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<EditorDraft>(() =>
    mode === 'marketplace'
      ? createMarketplaceDraft(initialSkill as SkillMarketplaceEntry | null)
      : createInstalledDraft(initialSkill as InstalledSkill | null),
  );
  const [selectedFilePath, setSelectedFilePath] = useState('SKILL.md');
  const [newFilePath, setNewFilePath] = useState('references/new-note.md');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const nextDraft =
      mode === 'marketplace'
        ? createMarketplaceDraft(initialSkill as SkillMarketplaceEntry | null)
        : createInstalledDraft(initialSkill as InstalledSkill | null);
    setDraft(nextDraft);
    setSelectedFilePath(nextDraft.entryPath || nextDraft.files[0]?.path || 'SKILL.md');
    setNewFilePath('references/new-note.md');
  }, [initialSkill, mode, open]);

  const selectedFile =
    findSkillFile(draft.files, selectedFilePath) ||
    findSkillFile(draft.files, draft.entryPath) ||
    draft.files[0] ||
    null;

  const treeEntries = useMemo(() => buildFileTreeEntries(draft.files), [draft.files]);

  const commitFile = useCallback(
    (filePath: string, updater: (file: SkillFileDraft) => SkillFileDraft) => {
      setDraft((current) => ({
        ...current,
        files: current.files.map((file) => (file.path === filePath ? updater(file) : file)),
      }));
    },
    [],
  );

  function addFile() {
    const nextPath = normalizeFilePath(newFilePath);
    if (!nextPath) {
      toast.error('Enter a file path first');
      return;
    }
    if (draft.files.some((file) => file.path === nextPath)) {
      toast.error('That file already exists');
      return;
    }

    setDraft((current) => ({
      ...current,
      files: [...current.files, createEmptySkillFile(nextPath)],
    }));
    setSelectedFilePath(nextPath);
    setNewFilePath('references/new-note.md');
  }

  function renameSelectedFile(nextPathInput: string) {
    if (!selectedFile) return;
    const nextPath = normalizeFilePath(nextPathInput);
    if (!nextPath) {
      return;
    }
    if (nextPath !== selectedFile.path && draft.files.some((file) => file.path === nextPath)) {
      toast.error('That file path is already in use');
      return;
    }

    setDraft((current) => ({
      ...current,
      entryPath: current.entryPath === selectedFile.path ? nextPath : current.entryPath,
      files: current.files.map((file) => (file.path === selectedFile.path ? { ...file, path: nextPath } : file)),
    }));
    setSelectedFilePath(nextPath);
  }

  function removeSelectedFile() {
    if (!selectedFile) return;
    if (draft.files.length === 1) {
      toast.error('A skill needs at least one file');
      return;
    }

    const remaining = draft.files.filter((file) => file.path !== selectedFile.path);
    const nextEntryPath = draft.entryPath === selectedFile.path ? remaining[0]!.path : draft.entryPath;
    setDraft((current) => ({
      ...current,
      entryPath: nextEntryPath,
      files: remaining,
    }));
    setSelectedFilePath(nextEntryPath);
  }

  async function handleSave() {
    if (!workspaceId) return;
    const entryPath = normalizeFilePath(draft.entryPath);
    const files = draft.files.map((file) => ({
      path: normalizeFilePath(file.path),
      contentBlocks: file.contentBlocks,
    }));

    if (!draft.name.trim()) {
      toast.error('Skill name is required');
      return;
    }
    if (mode === 'marketplace' && !draft.slug.trim()) {
      toast.error('Skill slug is required');
      return;
    }
    if (!entryPath) {
      toast.error('Entry file is required');
      return;
    }
    if (files.length === 0) {
      toast.error('At least one file is required');
      return;
    }
    if (!files.some((file) => file.path === entryPath)) {
      toast.error('Entry file must exist in the file tree');
      return;
    }
    if (files.some((file) => !file.path)) {
      toast.error('Every file needs a valid path');
      return;
    }

    setSaving(true);
    try {
      if (mode === 'marketplace') {
        const result = await api.publishMarketplaceSkill({
          skillId: draft.skillId,
          slug: draft.slug.trim(),
          name: draft.name.trim(),
          summary: draft.summary.trim(),
          iconUrl: draft.iconUrl.trim() || undefined,
          tags: parseTags(draft.tagsText),
          version: draft.version.trim() || '1.0.0',
          changelog: draft.changelog.trim(),
          entryPath,
          files,
        });
        toast.success(draft.skillId ? 'Marketplace skill updated' : 'Marketplace skill published');
        onOpenChange(false);
        await onSaved(result.skill.id);
        return;
      }

      const installedSkill = initialSkill as InstalledSkill | null;
      if (!installedSkill?.id) {
        toast.error('Missing installed skill context');
        return;
      }
      await api.updateInstalledSkill(workspaceId, installedSkill.id, {
        name: draft.name.trim(),
        summary: draft.summary.trim(),
        iconUrl: draft.iconUrl.trim() || null,
        tags: parseTags(draft.tagsText),
        entryPath,
        files,
      });
      toast.success('Installed skill updated');
      onOpenChange(false);
      await onSaved(installedSkill.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-hidden p-0 sm:max-w-[min(96vw,1320px)]">
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle>{mode === 'marketplace' ? 'Skill marketplace editor' : 'Edit installed skill'}</DialogTitle>
          <DialogDescription>
            {mode === 'marketplace'
              ? 'Publish a platform skill with structured files. Each file is stored as canonical content blocks.'
              : 'Edit the workspace copy. The source stays linked so you can still upgrade later.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[280px_1fr]">
          <div className="border-b border-border bg-muted/20 lg:border-r lg:border-b-0">
            <div className="flex items-center justify-between gap-2 px-5 py-4">
              <div>
                <div className="text-sm font-medium text-foreground">Files</div>
                <div className="text-xs text-muted-foreground">{draft.files.length} assets in this skill</div>
              </div>
              <Badge variant="outline">{draft.entryPath}</Badge>
            </div>

            <div className="max-h-[42vh] overflow-y-auto px-3 pb-3 lg:max-h-[68vh]">
              <div className="flex flex-col gap-1">
                {treeEntries.map((entry) =>
                  entry.kind === 'folder' ? (
                    <div
                      key={`folder-${entry.path}`}
                      className="flex items-center gap-2 rounded-2xl px-3 py-2 text-sm text-muted-foreground"
                      style={{ paddingLeft: `${entry.depth * 16 + 12}px` }}
                    >
                      <FolderClosed className="size-4" />
                      <span>{entry.label}</span>
                    </div>
                  ) : (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => setSelectedFilePath(entry.path)}
                      className={`flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm transition-colors ${
                        selectedFile?.path === entry.path
                          ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
                          : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'
                      }`}
                      style={{ paddingLeft: `${entry.depth * 16 + 12}px` }}
                    >
                      <FileText className="size-4" />
                      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                      {draft.entryPath === entry.path ? <Badge variant="secondary">Entry</Badge> : null}
                    </button>
                  ),
                )}
              </div>
            </div>

            <div className="border-t border-border px-4 py-4">
              <FieldGroup>
                <Field>
                  <FieldLabel>New file path</FieldLabel>
                  <Input
                    value={newFilePath}
                    onChange={(event) => setNewFilePath(event.target.value)}
                    placeholder="references/new-note.md"
                  />
                </Field>
                <Button type="button" variant="outline" onClick={addFile}>
                  <FilePlus2 data-icon="inline-start" />
                  Add file
                </Button>
              </FieldGroup>
            </div>
          </div>

          <div className="min-h-0 overflow-y-auto">
            <div className="flex flex-col gap-6 p-6">
              <Card>
                <CardHeader>
                  <CardTitle>Skill basics</CardTitle>
                  <CardDescription>Keep the naming and summary readable in both the marketplace and installed views.</CardDescription>
                </CardHeader>
                <CardContent>
                  <FieldGroup>
                    {mode === 'marketplace' ? (
                      <Field>
                        <FieldLabel>Slug</FieldLabel>
                        <Input
                          value={draft.slug}
                          onChange={(event) => setDraft((current) => ({ ...current, slug: event.target.value }))}
                          placeholder="meeting-brief"
                        />
                      </Field>
                    ) : null}

                    <Field>
                      <FieldLabel>Name</FieldLabel>
                      <Input
                        value={draft.name}
                        onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                        placeholder="Meeting Brief"
                      />
                    </Field>

                    <Field>
                      <FieldLabel>Summary</FieldLabel>
                      <Textarea
                        value={draft.summary}
                        onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
                        rows={3}
                        placeholder="Explain what this skill does and when people should install it."
                      />
                    </Field>

                    <Field>
                      <FieldLabel>Tags</FieldLabel>
                      <Input
                        value={draft.tagsText}
                        onChange={(event) => setDraft((current) => ({ ...current, tagsText: event.target.value }))}
                        placeholder="meetings, summary, writing"
                      />
                    </Field>

                    <Field>
                      <FieldLabel>Icon URL</FieldLabel>
                      <Input
                        value={draft.iconUrl}
                        onChange={(event) => setDraft((current) => ({ ...current, iconUrl: event.target.value }))}
                        placeholder="https://..."
                      />
                    </Field>
                  </FieldGroup>
                </CardContent>
              </Card>

              {mode === 'marketplace' ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Release metadata</CardTitle>
                    <CardDescription>Publishing a new version updates the latest marketplace release for this skill.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <FieldGroup>
                      <Field>
                        <FieldLabel>Version</FieldLabel>
                        <Input
                          value={draft.version}
                          onChange={(event) => setDraft((current) => ({ ...current, version: event.target.value }))}
                          placeholder="1.0.0"
                        />
                      </Field>
                      <Field>
                        <FieldLabel>Changelog</FieldLabel>
                        <Textarea
                          value={draft.changelog}
                          onChange={(event) => setDraft((current) => ({ ...current, changelog: event.target.value }))}
                          rows={3}
                          placeholder="What changed in this release?"
                        />
                      </Field>
                    </FieldGroup>
                  </CardContent>
                </Card>
              ) : null}

              <Card>
                <CardHeader>
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <CardTitle>Selected file</CardTitle>
                      <CardDescription>Choose the entry file and edit the file contents as canonical content blocks.</CardDescription>
                    </div>
                    {selectedFile ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          variant={draft.entryPath === selectedFile.path ? 'secondary' : 'outline'}
                          onClick={() => setDraft((current) => ({ ...current, entryPath: selectedFile.path }))}
                        >
                          <ScrollText data-icon="inline-start" />
                          {draft.entryPath === selectedFile.path ? 'Entry file' : 'Make entry'}
                        </Button>
                        <Button type="button" variant="destructive" onClick={removeSelectedFile}>
                          <Trash2 data-icon="inline-start" />
                          Remove
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-5">
                  {selectedFile ? (
                    <>
                      <FieldGroup>
                        <Field>
                          <FieldLabel>File path</FieldLabel>
                          <Input
                            value={selectedFile.path}
                            onChange={(event) => renameSelectedFile(event.target.value)}
                          />
                          <FieldDescription>Use nested paths like `references/checklist.md` to keep the skill organized.</FieldDescription>
                        </Field>
                      </FieldGroup>

                      <CanonicalContentEditor
                        workspaceId={workspaceId}
                        value={selectedFile.contentBlocks}
                        onChange={(nextBlocks) =>
                          commitFile(selectedFile.path, (file) => ({ ...file, contentBlocks: nextBlocks }))
                        }
                        label={selectedFile.path}
                        description="Compose this file with ordered text blocks and optional file references."
                        showCount
                      />
                    </>
                  ) : (
                    <div className="rounded-[24px] border border-dashed border-border bg-muted/10 px-5 py-10 text-sm text-muted-foreground">
                      Add a file on the left to start editing.
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border px-6 py-5">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InstallSkillDialog({
  open,
  skill,
  actors,
  conversations,
  members,
  workspaceId,
  onOpenChange,
  onInstalled,
}: {
  open: boolean;
  skill: SkillMarketplaceEntry | null;
  actors: ActorOption[];
  conversations: ConversationOption[];
  members: MemberOption[];
  workspaceId: string | null;
  onOpenChange: (open: boolean) => void;
  onInstalled: (skillId: string) => Promise<void> | void;
}) {
  const [scopeDraft, setScopeDraft] = useState<ScopeDraft>(createScopeDraft());
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (open) {
      setScopeDraft(createScopeDraft());
    }
  }, [open]);

  async function handleInstall() {
    if (!workspaceId || !skill) return;
    setInstalling(true);
    try {
      const result = await api.installSkill(workspaceId, {
        marketSkillId: skill.id,
        useScope: scopeDraft.useScope,
        actorId:
          scopeDraft.useScope === 'actor_global' || scopeDraft.useScope === 'actor_conversation'
            ? scopeDraft.actorId || undefined
            : undefined,
        conversationId:
          scopeDraft.useScope === 'conversation' || scopeDraft.useScope === 'actor_conversation'
            ? scopeDraft.conversationId || undefined
            : undefined,
        userId: scopeDraft.useScope === 'user' ? scopeDraft.userId || undefined : undefined,
      });
      toast.success('Skill installed');
      onOpenChange(false);
      await onInstalled(result.skill.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Install failed');
    } finally {
      setInstalling(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install skill</DialogTitle>
          <DialogDescription>
            Install a workspace copy of the marketplace skill. The copy keeps its source so it can be upgraded later.
          </DialogDescription>
        </DialogHeader>

        {skill ? (
          <div className="flex flex-col gap-6">
            <Card className="bg-muted/20">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex size-11 items-center justify-center rounded-2xl bg-background text-foreground shadow-sm">
                    <Sparkles />
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base">{skill.name}</CardTitle>
                    <CardDescription className="mt-1">{skill.summary || 'No summary provided.'}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>

            <ScopeFields
              value={scopeDraft}
              onChange={setScopeDraft}
              actors={actors}
              conversations={conversations}
              members={members}
            />
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void handleInstall()} disabled={installing || !skill}>
            {installing ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <UploadCloud data-icon="inline-start" />}
            Install copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SkillsPage() {
  const { workspaceId, workspaceName } = useWorkspace();

  const [activeTab, setActiveTab] = useState<TabValue>('installed');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);

  const [marketplace, setMarketplace] = useState<SkillMarketplaceEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [actors, setActors] = useState<ActorOption[]>([]);
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [canPublishMarketplaceSkills, setCanPublishMarketplaceSkills] = useState(false);

  const [loadingPage, setLoadingPage] = useState(false);
  const [loadingInstalledDetail, setLoadingInstalledDetail] = useState(false);
  const [loadingMarketplaceDetail, setLoadingMarketplaceDetail] = useState(false);

  const [selectedInstalledId, setSelectedInstalledId] = useState<string | null>(null);
  const [selectedMarketplaceId, setSelectedMarketplaceId] = useState<string | null>(null);
  const [selectedInstalledSkill, setSelectedInstalledSkill] = useState<InstalledSkill | null>(null);
  const [selectedMarketplaceSkill, setSelectedMarketplaceSkill] = useState<SkillMarketplaceEntry | null>(null);

  const [scopeDraft, setScopeDraft] = useState<ScopeDraft>(createScopeDraft());
  const [savingScope, setSavingScope] = useState(false);
  const [upgradingSkill, setUpgradingSkill] = useState(false);
  const [removingSkill, setRemovingSkill] = useState(false);

  const [marketplaceEditorOpen, setMarketplaceEditorOpen] = useState(false);
  const [marketplaceEditorSkill, setMarketplaceEditorSkill] = useState<SkillMarketplaceEntry | null>(null);
  const [installedEditorOpen, setInstalledEditorOpen] = useState(false);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);

  const filteredInstalled = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    if (!query) return installed;
    return installed.filter((skill) =>
      [skill.name, skill.slug, skill.summary, skill.tags.join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(query),
    );
  }, [deferredSearch, installed]);

  const filteredMarketplace = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    if (!query) return marketplace;
    return marketplace.filter((skill) =>
      [skill.name, skill.slug, skill.summary, skill.tags.join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(query),
    );
  }, [deferredSearch, marketplace]);

  const installedBySource = useMemo(() => {
    const map = new Map<string, number>();
    for (const skill of installed) {
      if (!skill.sourceSkillId) continue;
      map.set(skill.sourceSkillId, (map.get(skill.sourceSkillId) || 0) + 1);
    }
    return map;
  }, [installed]);

  const upgradeableCount = useMemo(
    () => installed.filter((skill) => skill.upgradeAvailable).length,
    [installed],
  );

  const refreshIndex = useCallback(async () => {
    if (!workspaceId) return;
    setLoadingPage(true);
    try {
      const [marketplaceResponse, installedResponse, actorsResponse, groupsResponse, membersResponse, platformNavigationResponse] =
        await Promise.all([
          api.getSkillMarketplace(),
          api.getInstalledSkills(workspaceId),
          api.getActors(workspaceId),
          api.getGroups(workspaceId),
          api.getWorkspaceMembers(workspaceId),
          api.getPlatformNavigation(),
        ]);

      const nextMarketplace = Array.isArray(marketplaceResponse?.skills) ? marketplaceResponse.skills : [];
      const nextInstalled = Array.isArray(installedResponse?.skills) ? installedResponse.skills : [];
      const nextActors = Array.isArray(actorsResponse) ? actorsResponse.map(normalizeActorOption) : [];
      const nextConversations = Array.isArray(groupsResponse?.groups)
        ? groupsResponse.groups.map(normalizeConversationOption)
        : [];
      const nextMembers = Array.isArray(membersResponse?.data)
        ? membersResponse.data.map(normalizeMemberOption)
        : [];
      const platformNavigation = platformNavigationResponse?.data || platformNavigationResponse || {};

      setMarketplace(nextMarketplace);
      setInstalled(nextInstalled);
      setActors(nextActors);
      setConversations(nextConversations);
      setMembers(nextMembers);
      setCanPublishMarketplaceSkills(Boolean(platformNavigation.canAccessPlatformSkills));

      setSelectedInstalledId((current) =>
        current && nextInstalled.some((skill) => skill.id === current) ? current : nextInstalled[0]?.id || null,
      );
      setSelectedMarketplaceId((current) =>
        current && nextMarketplace.some((skill) => skill.id === current) ? current : nextMarketplace[0]?.id || null,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load skills');
    } finally {
      setLoadingPage(false);
    }
  }, [workspaceId]);

  const refreshInstalledDetail = useCallback(
    async (skillId: string | null) => {
      if (!workspaceId || !skillId) {
        setSelectedInstalledSkill(null);
        return;
      }
      setLoadingInstalledDetail(true);
      try {
        const response = await api.getInstalledSkill(workspaceId, skillId);
        setSelectedInstalledSkill(response.skill);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to load installed skill');
      } finally {
        setLoadingInstalledDetail(false);
      }
    },
    [workspaceId],
  );

  const refreshMarketplaceDetail = useCallback(async (skillId: string | null) => {
    if (!skillId) {
      setSelectedMarketplaceSkill(null);
      return;
    }
    setLoadingMarketplaceDetail(true);
    try {
      const response = await api.getSkillMarketplaceItem(skillId);
      setSelectedMarketplaceSkill(response.skill);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load marketplace skill');
    } finally {
      setLoadingMarketplaceDetail(false);
    }
  }, []);

  useEffect(() => {
    void refreshIndex();
  }, [refreshIndex]);

  useEffect(() => {
    if (filteredInstalled.length === 0) {
      setSelectedInstalledId(null);
      setSelectedInstalledSkill(null);
      return;
    }
    if (!selectedInstalledId || !filteredInstalled.some((skill) => skill.id === selectedInstalledId)) {
      setSelectedInstalledId(filteredInstalled[0]!.id);
    }
  }, [filteredInstalled, selectedInstalledId]);

  useEffect(() => {
    if (filteredMarketplace.length === 0) {
      setSelectedMarketplaceId(null);
      setSelectedMarketplaceSkill(null);
      return;
    }
    if (!selectedMarketplaceId || !filteredMarketplace.some((skill) => skill.id === selectedMarketplaceId)) {
      setSelectedMarketplaceId(filteredMarketplace[0]!.id);
    }
  }, [filteredMarketplace, selectedMarketplaceId]);

  useEffect(() => {
    void refreshInstalledDetail(selectedInstalledId);
  }, [refreshInstalledDetail, selectedInstalledId]);

  useEffect(() => {
    void refreshMarketplaceDetail(selectedMarketplaceId);
  }, [refreshMarketplaceDetail, selectedMarketplaceId]);

  useEffect(() => {
    setScopeDraft(createScopeDraft(selectedInstalledSkill));
  }, [selectedInstalledSkill]);

  async function handleScopeSave() {
    if (!workspaceId || !selectedInstalledSkill) return;
    setSavingScope(true);
    try {
      await api.updateInstalledSkill(workspaceId, selectedInstalledSkill.id, {
        useScope: scopeDraft.useScope,
        actorId:
          scopeDraft.useScope === 'actor_global' || scopeDraft.useScope === 'actor_conversation'
            ? scopeDraft.actorId
            : null,
        conversationId:
          scopeDraft.useScope === 'conversation' || scopeDraft.useScope === 'actor_conversation'
            ? scopeDraft.conversationId
            : null,
        userId: scopeDraft.useScope === 'user' ? scopeDraft.userId : null,
        isEnabled: scopeDraft.isEnabled,
      });
      await refreshIndex();
      await refreshInstalledDetail(selectedInstalledSkill.id);
      toast.success('Skill authorization updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update authorization');
    } finally {
      setSavingScope(false);
    }
  }

  async function handleUpgrade() {
    if (!workspaceId || !selectedInstalledSkill) return;
    setUpgradingSkill(true);
    try {
      await api.upgradeInstalledSkill(workspaceId, selectedInstalledSkill.id);
      await refreshIndex();
      await refreshInstalledDetail(selectedInstalledSkill.id);
      toast.success('Skill upgraded to the latest marketplace version');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Upgrade failed');
    } finally {
      setUpgradingSkill(false);
    }
  }

  async function handleUninstall() {
    if (!workspaceId || !selectedInstalledSkill) return;
    setRemovingSkill(true);
    try {
      const removedId = selectedInstalledSkill.id;
      await api.uninstallInstalledSkill(workspaceId, removedId);
      await refreshIndex();
      if (selectedInstalledId === removedId) {
        setSelectedInstalledId(null);
      }
      toast.success('Skill uninstalled');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to uninstall skill');
    } finally {
      setRemovingSkill(false);
    }
  }

  async function handleMarketplaceEditorSaved(skillId?: string) {
    await refreshIndex();
    if (skillId) {
      setSelectedMarketplaceId(skillId);
      await refreshMarketplaceDetail(skillId);
    }
  }

  async function handleInstalledEditorSaved(skillId?: string) {
    await refreshIndex();
    if (skillId) {
      setSelectedInstalledId(skillId);
      await refreshInstalledDetail(skillId);
    }
  }

  async function handleInstalled(skillId: string) {
    await refreshIndex();
    startTransition(() => {
      setActiveTab('installed');
      setSelectedInstalledId(skillId);
    });
    await refreshInstalledDetail(skillId);
  }

  const installedEntryFile = findSkillFile(
    selectedInstalledSkill?.files?.map((file) => ({
      path: file.path,
      contentBlocks: file.contentBlocks,
    })) || [],
    selectedInstalledSkill?.entryPath || 'SKILL.md',
  );

  const marketplaceEntryFile = findSkillFile(
    selectedMarketplaceSkill?.latestVersion?.files?.map((file) => ({
      path: file.path,
      contentBlocks: file.contentBlocks,
    })) || [],
    selectedMarketplaceSkill?.latestVersion?.entryPath || 'SKILL.md',
  );

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <section className="relative overflow-hidden rounded-[32px] border border-slate-200 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.18),_transparent_36%),radial-gradient(circle_at_85%_20%,_rgba(251,191,36,0.24),_transparent_28%),linear-gradient(135deg,_#f8fafc,_#fff7ed)] p-6 shadow-sm">
        <div className="absolute inset-0 bg-[linear-gradient(135deg,transparent_0%,rgba(255,255,255,0.55)_45%,transparent_100%)]" />
        <div className="relative flex flex-col gap-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-xs font-medium uppercase tracking-[0.22em] text-slate-600">
                <ScrollText className="size-3.5" />
                Skill Workbench
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">Skill market, installation, and scope control</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                Publish platform skills, install workspace copies, and manage where each installed skill is allowed to run.
                {workspaceName ? ` Current workspace: ${workspaceName}.` : ''}
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              {canPublishMarketplaceSkills ? (
                <Button
                  onClick={() => {
                    setMarketplaceEditorSkill(null);
                    setMarketplaceEditorOpen(true);
                  }}
                >
                  <Plus data-icon="inline-start" />
                  Publish skill
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => void refreshIndex()} disabled={loadingPage}>
                {loadingPage ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <ArrowUpRight data-icon="inline-start" />}
                Refresh
              </Button>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <StatCard title="Marketplace Skills" value={String(marketplace.length)} detail="Platform-distributed skills ready for installation." icon={Sparkles} />
            <StatCard title="Installed Copies" value={String(installed.length)} detail="Workspace-owned copies with editable content." icon={Boxes} />
            <StatCard title="Upgrades Pending" value={String(upgradeableCount)} detail="Installed skills with newer marketplace releases." icon={ShieldCheck} />
          </div>
        </div>
      </section>

      <Tabs value={activeTab} onValueChange={(nextValue) => startTransition(() => setActiveTab(nextValue as TabValue))}>
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <TabsList>
            <TabsTrigger value="installed">Installed</TabsTrigger>
            <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
          </TabsList>

          <div className="relative w-full xl:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={activeTab === 'installed' ? 'Search installed skills' : 'Search marketplace'}
              className="pl-10"
            />
          </div>
        </div>

        <TabsContent value="installed" className="mt-6">
          <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
            <Card className="overflow-hidden">
              <CardHeader className="border-b border-border bg-muted/20">
                <CardTitle>Installed skills</CardTitle>
                <CardDescription>Each install is a workspace copy with its own usage scope and editable files.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {loadingPage ? (
                  <div className="flex items-center justify-center px-6 py-12 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 animate-spin" />
                    Loading installed skills...
                  </div>
                ) : filteredInstalled.length === 0 ? (
                  <div className="px-6 py-12 text-sm text-muted-foreground">
                    No installed skills matched this view.
                  </div>
                ) : (
                  <div className="flex max-h-[72vh] flex-col overflow-y-auto">
                    {filteredInstalled.map((skill) => (
                      <button
                        key={skill.id}
                        type="button"
                        onClick={() => setSelectedInstalledId(skill.id)}
                        className={`flex items-start gap-3 border-b border-border/70 px-5 py-4 text-left transition-colors last:border-b-0 ${
                          selectedInstalledId === skill.id ? 'bg-accent/40' : 'hover:bg-accent/20'
                        }`}
                      >
                        <div className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                          <ScrollText />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="truncate text-sm font-medium text-foreground">{skill.name}</div>
                            <Badge variant="outline">{scopeLabel(skill.useScope)}</Badge>
                            {skill.upgradeAvailable ? <Badge variant="secondary">Update</Badge> : null}
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            {skill.summary || 'No summary provided.'}
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {skill.tags.slice(0, 3).map((tag) => (
                              <Badge key={tag} variant="secondary">
                                {tag}
                              </Badge>
                            ))}
                            {skill.sourceVersion ? <Badge variant="outline">v{skill.sourceVersion}</Badge> : null}
                          </div>
                        </div>
                        <ChevronRight className="mt-1 shrink-0 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="overflow-hidden">
              <CardHeader className="border-b border-border bg-muted/20">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <CardTitle>{selectedInstalledSkill?.name || 'Installed skill detail'}</CardTitle>
                    <CardDescription>
                      {selectedInstalledSkill
                        ? 'Manage the editable workspace copy and the scope that is allowed to use it.'
                        : 'Choose an installed skill to inspect it.'}
                    </CardDescription>
                  </div>

                  {selectedInstalledSkill ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setInstalledEditorOpen(true);
                        }}
                      >
                        <FileText data-icon="inline-start" />
                        Edit copy
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => void handleUpgrade()}
                        disabled={!selectedInstalledSkill.upgradeAvailable || upgradingSkill}
                      >
                        {upgradingSkill ? (
                          <Loader2 className="animate-spin" data-icon="inline-start" />
                        ) : (
                          <UploadCloud data-icon="inline-start" />
                        )}
                        Upgrade
                      </Button>
                      <Button variant="destructive" onClick={() => void handleUninstall()} disabled={removingSkill}>
                        {removingSkill ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
                        Uninstall
                      </Button>
                    </div>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="p-6">
                {!selectedInstalledSkill ? (
                  <div className="rounded-[24px] border border-dashed border-border bg-muted/10 px-5 py-14 text-sm text-muted-foreground">
                    Pick an installed skill from the left to manage its scope and content.
                  </div>
                ) : loadingInstalledDetail ? (
                  <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 animate-spin" />
                    Loading installed skill...
                  </div>
                ) : (
                  <div className="flex flex-col gap-6">
                    <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base">Overview</CardTitle>
                          <CardDescription>Source tracking, version state, and the primary entry file.</CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-4">
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline">{scopeLabel(selectedInstalledSkill.useScope)}</Badge>
                            {selectedInstalledSkill.isCustomized ? <Badge variant="secondary">Customized</Badge> : null}
                            {selectedInstalledSkill.upgradeAvailable ? <Badge variant="secondary">New source version available</Badge> : null}
                            <Badge variant={selectedInstalledSkill.isEnabled ? 'secondary' : 'outline'}>
                              {selectedInstalledSkill.isEnabled ? 'Enabled' : 'Disabled'}
                            </Badge>
                          </div>
                          <div className="text-sm text-muted-foreground">{selectedInstalledSkill.summary || 'No summary provided.'}</div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="rounded-2xl border border-border bg-muted/10 p-4">
                              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Source</div>
                              <div className="mt-2 text-sm font-medium text-foreground">
                                {selectedInstalledSkill.sourceSkillId ? 'Marketplace linked' : 'Workspace only'}
                              </div>
                              <div className="mt-1 text-sm text-muted-foreground">
                                Current version {selectedInstalledSkill.sourceVersion || 'workspace-copy'}
                                {selectedInstalledSkill.latestSourceVersion ? ` · latest ${selectedInstalledSkill.latestSourceVersion}` : ''}
                              </div>
                            </div>
                            <div className="rounded-2xl border border-border bg-muted/10 p-4">
                              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Entry file</div>
                              <div className="mt-2 text-sm font-medium text-foreground">{selectedInstalledSkill.entryPath}</div>
                              <div className="mt-1 text-sm text-muted-foreground">
                                Updated {formatDate(selectedInstalledSkill.updatedAt)}
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base">Authorization</CardTitle>
                          <CardDescription>
                            Authorization here means the usage range. Decide which workspace surface can call this skill.
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-5">
                          <ScopeFields
                            value={scopeDraft}
                            onChange={setScopeDraft}
                            actors={actors}
                            conversations={conversations}
                            members={members}
                          />

                          <FieldGroup>
                            <Field>
                              <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-muted/10 px-4 py-3">
                                <div>
                                  <FieldLabel>Enabled</FieldLabel>
                                  <FieldDescription>Disabled skills stay installed but are hidden from runtime resolution.</FieldDescription>
                                </div>
                                <Switch
                                  checked={scopeDraft.isEnabled}
                                  onCheckedChange={(checked) => setScopeDraft((current) => ({ ...current, isEnabled: checked }))}
                                />
                              </div>
                            </Field>
                          </FieldGroup>

                          <div className="rounded-2xl border border-border bg-muted/10 px-4 py-3 text-sm text-muted-foreground">
                            <div className="font-medium text-foreground">Current access target</div>
                            <div className="mt-1">{resolveScopeTarget(scopeDraft, actors, conversations, members)}</div>
                          </div>

                          <Button onClick={() => void handleScopeSave()} disabled={savingScope}>
                            {savingScope ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <ShieldCheck data-icon="inline-start" />}
                            Save authorization
                          </Button>
                        </CardContent>
                      </Card>
                    </div>

                    <div className="grid gap-4 lg:grid-cols-[0.92fr_1.08fr]">
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base">File directory</CardTitle>
                          <CardDescription>The installed copy keeps its own file set. Open the editor to change any file.</CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-2">
                          {(selectedInstalledSkill.files || []).map((file) => (
                            <div key={file.path} className="flex items-center gap-3 rounded-2xl border border-border bg-muted/10 px-4 py-3">
                              <div className="flex size-9 items-center justify-center rounded-xl bg-background text-muted-foreground">
                                <FileText className="size-4" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-foreground">{file.path}</div>
                                <div className="text-xs text-muted-foreground">{file.contentBlocks.length} blocks</div>
                              </div>
                              {selectedInstalledSkill.entryPath === file.path ? <Badge variant="secondary">Entry</Badge> : null}
                            </div>
                          ))}
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base">Entry preview</CardTitle>
                          <CardDescription>{installedEntryFile?.path || selectedInstalledSkill.entryPath}</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <CanonicalContentRenderer
                            blocks={installedEntryFile?.contentBlocks || textBlocks('No entry file content found.')}
                          />
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="marketplace" className="mt-6">
          <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
            <Card className="overflow-hidden">
              <CardHeader className="border-b border-border bg-muted/20">
                <CardTitle>Marketplace</CardTitle>
                <CardDescription>Platform-published skills that can be copied into this workspace.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {loadingPage ? (
                  <div className="flex items-center justify-center px-6 py-12 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 animate-spin" />
                    Loading marketplace...
                  </div>
                ) : filteredMarketplace.length === 0 ? (
                  <div className="px-6 py-12 text-sm text-muted-foreground">
                    No marketplace skills matched this view.
                  </div>
                ) : (
                  <div className="flex max-h-[72vh] flex-col overflow-y-auto">
                    {filteredMarketplace.map((skill) => (
                      <button
                        key={skill.id}
                        type="button"
                        onClick={() => setSelectedMarketplaceId(skill.id)}
                        className={`flex items-start gap-3 border-b border-border/70 px-5 py-4 text-left transition-colors last:border-b-0 ${
                          selectedMarketplaceId === skill.id ? 'bg-accent/40' : 'hover:bg-accent/20'
                        }`}
                      >
                        <div className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                          <Sparkles />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="truncate text-sm font-medium text-foreground">{skill.name}</div>
                            {installedBySource.get(skill.id) ? <Badge variant="secondary">{installedBySource.get(skill.id)} installed</Badge> : null}
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            {skill.summary || 'No summary provided.'}
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {skill.tags.slice(0, 3).map((tag) => (
                              <Badge key={tag} variant="secondary">
                                {tag}
                              </Badge>
                            ))}
                            {skill.latestVersion?.version ? <Badge variant="outline">v{skill.latestVersion.version}</Badge> : null}
                          </div>
                        </div>
                        <ChevronRight className="mt-1 shrink-0 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="overflow-hidden">
              <CardHeader className="border-b border-border bg-muted/20">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <CardTitle>{selectedMarketplaceSkill?.name || 'Marketplace detail'}</CardTitle>
                    <CardDescription>
                      {selectedMarketplaceSkill
                        ? 'Review the latest published skill and install a workspace copy.'
                        : 'Choose a marketplace skill to inspect it.'}
                    </CardDescription>
                  </div>

                  {selectedMarketplaceSkill ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        onClick={() => {
                          setInstallDialogOpen(true);
                        }}
                      >
                        <UploadCloud data-icon="inline-start" />
                        Install copy
                      </Button>
                      {canPublishMarketplaceSkills ? (
                        <Button
                          variant="outline"
                          onClick={() => {
                            setMarketplaceEditorSkill(selectedMarketplaceSkill);
                            setMarketplaceEditorOpen(true);
                          }}
                        >
                          <Sparkles data-icon="inline-start" />
                          Publish update
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="p-6">
                {!selectedMarketplaceSkill ? (
                  <div className="rounded-[24px] border border-dashed border-border bg-muted/10 px-5 py-14 text-sm text-muted-foreground">
                    Pick a marketplace skill from the left to inspect its files and publish metadata.
                  </div>
                ) : loadingMarketplaceDetail ? (
                  <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 animate-spin" />
                    Loading marketplace skill...
                  </div>
                ) : (
                  <div className="flex flex-col gap-6">
                    <div className="grid gap-4 lg:grid-cols-[1.08fr_0.92fr]">
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base">Overview</CardTitle>
                          <CardDescription>Marketplace-facing metadata for discovery and installation.</CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-4">
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline">{selectedMarketplaceSkill.slug}</Badge>
                            {selectedMarketplaceSkill.latestVersion?.version ? (
                              <Badge variant="secondary">v{selectedMarketplaceSkill.latestVersion.version}</Badge>
                            ) : null}
                            {installedBySource.get(selectedMarketplaceSkill.id) ? (
                              <Badge variant="secondary">{installedBySource.get(selectedMarketplaceSkill.id)} installed copies</Badge>
                            ) : null}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {selectedMarketplaceSkill.summary || 'No summary provided.'}
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="rounded-2xl border border-border bg-muted/10 p-4">
                              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Publisher</div>
                              <div className="mt-2 text-sm font-medium text-foreground">
                                {selectedMarketplaceSkill.authorName || 'Platform admin'}
                              </div>
                              <div className="mt-1 text-sm text-muted-foreground">
                                Updated {formatDate(selectedMarketplaceSkill.updatedAt)}
                              </div>
                            </div>
                            <div className="rounded-2xl border border-border bg-muted/10 p-4">
                              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Entry file</div>
                              <div className="mt-2 text-sm font-medium text-foreground">
                                {selectedMarketplaceSkill.latestVersion?.entryPath || 'SKILL.md'}
                              </div>
                              <div className="mt-1 text-sm text-muted-foreground">
                                {selectedMarketplaceSkill.latestVersion?.files?.length || 0} files in latest version
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {selectedMarketplaceSkill.tags.map((tag) => (
                              <Badge key={tag} variant="secondary">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base">Install preview</CardTitle>
                          <CardDescription>See where the next copy would live and how it will be tracked.</CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-4">
                          <div className="rounded-2xl border border-border bg-muted/10 p-4">
                            <div className="flex items-center gap-3">
                              <div className="flex size-10 items-center justify-center rounded-2xl bg-background text-muted-foreground">
                                <Sparkles />
                              </div>
                              <div>
                                <div className="text-sm font-medium text-foreground">{selectedMarketplaceSkill.name}</div>
                                <div className="text-sm text-muted-foreground">
                                  Installs as a workspace copy, then stays independently editable.
                                </div>
                              </div>
                            </div>
                          </div>
                          <div className="rounded-2xl border border-border bg-muted/10 p-4 text-sm text-muted-foreground">
                            Upgrade path stays available because the installed copy preserves the marketplace source and version link.
                          </div>
                          <Button onClick={() => setInstallDialogOpen(true)}>
                            <UploadCloud data-icon="inline-start" />
                            Install copy
                          </Button>
                        </CardContent>
                      </Card>
                    </div>

                    <div className="grid gap-4 lg:grid-cols-[0.92fr_1.08fr]">
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base">File directory</CardTitle>
                          <CardDescription>Files ship as named assets. The installed copy gets the same file set on first install.</CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-2">
                          {(selectedMarketplaceSkill.latestVersion?.files || []).map((file) => (
                            <div key={file.path} className="flex items-center gap-3 rounded-2xl border border-border bg-muted/10 px-4 py-3">
                              <div className="flex size-9 items-center justify-center rounded-xl bg-background text-muted-foreground">
                                <FileText className="size-4" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-foreground">{file.path}</div>
                                <div className="text-xs text-muted-foreground">{file.contentBlocks.length} blocks</div>
                              </div>
                              {selectedMarketplaceSkill.latestVersion?.entryPath === file.path ? <Badge variant="secondary">Entry</Badge> : null}
                            </div>
                          ))}
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base">Entry preview</CardTitle>
                          <CardDescription>{marketplaceEntryFile?.path || selectedMarketplaceSkill.latestVersion?.entryPath || 'SKILL.md'}</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <CanonicalContentRenderer
                            blocks={marketplaceEntryFile?.contentBlocks || textBlocks('No entry file content found.')}
                          />
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <SkillEditorDialog
        open={marketplaceEditorOpen}
        mode="marketplace"
        workspaceId={workspaceId}
        initialSkill={marketplaceEditorSkill}
        onOpenChange={setMarketplaceEditorOpen}
        onSaved={handleMarketplaceEditorSaved}
      />

      <SkillEditorDialog
        open={installedEditorOpen}
        mode="installed"
        workspaceId={workspaceId}
        initialSkill={selectedInstalledSkill}
        onOpenChange={setInstalledEditorOpen}
        onSaved={handleInstalledEditorSaved}
      />

      <InstallSkillDialog
        open={installDialogOpen}
        skill={selectedMarketplaceSkill}
        actors={actors}
        conversations={conversations}
        members={members}
        workspaceId={workspaceId}
        onOpenChange={setInstallDialogOpen}
        onInstalled={handleInstalled}
      />
    </div>
  );
}
