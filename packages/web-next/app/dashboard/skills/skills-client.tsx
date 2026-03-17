'use client';

import {
  createCanonicalContentBlockId,
  extractText,
  textBlocks,
  type CanonicalContentBlock,
  type InstalledSkill,
  type SkillMarketplaceEntry,
  type SkillUseScope,
} from '@synapse/shared';
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ArrowUpRight,
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
import PluginAccessStep from '@/app/dashboard/plugins/plugin-access-step';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';

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
};

type EditorDraft = {
  skillId?: string;
  slug: string;
  name: string;
  descriptionBlocks: CanonicalContentBlock[];
  iconUrl: string;
  tagsText: string;
  version: string;
  changelog: string;
  attachmentFiles: SkillFileDraft[];
};

type SkillListRow = {
  id: string;
  kind: 'custom' | 'official-installed' | 'official-available';
  name: string;
  slug: string;
  descriptionText: string;
  tags: string[];
  installedSkillId?: string;
  marketplaceSkillId?: string;
  version?: string;
  updatedAt: string;
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

function createEmptySkillFile(path = 'attachments/new-note.md', text = ''): SkillFileDraft {
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

function createEmptyDescriptionBlocks(text = '') {
  return [
    {
      id: createCanonicalContentBlockId('text'),
      type: 'text' as const,
      text,
    },
  ];
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

function skillDescriptionText(description?: CanonicalContentBlock | null) {
  if (!description) return '';
  if (description.type === 'text') return description.text;
  return description.originalName || extractText([description]);
}

function ensureSingleDescriptionBlock(blocks: CanonicalContentBlock[]) {
  if (blocks.length === 0) {
    return createEmptyDescriptionBlocks()[0];
  }
  if (blocks.length > 1) {
    throw new Error('Skill description must contain exactly one canonical content block.');
  }
  return blocks[0]!;
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

function createScopeDraft(): ScopeDraft {
  return {
    useScope: 'workspace',
    actorId: null,
    conversationId: null,
    userId: null,
  };
}

function createMarketplaceDraft(skill?: SkillMarketplaceEntry | null): EditorDraft {
  const latestVersion = skill?.latestVersion;
  return {
    skillId: skill?.id,
    slug: skill?.slug || '',
    name: skill?.name || '',
    descriptionBlocks: skill?.description ? [skill.description] : createEmptyDescriptionBlocks(),
    iconUrl: skill?.iconUrl || '',
    tagsText: skill?.tags.join(', ') || '',
    version: latestVersion?.version || '1.0.0',
    changelog: latestVersion?.changelog || '',
    attachmentFiles:
      latestVersion?.attachmentFiles?.map((file) => ({
        path: file.path,
        contentBlocks: file.contentBlocks,
      })) || [createEmptySkillFile()],
  };
}

function createInstalledDraft(skill?: InstalledSkill | null): EditorDraft {
  return {
    slug: skill?.slug || '',
    name: skill?.name || '',
    descriptionBlocks: skill?.description ? [skill.description] : createEmptyDescriptionBlocks(),
    iconUrl: skill?.iconUrl || '',
    tagsText: skill?.tags.join(', ') || '',
    version: skill?.sourceVersion || '',
    changelog: '',
    attachmentFiles:
      skill?.attachmentFiles?.map((file) => ({
        path: file.path,
        contentBlocks: file.contentBlocks,
      })) || [createEmptySkillFile()],
  };
}

function createWorkspaceDraft(): EditorDraft {
  return {
    slug: '',
    name: '',
    descriptionBlocks: createEmptyDescriptionBlocks(),
    iconUrl: '',
    tagsText: '',
    version: '',
    changelog: '',
    attachmentFiles: [],
  };
}

function compareDatesDesc(left: string, right: string) {
  return new Date(right).getTime() - new Date(left).getTime();
}

function getSkillRowId(skill: Pick<InstalledSkill, 'id' | 'sourceSkillId'>) {
  return skill.sourceSkillId ? `official-installed:${skill.sourceSkillId}` : `custom:${skill.id}`;
}

function matchesSkillRowQuery(row: SkillListRow, query: string) {
  return [row.name, row.slug, row.descriptionText, row.tags.join(' ')]
    .join(' ')
    .toLowerCase()
    .includes(query);
}

function rowSourceLabel(row: SkillListRow) {
  return row.kind === 'custom' ? 'Workspace' : 'Official';
}

function rowStatusLabel(row: SkillListRow) {
  switch (row.kind) {
    case 'custom':
      return 'Custom';
    case 'official-installed':
      return 'Installed';
    case 'official-available':
      return 'Available';
    default:
      return '';
  }
}

function rowStatusVariant(row: SkillListRow): 'outline' | 'secondary' {
  return row.kind === 'official-available' ? 'outline' : 'secondary';
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
        <FieldLabel>Initial access scope</FieldLabel>
        <Select
          value={value.useScope}
            onValueChange={(nextValue: SkillUseScope) =>
              onChange({
                useScope: nextValue,
                actorId: nextValue === 'actor_global' || nextValue === 'actor_conversation' ? value.actorId : null,
                conversationId: nextValue === 'conversation' || nextValue === 'actor_conversation' ? value.conversationId : null,
                userId: nextValue === 'user' ? value.userId : null,
              })
            }
          >
          <SelectTrigger>
            <SelectValue placeholder="Choose access scope" />
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
  actors,
  conversations,
  members,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  mode: 'marketplace' | 'installed' | 'workspace';
  workspaceId: string | null;
  initialSkill: SkillMarketplaceEntry | InstalledSkill | null;
  actors: ActorOption[];
  conversations: ConversationOption[];
  members: MemberOption[];
  onOpenChange: (open: boolean) => void;
  onSaved: (skillId?: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<EditorDraft>(() =>
    mode === 'marketplace'
      ? createMarketplaceDraft(initialSkill as SkillMarketplaceEntry | null)
      : mode === 'installed'
        ? createInstalledDraft(initialSkill as InstalledSkill | null)
        : createWorkspaceDraft(),
  );
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [newFilePath, setNewFilePath] = useState('attachments/new-note.md');
  const [scopeDraft, setScopeDraft] = useState<ScopeDraft>(createScopeDraft());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const nextDraft =
      mode === 'marketplace'
        ? createMarketplaceDraft(initialSkill as SkillMarketplaceEntry | null)
        : mode === 'installed'
          ? createInstalledDraft(initialSkill as InstalledSkill | null)
          : createWorkspaceDraft();
    setDraft(nextDraft);
    setSelectedFilePath(nextDraft.attachmentFiles[0]?.path || '');
    setNewFilePath('attachments/new-note.md');
    setScopeDraft(createScopeDraft());
  }, [initialSkill, mode, open]);

  const selectedFile =
    findSkillFile(draft.attachmentFiles, selectedFilePath) ||
    draft.attachmentFiles[0] ||
    null;

  const treeEntries = useMemo(() => buildFileTreeEntries(draft.attachmentFiles), [draft.attachmentFiles]);

  const commitFile = useCallback(
    (filePath: string, updater: (file: SkillFileDraft) => SkillFileDraft) => {
      setDraft((current) => ({
        ...current,
        attachmentFiles: current.attachmentFiles.map((file) =>
          file.path === filePath ? updater(file) : file,
        ),
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
    if (draft.attachmentFiles.some((file) => file.path === nextPath)) {
      toast.error('That file already exists');
      return;
    }

    setDraft((current) => ({
      ...current,
      attachmentFiles: [...current.attachmentFiles, createEmptySkillFile(nextPath)],
    }));
    setSelectedFilePath(nextPath);
    setNewFilePath('attachments/new-note.md');
  }

  function renameSelectedFile(nextPathInput: string) {
    if (!selectedFile) return;
    const nextPath = normalizeFilePath(nextPathInput);
    if (!nextPath) {
      return;
    }
    if (nextPath !== selectedFile.path && draft.attachmentFiles.some((file) => file.path === nextPath)) {
      toast.error('That file path is already in use');
      return;
    }

    setDraft((current) => ({
      ...current,
      attachmentFiles: current.attachmentFiles.map((file) =>
        file.path === selectedFile.path ? { ...file, path: nextPath } : file,
      ),
    }));
    setSelectedFilePath(nextPath);
  }

  function removeSelectedFile() {
    if (!selectedFile) return;
    const remaining = draft.attachmentFiles.filter((file) => file.path !== selectedFile.path);
    setDraft((current) => ({
      ...current,
      attachmentFiles: remaining,
    }));
    setSelectedFilePath(remaining[0]?.path || '');
  }

  async function handleSave() {
    if (!workspaceId) return;
    let description: CanonicalContentBlock;
    try {
      description = ensureSingleDescriptionBlock(draft.descriptionBlocks);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Skill description is invalid');
      return;
    }

    const attachmentFiles = draft.attachmentFiles.map((file) => ({
      path: normalizeFilePath(file.path),
      contentBlocks: file.contentBlocks,
    }));

    if (!draft.name.trim()) {
      toast.error('Skill name is required');
      return;
    }
    if ((mode === 'marketplace' || mode === 'workspace') && !draft.slug.trim()) {
      toast.error('Skill slug is required');
      return;
    }
    if (attachmentFiles.some((file) => !file.path)) {
      toast.error('Every attachment needs a valid path');
      return;
    }

    setSaving(true);
    try {
      if (mode === 'marketplace') {
        const result = await api.publishMarketplaceSkill({
          skillId: draft.skillId,
          slug: draft.slug.trim(),
          name: draft.name.trim(),
          description,
          iconUrl: draft.iconUrl.trim() || undefined,
          tags: parseTags(draft.tagsText),
          version: draft.version.trim() || '1.0.0',
          changelog: draft.changelog.trim(),
          attachmentFiles,
        });
        toast.success(draft.skillId ? 'Marketplace skill updated' : 'Marketplace skill published');
        onOpenChange(false);
        await onSaved(result.skill.id);
        return;
      }

      if (mode === 'workspace') {
        const result = await api.createWorkspaceSkill(workspaceId, {
          slug: draft.slug.trim(),
          name: draft.name.trim(),
          description,
          iconUrl: draft.iconUrl.trim() || undefined,
          tags: parseTags(draft.tagsText),
          attachmentFiles,
          grantScope: scopeDraft.useScope,
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
        toast.success('Workspace skill created');
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
        description,
        iconUrl: draft.iconUrl.trim() || null,
        tags: parseTags(draft.tagsText),
        attachmentFiles,
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
          <DialogTitle>
            {mode === 'marketplace'
              ? 'Skill marketplace editor'
              : mode === 'installed'
                ? 'Edit skill'
                : 'New workspace skill'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'marketplace'
              ? 'Publish a platform skill with one canonical description block and path-based attachments.'
              : mode === 'installed'
                ? 'Edit the installed skill. The marketplace source stays linked so you can still upgrade later.'
                : 'Create a blank workspace skill, choose the first access grant, and add attachments when needed.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[280px_1fr]">
          <div className="border-b border-border bg-muted/20 lg:border-r lg:border-b-0">
            <div className="flex items-center justify-between gap-2 px-5 py-4">
              <div>
                <div className="text-sm font-medium text-foreground">Attachments</div>
                <div className="text-xs text-muted-foreground">
                  {draft.attachmentFiles.length} path{draft.attachmentFiles.length === 1 ? '' : 's'} in this skill
                </div>
              </div>
              <Badge variant="outline">{draft.descriptionBlocks.length} description block</Badge>
            </div>

            <div className="max-h-[42vh] overflow-y-auto px-3 pb-3 lg:max-h-[68vh]">
              {treeEntries.length === 0 ? (
                <div className="rounded-[24px] border border-dashed border-border bg-background/60 px-4 py-6 text-sm text-muted-foreground">
                  No attachments yet.
                </div>
              ) : (
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
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>

            <div className="border-t border-border px-4 py-4">
              <FieldGroup>
                <Field>
                  <FieldLabel>New attachment path</FieldLabel>
                  <Input
                    value={newFilePath}
                    onChange={(event) => setNewFilePath(event.target.value)}
                    placeholder="references/new-note.md"
                  />
                </Field>
                <Button type="button" variant="outline" onClick={addFile}>
                  <FilePlus2 data-icon="inline-start" />
                  Add attachment
                </Button>
              </FieldGroup>
            </div>
          </div>

          <div className="min-h-0 overflow-y-auto">
            <div className="flex flex-col gap-6 p-6">
              <Card>
                <CardHeader>
                  <CardTitle>Skill basics</CardTitle>
                  <CardDescription>Keep the naming and metadata readable in both the marketplace and workspace views.</CardDescription>
                </CardHeader>
                <CardContent>
                  <FieldGroup>
                    {mode === 'marketplace' || mode === 'workspace' ? (
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

              <Card>
                <CardHeader>
                  <CardTitle>Description</CardTitle>
                  <CardDescription>
                    This is the fixed skill body. It is stored as a single canonical content block.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <CanonicalContentEditor
                    workspaceId={workspaceId}
                    value={draft.descriptionBlocks}
                    onChange={(nextBlocks) => setDraft((current) => ({ ...current, descriptionBlocks: nextBlocks }))}
                    label="Skill description"
                    description="Keep exactly one block here. Use attachments for longer reference material."
                    showCount
                  />
                </CardContent>
              </Card>

              {mode === 'workspace' ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Initial access</CardTitle>
                    <CardDescription>
                      Choose the first access grant. You can manage more access rules after the skill is created.
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

                    <div className="rounded-2xl border border-border bg-muted/10 px-4 py-3 text-sm text-muted-foreground">
                      <div className="font-medium text-foreground">Initial access target</div>
                      <div className="mt-1">
                        {resolveScopeTarget(scopeDraft, actors, conversations, members)}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ) : null}

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
                      <CardTitle>Selected attachment</CardTitle>
                      <CardDescription>
                        Attachments are edited as path plus canonical content blocks. Folder hierarchy is derived from the path.
                      </CardDescription>
                    </div>
                    {selectedFile ? (
                      <div className="flex flex-wrap items-center gap-2">
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
                          <FieldLabel>Attachment path</FieldLabel>
                          <Input
                            value={selectedFile.path}
                            onChange={(event) => renameSelectedFile(event.target.value)}
                          />
                          <FieldDescription>
                            Use nested paths like `references/checklist.md` to keep the skill organized.
                          </FieldDescription>
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
                      Add an attachment on the left to start editing.
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
        grantScope: scopeDraft.useScope,
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
            Install this skill in the workspace and choose the first access grant. You can add more access rules later.
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
                    <CardDescription className="mt-1">
                      {skillDescriptionText(skill.description) || 'No description provided.'}
                    </CardDescription>
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

            <div className="rounded-2xl border border-border bg-muted/10 px-4 py-3 text-sm text-muted-foreground">
              <div className="font-medium text-foreground">Initial access target</div>
              <div className="mt-1">{resolveScopeTarget(scopeDraft, actors, conversations, members)}</div>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void handleInstall()} disabled={installing || !skill}>
            {installing ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <UploadCloud data-icon="inline-start" />}
            Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InstalledSkillConfigurationPage({ skillId }: { skillId: string }) {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const [skill, setSkill] = useState<InstalledSkill | null>(null);
  const [loading, setLoading] = useState(true);
  const [installedEditorOpen, setInstalledEditorOpen] = useState(false);
  const [installedDetailTab, setInstalledDetailTab] = useState<'content' | 'access'>('content');
  const [enabledDraft, setEnabledDraft] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [upgradingSkill, setUpgradingSkill] = useState(false);
  const [removingSkill, setRemovingSkill] = useState(false);
  const [selectedAttachmentPath, setSelectedAttachmentPath] = useState('');

  const refreshSkill = useCallback(async () => {
    if (!workspaceId || !skillId) {
      setSkill(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await api.getInstalledSkill(workspaceId, skillId);
      setSkill(response.skill);
    } catch (error) {
      setSkill(null);
      toast.error(error instanceof Error ? error.message : 'Failed to load installed skill');
    } finally {
      setLoading(false);
    }
  }, [skillId, workspaceId]);

  useEffect(() => {
    void refreshSkill();
  }, [refreshSkill]);

  useEffect(() => {
    setEnabledDraft(skill?.isEnabled ?? true);
  }, [skill]);

  useEffect(() => {
    setInstalledDetailTab('content');
  }, [skillId]);

  useEffect(() => {
    setSelectedAttachmentPath(skill?.attachmentFiles?.[0]?.path || '');
  }, [skill]);

  async function handleSettingsSave() {
    if (!workspaceId || !skill) return;
    setSavingSettings(true);
    try {
      await api.updateInstalledSkill(workspaceId, skill.id, {
        isEnabled: enabledDraft,
      });
      await refreshSkill();
      toast.success('Skill settings updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update skill settings');
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleUpgrade() {
    if (!workspaceId || !skill) return;
    setUpgradingSkill(true);
    try {
      await api.upgradeInstalledSkill(workspaceId, skill.id);
      await refreshSkill();
      toast.success('Skill upgraded to the latest marketplace version');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Upgrade failed');
    } finally {
      setUpgradingSkill(false);
    }
  }

  async function handleUninstall() {
    if (!workspaceId || !skill) return;
    setRemovingSkill(true);
    try {
      await api.uninstallInstalledSkill(workspaceId, skill.id);
      toast.success('Skill uninstalled');
      router.push('/dashboard/skills');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to uninstall skill');
    } finally {
      setRemovingSkill(false);
    }
  }

  const installedAttachments = skill?.attachmentFiles?.map((file) => ({
      path: file.path,
      contentBlocks: file.contentBlocks,
    })) || [];
  const selectedAttachment =
    findSkillFile(installedAttachments, selectedAttachmentPath) ||
    installedAttachments[0] ||
    null;
  const installedAttachmentTree = useMemo(
    () => buildFileTreeEntries(installedAttachments),
    [installedAttachments],
  );

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => router.push('/dashboard/skills')}>
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b border-border bg-muted/20">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <CardTitle>{skill?.name || 'Skill configuration'}</CardTitle>
              <CardDescription>
                {skill?.sourceSkillId
                  ? 'Configure the installed official skill, edit its description, attachments, and workspace access.'
                  : 'Configure this workspace skill, edit its description, attachments, and workspace access.'}
              </CardDescription>
            </div>

            {skill ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setInstalledEditorOpen(true);
                  }}
                >
                  <FileText data-icon="inline-start" />
                  Edit
                </Button>
                {skill.sourceSkillId ? (
                  <Button
                    variant="outline"
                    onClick={() => void handleUpgrade()}
                    disabled={!skill.upgradeAvailable || upgradingSkill}
                  >
                    {upgradingSkill ? (
                      <Loader2 className="animate-spin" data-icon="inline-start" />
                    ) : (
                      <UploadCloud data-icon="inline-start" />
                    )}
                    Upgrade
                  </Button>
                ) : null}
                <Button variant="destructive" onClick={() => void handleUninstall()} disabled={removingSkill}>
                  {removingSkill ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
                  Uninstall
                </Button>
              </div>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="p-6">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
              <Loader2 className="mr-2 animate-spin" />
              Loading skill...
            </div>
          ) : !skill ? (
            <div className="rounded-[24px] border border-dashed border-border bg-muted/10 px-5 py-14 text-sm text-muted-foreground">
              Skill not found.
            </div>
          ) : (
            <Tabs
              value={installedDetailTab}
              onValueChange={(nextValue) => setInstalledDetailTab(nextValue as 'content' | 'access')}
              className="flex flex-col gap-6"
            >
              <TabsList>
                <TabsTrigger value="content">Content</TabsTrigger>
                <TabsTrigger value="access">Access</TabsTrigger>
              </TabsList>

              <TabsContent value="content" className="mt-0 flex flex-col gap-6">
                <div className="grid gap-4 xl:grid-cols-[0.92fr_1.08fr]">
                  <div className="flex flex-col gap-4">
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">Overview</CardTitle>
                        <CardDescription>Source tracking, version state, and attachment inventory.</CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-4">
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="outline">{skill.sourceSkillId ? 'Official' : 'Workspace'}</Badge>
                          {skill.isCustomized ? <Badge variant="secondary">Customized</Badge> : null}
                          {skill.upgradeAvailable ? <Badge variant="secondary">Update available</Badge> : null}
                          <Badge variant={skill.isEnabled ? 'secondary' : 'outline'}>
                            {skill.isEnabled ? 'Enabled' : 'Disabled'}
                          </Badge>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {skillDescriptionText(skill.description) || 'No description provided.'}
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="rounded-2xl border border-border bg-muted/10 p-4">
                            <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Source</div>
                            <div className="mt-2 text-sm font-medium text-foreground">
                              {skill.sourceSkillId ? 'Official marketplace' : 'Workspace skill'}
                            </div>
                            <div className="mt-1 text-sm text-muted-foreground">
                              Current version {skill.sourceVersion || 'workspace version'}
                              {skill.latestSourceVersion ? ` · latest ${skill.latestSourceVersion}` : ''}
                            </div>
                          </div>
                          <div className="rounded-2xl border border-border bg-muted/10 p-4">
                            <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Attachments</div>
                            <div className="mt-2 text-sm font-medium text-foreground">
                              {skill.attachmentFiles?.length || 0} path{skill.attachmentFiles?.length === 1 ? '' : 's'}
                            </div>
                            <div className="mt-1 text-sm text-muted-foreground">Updated {formatDate(skill.updatedAt)}</div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">Installation state</CardTitle>
                        <CardDescription>Enable or disable runtime resolution without changing access grants.</CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-5">
                        <FieldGroup>
                          <Field>
                            <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-muted/10 px-4 py-3">
                              <div>
                                <FieldLabel>Enabled</FieldLabel>
                                <FieldDescription>Disabled skills stay installed but are hidden from runtime resolution.</FieldDescription>
                              </div>
                              <Switch checked={enabledDraft} onCheckedChange={setEnabledDraft} />
                            </div>
                          </Field>
                        </FieldGroup>

                        <Button onClick={() => void handleSettingsSave()} disabled={savingSettings}>
                          {savingSettings ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <ShieldCheck data-icon="inline-start" />}
                          Save settings
                        </Button>
                      </CardContent>
                    </Card>
                  </div>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Description</CardTitle>
                      <CardDescription>The fixed skill body used when the runtime reads this skill.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <CanonicalContentRenderer blocks={[skill.description]} />
                    </CardContent>
                  </Card>
                </div>

                <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Attachments</CardTitle>
                      <CardDescription>Paths are shown as a derived folder tree, similar to memories.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {installedAttachmentTree.length === 0 ? (
                        <div className="rounded-[24px] border border-dashed border-border bg-muted/10 px-5 py-10 text-sm text-muted-foreground">
                          No attachments in this skill.
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {installedAttachmentTree.map((entry) =>
                            entry.kind === 'folder' ? (
                              <div
                                key={`installed-folder-${entry.path}`}
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
                                onClick={() => setSelectedAttachmentPath(entry.path)}
                                className={`flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm transition-colors ${
                                  selectedAttachment?.path === entry.path
                                    ? 'bg-muted text-foreground'
                                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                                }`}
                                style={{ paddingLeft: `${entry.depth * 16 + 12}px` }}
                              >
                                <FileText className="size-4" />
                                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                              </button>
                            ),
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Attachment preview</CardTitle>
                      <CardDescription>{selectedAttachment?.path || 'Select an attachment to preview it.'}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <CanonicalContentRenderer
                        blocks={selectedAttachment?.contentBlocks || textBlocks('No attachment selected.')}
                      />
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              <TabsContent value="access" className="mt-0">
                <PluginAccessStep
                  installation={skill}
                  description="Choose who can use this skill. The workspace keeps ownership of the installed skill content."
                  addAccessLabel="Add Access"
                  emptyMessage="Install the skill first. Once it is installed, you can grant use access here."
                  dialogTitle="Add skill access"
                  dialogDescription="Choose who can use this skill. The installed skill content stays owned by the workspace."
                  noAccessMessage="No use access has been granted for this skill yet."
                />
              </TabsContent>
            </Tabs>
          )}
        </CardContent>
      </Card>

      <SkillEditorDialog
        open={installedEditorOpen}
        mode="installed"
        workspaceId={workspaceId}
        initialSkill={skill}
        actors={[]}
        conversations={[]}
        members={[]}
        onOpenChange={setInstalledEditorOpen}
        onSaved={() => refreshSkill()}
      />
    </div>
  );
}

export function MarketplaceSkillPreviewPage({ skillId }: { skillId: string }) {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const [skill, setSkill] = useState<SkillMarketplaceEntry | null>(null);
  const [actors, setActors] = useState<ActorOption[]>([]);
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [canPublishMarketplaceSkills, setCanPublishMarketplaceSkills] = useState(false);
  const [loading, setLoading] = useState(true);
  const [marketplaceEditorOpen, setMarketplaceEditorOpen] = useState(false);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [selectedAttachmentPath, setSelectedAttachmentPath] = useState('');

  const refreshSkill = useCallback(async () => {
    if (!workspaceId || !skillId) {
      setSkill(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [skillResponse, actorsResponse, groupsResponse, membersResponse, platformNavigationResponse] =
        await Promise.all([
          api.getSkillMarketplaceItem(skillId, workspaceId),
          api.getActors(workspaceId),
          api.getGroups(workspaceId),
          api.getWorkspaceMembers(workspaceId),
          api.getPlatformNavigation(),
        ]);

      const nextActors = Array.isArray(actorsResponse) ? actorsResponse.map(normalizeActorOption) : [];
      const nextConversations = Array.isArray(groupsResponse?.groups)
        ? groupsResponse.groups.map(normalizeConversationOption)
        : [];
      const nextMembers = Array.isArray(membersResponse?.data)
        ? membersResponse.data.map(normalizeMemberOption)
        : [];
      const platformNavigation = platformNavigationResponse?.data || platformNavigationResponse || {};

      setSkill(skillResponse.skill);
      setActors(nextActors);
      setConversations(nextConversations);
      setMembers(nextMembers);
      setCanPublishMarketplaceSkills(Boolean(platformNavigation.canAccessPlatformSkills));
    } catch (error) {
      setSkill(null);
      toast.error(error instanceof Error ? error.message : 'Failed to load marketplace skill');
    } finally {
      setLoading(false);
    }
  }, [skillId, workspaceId]);

  useEffect(() => {
    void refreshSkill();
  }, [refreshSkill]);

  useEffect(() => {
    setSelectedAttachmentPath(skill?.latestVersion?.attachmentFiles?.[0]?.path || '');
  }, [skill]);

  const marketplaceAttachments = skill?.latestVersion?.attachmentFiles?.map((file) => ({
      path: file.path,
      contentBlocks: file.contentBlocks,
    })) || [];
  const selectedAttachment =
    findSkillFile(marketplaceAttachments, selectedAttachmentPath) ||
    marketplaceAttachments[0] ||
    null;
  const marketplaceAttachmentTree = useMemo(
    () => buildFileTreeEntries(marketplaceAttachments),
    [marketplaceAttachments],
  );

  async function handleInstalled(installedSkillId: string) {
    router.push(`/dashboard/skills/installed/${installedSkillId}`);
  }

  async function handleMarketplaceEditorSaved(savedSkillId?: string) {
    const nextSkillId = savedSkillId || skillId;
    if (nextSkillId !== skillId) {
      router.replace(`/dashboard/skills/marketplace/${nextSkillId}`);
      return;
    }
    await refreshSkill();
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => router.push('/dashboard/skills')}>
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b border-border bg-muted/20">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <CardTitle>{skill?.name || 'Skill preview'}</CardTitle>
              <CardDescription>
                {skill
                  ? 'Preview this official skill before installing it in the workspace.'
                  : 'Select a skill from the list to preview it.'}
              </CardDescription>
            </div>

            {skill ? (
              <div className="flex flex-wrap gap-2">
                {skill.workspaceInstallation?.installed && skill.workspaceInstallation.installedSkillId ? (
                  <Button onClick={() => router.push(`/dashboard/skills/installed/${skill.workspaceInstallation?.installedSkillId}`)}>
                    <FileText data-icon="inline-start" />
                    Open installed skill
                  </Button>
                ) : (
                  <Button onClick={() => setInstallDialogOpen(true)}>
                    <UploadCloud data-icon="inline-start" />
                    Install
                  </Button>
                )}
                {canPublishMarketplaceSkills ? (
                  <Button
                    variant="outline"
                    onClick={() => {
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
          {loading ? (
            <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
              <Loader2 className="mr-2 animate-spin" />
              Loading skill preview...
            </div>
          ) : !skill ? (
            <div className="rounded-[24px] border border-dashed border-border bg-muted/10 px-5 py-14 text-sm text-muted-foreground">
              Skill not found.
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              <div className="grid gap-4 xl:grid-cols-[0.92fr_1.08fr]">
                <div className="flex flex-col gap-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Overview</CardTitle>
                      <CardDescription>Marketplace metadata for discovery and installation.</CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline">Official</Badge>
                        <Badge variant="outline">{skill.slug}</Badge>
                        {skill.latestVersion?.version ? <Badge variant="secondary">v{skill.latestVersion.version}</Badge> : null}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {skillDescriptionText(skill.description) || 'No description provided.'}
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-2xl border border-border bg-muted/10 p-4">
                          <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Publisher</div>
                          <div className="mt-2 text-sm font-medium text-foreground">
                            {skill.authorName || 'Platform admin'}
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">Updated {formatDate(skill.updatedAt)}</div>
                        </div>
                        <div className="rounded-2xl border border-border bg-muted/10 p-4">
                          <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Attachments</div>
                          <div className="mt-2 text-sm font-medium text-foreground">
                            {skill.latestVersion?.attachmentFiles?.length || 0} path
                            {skill.latestVersion?.attachmentFiles?.length === 1 ? '' : 's'}
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            {skill.latestVersion?.version ? `Version ${skill.latestVersion.version}` : 'Latest release'}
                          </div>
                        </div>
                      </div>
                      <div className="rounded-2xl border border-border bg-muted/10 p-4 text-sm text-muted-foreground">
                        Install this skill to create a workspace-managed version with its own description, attachments, and access rules.
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Attachments</CardTitle>
                      <CardDescription>Attachments included in the latest published version.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {marketplaceAttachmentTree.length === 0 ? (
                        <div className="rounded-[24px] border border-dashed border-border bg-muted/10 px-5 py-10 text-sm text-muted-foreground">
                          No attachments in this release.
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {marketplaceAttachmentTree.map((entry) =>
                            entry.kind === 'folder' ? (
                              <div
                                key={`market-folder-${entry.path}`}
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
                                onClick={() => setSelectedAttachmentPath(entry.path)}
                                className={`flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm transition-colors ${
                                  selectedAttachment?.path === entry.path
                                    ? 'bg-muted text-foreground'
                                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                                }`}
                                style={{ paddingLeft: `${entry.depth * 16 + 12}px` }}
                              >
                                <FileText className="size-4" />
                                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                              </button>
                            ),
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Description</CardTitle>
                    <CardDescription>The fixed skill body published in the latest release.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <CanonicalContentRenderer blocks={[skill.description]} />
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Attachment preview</CardTitle>
                  <CardDescription>{selectedAttachment?.path || 'Select an attachment to preview it.'}</CardDescription>
                </CardHeader>
                <CardContent>
                  <CanonicalContentRenderer
                    blocks={selectedAttachment?.contentBlocks || textBlocks('No attachment selected.')}
                  />
                </CardContent>
              </Card>
            </div>
          )}
        </CardContent>
      </Card>

      <SkillEditorDialog
        open={marketplaceEditorOpen}
        mode="marketplace"
        workspaceId={workspaceId}
        initialSkill={skill}
        actors={actors}
        conversations={conversations}
        members={members}
        onOpenChange={setMarketplaceEditorOpen}
        onSaved={handleMarketplaceEditorSaved}
      />

      <InstallSkillDialog
        open={installDialogOpen && !skill?.workspaceInstallation?.installed}
        skill={skill}
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

export default function SkillsPage() {
  const router = useRouter();
  const { workspaceId, workspaceName } = useWorkspace();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [marketplace, setMarketplace] = useState<SkillMarketplaceEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [actors, setActors] = useState<ActorOption[]>([]);
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [canPublishMarketplaceSkills, setCanPublishMarketplaceSkills] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const [marketplaceEditorOpen, setMarketplaceEditorOpen] = useState(false);
  const [workspaceEditorOpen, setWorkspaceEditorOpen] = useState(false);

  const skillRows = useMemo(() => {
    const marketplaceIds = new Set(marketplace.map((skill) => skill.id));

    const customRows: SkillListRow[] = [...installed]
      .filter((skill) => !skill.sourceSkillId)
      .sort((left, right) => compareDatesDesc(left.updatedAt, right.updatedAt))
      .map((skill) => ({
        id: getSkillRowId(skill),
        kind: 'custom',
        name: skill.name,
        slug: skill.slug,
        descriptionText: skillDescriptionText(skill.description),
        tags: skill.tags,
        installedSkillId: skill.id,
        version: skill.sourceVersion,
        updatedAt: skill.updatedAt,
      }));

    const officialInstalledRows: SkillListRow[] = [...marketplace]
      .filter((skill) => skill.workspaceInstallation?.installed && skill.workspaceInstallation.installedSkillId)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({
        id: `official-installed:${skill.id}`,
        kind: 'official-installed',
        name: skill.name,
        slug: skill.slug,
        descriptionText: skillDescriptionText(skill.description),
        tags: skill.tags,
        installedSkillId: skill.workspaceInstallation?.installedSkillId,
        marketplaceSkillId: skill.id,
        version: skill.latestVersion?.version,
        updatedAt: skill.updatedAt,
      }));

    const orphanOfficialRows: SkillListRow[] = [...installed]
      .filter((skill) => skill.sourceSkillId && !marketplaceIds.has(skill.sourceSkillId))
      .sort((left, right) => compareDatesDesc(left.updatedAt, right.updatedAt))
      .map((skill) => ({
        id: `official-installed:${skill.sourceSkillId}`,
        kind: 'official-installed',
        name: skill.name,
        slug: skill.slug,
        descriptionText: skillDescriptionText(skill.description),
        tags: skill.tags,
        installedSkillId: skill.id,
        marketplaceSkillId: skill.sourceSkillId,
        version: skill.sourceVersion,
        updatedAt: skill.updatedAt,
      }));

    const officialAvailableRows: SkillListRow[] = [...marketplace]
      .filter((skill) => !skill.workspaceInstallation?.installed)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({
        id: `official-available:${skill.id}`,
        kind: 'official-available',
        name: skill.name,
        slug: skill.slug,
        descriptionText: skillDescriptionText(skill.description),
        tags: skill.tags,
        marketplaceSkillId: skill.id,
        version: skill.latestVersion?.version,
        updatedAt: skill.updatedAt,
      }));

    const rows = [...customRows, ...officialInstalledRows, ...orphanOfficialRows, ...officialAvailableRows];
    const query = deferredSearch.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) => matchesSkillRowQuery(row, query));
  }, [deferredSearch, installed, marketplace]);

  const refreshIndex = useCallback(async () => {
    if (!workspaceId) return;
    setLoadingPage(true);
    try {
      const [marketplaceResponse, installedResponse, actorsResponse, groupsResponse, membersResponse, platformNavigationResponse] = await Promise.all([
        api.getSkillMarketplace({ workspaceId }),
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load skills');
    } finally {
      setLoadingPage(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refreshIndex();
  }, [refreshIndex]);

  function openSkillRow(row: SkillListRow) {
    if (row.installedSkillId) {
      router.push(`/dashboard/skills/installed/${row.installedSkillId}`);
      return;
    }
    if (row.marketplaceSkillId) {
      router.push(`/dashboard/skills/marketplace/${row.marketplaceSkillId}`);
    }
  }

  async function handleMarketplaceEditorSaved(skillId?: string) {
    await refreshIndex();
    if (skillId) {
      router.push(`/dashboard/skills/marketplace/${skillId}`);
    }
  }

  async function handleWorkspaceSkillSaved(skillId?: string) {
    await refreshIndex();
    if (skillId) {
      router.push(`/dashboard/skills/installed/${skillId}`);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="max-w-3xl">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Skills</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Browse workspace skills and official skills in one list.
            {workspaceName ? ` Current workspace: ${workspaceName}.` : ''}
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:min-w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search skills"
              className="pl-10"
            />
          </div>

          <Button onClick={() => setWorkspaceEditorOpen(true)}>
            <Plus data-icon="inline-start" />
            New skill
          </Button>
          {canPublishMarketplaceSkills ? (
            <Button onClick={() => setMarketplaceEditorOpen(true)}>
              <Sparkles data-icon="inline-start" />
              Publish skill
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => void refreshIndex()} disabled={loadingPage}>
            {loadingPage ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <ArrowUpRight data-icon="inline-start" />}
            Refresh
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-[28px] border border-border bg-card">
        <div>
          {loadingPage ? (
            <div className="flex items-center justify-center px-6 py-12 text-sm text-muted-foreground">
              <Loader2 className="mr-2 animate-spin" />
              Loading skills...
            </div>
          ) : skillRows.length === 0 ? (
            <div className="px-6 py-12 text-sm text-muted-foreground">No skills matched this view.</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[56%]">Skill</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {skillRows.map((row) => (
                    <TableRow key={row.id} className="cursor-pointer" onClick={() => openSkillRow(row)}>
                      <TableCell className="align-top">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                            {row.kind === 'custom' ? <ScrollText /> : <Sparkles />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="truncate font-medium text-foreground">{row.name}</div>
                              {row.version ? <Badge variant="outline">v{row.version}</Badge> : null}
                            </div>
                            <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                              {row.descriptionText || 'No description provided.'}
                            </div>
                            <div className="mt-2 text-xs text-muted-foreground">{row.slug}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{rowSourceLabel(row)}</TableCell>
                      <TableCell>
                        <Badge variant={rowStatusVariant(row)}>{rowStatusLabel(row)}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(row.updatedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>

      <SkillEditorDialog
        open={marketplaceEditorOpen}
        mode="marketplace"
        workspaceId={workspaceId}
        initialSkill={null}
        actors={actors}
        conversations={conversations}
        members={members}
        onOpenChange={setMarketplaceEditorOpen}
        onSaved={handleMarketplaceEditorSaved}
      />

      <SkillEditorDialog
        open={workspaceEditorOpen}
        mode="workspace"
        workspaceId={workspaceId}
        initialSkill={null}
        actors={actors}
        conversations={conversations}
        members={members}
        onOpenChange={setWorkspaceEditorOpen}
        onSaved={handleWorkspaceSkillSaved}
      />
    </div>
  );
}
