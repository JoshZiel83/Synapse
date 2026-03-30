"use client"

import {
  createCanonicalContentBlockId,
  extractText,
  textBlocks,
  type CanonicalContentBlock,
  type InstalledSkill,
  type SkillMarketplaceEntry,
  type SkillUseScope,
} from "@synapse/shared"
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useRouter } from "next/navigation"
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
} from "lucide-react"
import { toast } from "sonner"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import PluginAccessStep from "@/app/dashboard/plugins/plugin-access-step"
import { CanonicalContentEditor } from "@/components/canonical-content-editor"
import { CanonicalContentRenderer } from "@/components/canonical-content-renderer"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { api } from "@/lib/api"
import { resolveFileUrl } from "@/lib/utils"

type ActorOption = {
  id: string
  name: string
  title?: string
}

type ConversationOption = {
  id: string
  title: string
}

type MemberOption = {
  id: string
  name: string
}

type SkillFileDraft = {
  path: string
  contentBlocks: CanonicalContentBlock[]
}

type ScopeDraft = {
  useScope: SkillUseScope
  actorId: string | null
  conversationId: string | null
  userId: string | null
}

type UploadedFile = {
  id: string
  url?: string
  fullUrl?: string
}

const skillAccessAdapter = {
  loadAccess: (workspaceId: string, resourceId: string) =>
    api.getInstalledSkillAccess(workspaceId, resourceId),
  grantAccess: (
    workspaceId: string,
    resourceId: string,
    payload: {
      grantScope?: SkillUseScope
      actorId?: string
      conversationId?: string
      userId?: string
      permissions?: string[]
    }
  ) => api.grantInstalledSkillAccess(workspaceId, resourceId, payload),
  revokeAccess: (workspaceId: string, resourceId: string, grantId: string) =>
    api.revokeInstalledSkillAccess(workspaceId, resourceId, grantId),
}

type EditorDraft = {
  skillId?: string
  slug: string
  name: string
  descriptionBlocks: CanonicalContentBlock[]
  iconFileId?: string | null
  iconPreviewUrl?: string
  tagsText: string
  version: string
  changelog: string
  attachmentFiles: SkillFileDraft[]
}

type SkillListRow = {
  id: string
  kind: "custom" | "official-installed" | "official-available"
  name: string
  slug: string
  descriptionText: string
  tags: string[]
  installedSkillId?: string
  marketplaceSkillId?: string
  version?: string
  updatedAt: string
}

type FileTreeEntry =
  | { kind: "folder"; path: string; label: string; depth: number }
  | { kind: "file"; path: string; label: string; depth: number }

const scopeOptions: Array<{
  value: SkillUseScope
  label: string
  description: string
}> = [
  {
    value: "workspace",
    label: "Entire workspace",
    description:
      "Every conversation and actor in this workspace can use the skill.",
  },
  {
    value: "conversation",
    label: "One conversation",
    description: "Only one conversation can see and use this skill.",
  },
  {
    value: "actor_global",
    label: "One actor",
    description: "One actor can use this skill across its conversations.",
  },
  {
    value: "actor_conversation",
    label: "Actor in conversation",
    description: "One actor can use this skill inside one conversation.",
  },
  {
    value: "user",
    label: "One user",
    description: "Only one user can use this skill personally.",
  },
]

function createEmptySkillFile(
  path = "attachments/new-note.md",
  text = ""
): SkillFileDraft {
  return {
    path,
    contentBlocks: [
      {
        id: createCanonicalContentBlockId("text"),
        type: "text",
        text,
      },
    ],
  }
}

const REQUIRED_SKILL_PATH = "Skill.md"

function ensureRequiredSkillPath(files: SkillFileDraft[]) {
  const hasRequired = files.some(
    (file) => normalizeFilePath(file.path) === REQUIRED_SKILL_PATH
  )
  if (hasRequired) {
    return files
  }
  return [createEmptySkillFile(REQUIRED_SKILL_PATH), ...files]
}

function isRequiredSkillPath(path: string) {
  return normalizeFilePath(path) === REQUIRED_SKILL_PATH
}

function createEmptyDescriptionBlocks(text = "") {
  return [
    {
      id: createCanonicalContentBlockId("text"),
      type: "text" as const,
      text,
    },
  ]
}

function normalizeFilePath(input: string) {
  return input.replace(/\\/g, "/").trim().replace(/^\/+/, "")
}

function parseTags(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function skillDescriptionText(description?: CanonicalContentBlock | null) {
  if (!description) return ""
  if (description.type === "text") return description.text
  if (description.type === "mention") {
    return `@${description.mention.name || "Unknown"}`
  }
  return description.originalName || extractText([description])
}

function ensureSingleDescriptionBlock(blocks: CanonicalContentBlock[]) {
  if (blocks.length === 0) {
    return createEmptyDescriptionBlocks()[0]
  }
  if (blocks.length > 1) {
    throw new Error(
      "Skill description must contain exactly one canonical content block."
    )
  }
  return blocks[0]!
}

function formatDate(value?: string) {
  if (!value) return "Unknown"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Unknown"
  return date.toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

function skillVersionText(skill?: InstalledSkill | null) {
  if (!skill) return ""
  if (!skill.sourceVersion) {
    return "Workspace skill"
  }
  if (
    skill.latestSourceVersion &&
    skill.latestSourceVersion !== skill.sourceVersion
  ) {
    return `Version ${skill.sourceVersion} · latest ${skill.latestSourceVersion}`
  }
  return `Version ${skill.sourceVersion}`
}

function skillFileName(path?: string) {
  if (!path) return "Preview"
  const segments = path.split("/").filter(Boolean)
  return segments[segments.length - 1] || path
}

function objectValue(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}

function normalizeActorOption(actor: unknown): ActorOption {
  const actorRecord = objectValue(actor)
  const definition = objectValue(actorRecord.definition ?? actorRecord)
  return {
    id: typeof actorRecord.id === "string" ? actorRecord.id : "",
    name:
      typeof definition.name === "string"
        ? definition.name
        : typeof definition.title === "string"
          ? definition.title
          : "Untitled actor",
    title: typeof definition.title === "string" ? definition.title : "",
  }
}

function normalizeConversationOption(group: unknown): ConversationOption {
  const groupRecord = objectValue(group)
  return {
    id: typeof groupRecord.id === "string" ? groupRecord.id : "",
    title:
      typeof groupRecord.title === "string"
        ? groupRecord.title
        : "Untitled conversation",
  }
}

function normalizeMemberOption(member: unknown): MemberOption {
  const memberRecord = objectValue(member)
  return {
    id: typeof memberRecord.userId === "string" ? memberRecord.userId : "",
    name:
      typeof memberRecord.userName === "string"
        ? memberRecord.userName
        : typeof memberRecord.userEmail === "string"
          ? memberRecord.userEmail
          : typeof memberRecord.userId === "string"
            ? memberRecord.userId
            : "Unknown user",
  }
}

function findSkillFile(files: SkillFileDraft[] | undefined, path: string) {
  return files?.find((file) => file.path === path) || null
}

function buildFileTreeEntries(files: SkillFileDraft[]): FileTreeEntry[] {
  const entries: FileTreeEntry[] = []
  const seenFolders = new Set<string>()

  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    const segments = file.path.split("/").filter(Boolean)
    const fileName = segments[segments.length - 1] || file.path

    for (let index = 0; index < segments.length - 1; index += 1) {
      const folderPath = segments.slice(0, index + 1).join("/")
      if (seenFolders.has(folderPath)) continue
      seenFolders.add(folderPath)
      entries.push({
        kind: "folder",
        path: folderPath,
        label: segments[index]!,
        depth: index,
      })
    }

    entries.push({
      kind: "file",
      path: file.path,
      label: fileName,
      depth: Math.max(segments.length - 1, 0),
    })
  }

  return entries
}

function scopeDescription(scope: SkillUseScope) {
  return (
    scopeOptions.find((option) => option.value === scope)?.description || ""
  )
}

function resolveScopeTarget(
  draft: Pick<ScopeDraft, "useScope" | "actorId" | "conversationId" | "userId">,
  actors: ActorOption[],
  conversations: ConversationOption[],
  members: MemberOption[]
) {
  switch (draft.useScope) {
    case "workspace":
      return "Entire workspace"
    case "conversation":
      return (
        conversations.find((item) => item.id === draft.conversationId)?.title ||
        "Choose one conversation"
      )
    case "actor_global":
      return (
        actors.find((item) => item.id === draft.actorId)?.name ||
        "Choose one actor"
      )
    case "actor_conversation": {
      const actorName =
        actors.find((item) => item.id === draft.actorId)?.name || "Choose actor"
      const conversationName =
        conversations.find((item) => item.id === draft.conversationId)?.title ||
        "choose conversation"
      return `${actorName} in ${conversationName}`
    }
    case "user":
      return (
        members.find((item) => item.id === draft.userId)?.name ||
        "Choose one user"
      )
    default:
      return "Not configured"
  }
}

function createScopeDraft(): ScopeDraft {
  return {
    useScope: "workspace",
    actorId: null,
    conversationId: null,
    userId: null,
  }
}

async function uploadSkillIcon(workspaceId: string | null, file: File) {
  if (!workspaceId) {
    throw new Error("Workspace is required to upload a skill icon")
  }

  const uploaded = (await api.uploadFile(workspaceId, file)) as UploadedFile
  return {
    iconFileId: uploaded.id,
    iconPreviewUrl: resolveFileUrl(uploaded.url || uploaded.fullUrl),
  }
}

function SkillIconField({
  previewUrl,
  uploading,
  onUpload,
  onClear,
}: {
  previewUrl?: string
  uploading: boolean
  onUpload: (file: File) => Promise<void>
  onClear: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const resolvedPreviewUrl = resolveFileUrl(previewUrl)

  return (
    <Field>
      <FieldLabel>Icon</FieldLabel>
      <div className="rounded-2xl border border-border bg-muted/10 p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border bg-background">
            {resolvedPreviewUrl ? (
              <img
                src={resolvedPreviewUrl}
                alt="Skill icon preview"
                className="h-full w-full object-cover"
              />
            ) : (
              <Sparkles className="size-6 text-muted-foreground" />
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) {
                  void onUpload(file)
                }
                event.target.value = ""
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <UploadCloud data-icon="inline-start" />
              )}
              Upload icon
            </Button>
            {previewUrl ? (
              <Button
                type="button"
                variant="outline"
                onClick={onClear}
                disabled={uploading}
              >
                <Trash2 data-icon="inline-start" />
                Remove icon
              </Button>
            ) : null}
          </div>
        </div>

        <FieldDescription className="mt-3">
          Upload an image file. The editor stores its internal file id; the URL
          is derived by the API.
        </FieldDescription>
      </div>
    </Field>
  )
}

function createMarketplaceDraft(
  skill?: SkillMarketplaceEntry | null
): EditorDraft {
  const latestVersion = skill?.latestVersion
  return {
    skillId: skill?.id,
    slug: skill?.slug || "",
    name: skill?.name || "",
    descriptionBlocks: skill?.description
      ? [skill.description]
      : createEmptyDescriptionBlocks(),
    iconFileId: undefined,
    iconPreviewUrl: skill?.iconUrl || undefined,
    tagsText: skill?.tags.join(", ") || "",
    version: latestVersion?.version || "1.0.0",
    changelog: latestVersion?.changelog || "",
    attachmentFiles: latestVersion?.attachmentFiles?.map((file) => ({
      path: file.path,
      contentBlocks: file.contentBlocks,
    })) || [createEmptySkillFile()],
  }
}

function createInstalledDraft(skill?: InstalledSkill | null): EditorDraft {
  const attachmentFiles = ensureRequiredSkillPath(
    skill?.attachmentFiles?.map((file) => ({
      path: file.path,
      contentBlocks: file.contentBlocks,
    })) || []
  )

  return {
    slug: skill?.slug || "",
    name: skill?.name || "",
    descriptionBlocks: skill?.description
      ? [skill.description]
      : createEmptyDescriptionBlocks(),
    iconFileId: undefined,
    iconPreviewUrl: skill?.iconUrl || undefined,
    tagsText: skill?.tags.join(", ") || "",
    version: skill?.sourceVersion || "",
    changelog: "",
    attachmentFiles,
  }
}

function createWorkspaceDraft(): EditorDraft {
  return {
    slug: "",
    name: "",
    descriptionBlocks: createEmptyDescriptionBlocks(),
    iconFileId: undefined,
    iconPreviewUrl: undefined,
    tagsText: "",
    version: "",
    changelog: "",
    attachmentFiles: [createEmptySkillFile(REQUIRED_SKILL_PATH)],
  }
}

function compareDatesDesc(left: string, right: string) {
  return new Date(right).getTime() - new Date(left).getTime()
}

function getSkillRowId(skill: Pick<InstalledSkill, "id" | "sourceSkillId">) {
  return skill.sourceSkillId
    ? `official-installed:${skill.sourceSkillId}`
    : `custom:${skill.id}`
}

function matchesSkillRowQuery(row: SkillListRow, query: string) {
  return [row.name, row.slug, row.descriptionText, row.tags.join(" ")]
    .join(" ")
    .toLowerCase()
    .includes(query)
}

function rowSourceLabel(row: SkillListRow) {
  return row.kind === "custom" ? "Workspace" : "Official"
}

function rowStatusLabel(row: SkillListRow) {
  switch (row.kind) {
    case "custom":
      return "Custom"
    case "official-installed":
      return "Installed"
    case "official-available":
      return "Available"
    default:
      return ""
  }
}

function rowStatusVariant(row: SkillListRow): "outline" | "secondary" {
  return row.kind === "official-available" ? "outline" : "secondary"
}

function rowStatusBadgeClassName(row: SkillListRow) {
  if (row.kind !== "official-installed") {
    return undefined
  }

  return "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900/70 dark:bg-emerald-950/60 dark:text-emerald-200"
}

function ScopeFields({
  value,
  onChange,
  actors,
  conversations,
  members,
}: {
  value: ScopeDraft
  onChange: (next: ScopeDraft) => void
  actors: ActorOption[]
  conversations: ConversationOption[]
  members: MemberOption[]
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
              actorId:
                nextValue === "actor_global" ||
                nextValue === "actor_conversation"
                  ? value.actorId
                  : null,
              conversationId:
                nextValue === "conversation" ||
                nextValue === "actor_conversation"
                  ? value.conversationId
                  : null,
              userId: nextValue === "user" ? value.userId : null,
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

      {value.useScope === "conversation" ||
      value.useScope === "actor_conversation" ? (
        <Field>
          <FieldLabel>Conversation</FieldLabel>
          <Select
            value={value.conversationId || undefined}
            onValueChange={(nextValue) =>
              onChange({ ...value, conversationId: nextValue })
            }
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

      {value.useScope === "actor_global" ||
      value.useScope === "actor_conversation" ? (
        <Field>
          <FieldLabel>Actor</FieldLabel>
          <Select
            value={value.actorId || undefined}
            onValueChange={(nextValue) =>
              onChange({ ...value, actorId: nextValue })
            }
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

      {value.useScope === "user" ? (
        <Field>
          <FieldLabel>User</FieldLabel>
          <Select
            value={value.userId || undefined}
            onValueChange={(nextValue) =>
              onChange({ ...value, userId: nextValue })
            }
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
  )
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
  open: boolean
  mode: "marketplace" | "installed" | "workspace"
  workspaceId: string | null
  initialSkill: SkillMarketplaceEntry | InstalledSkill | null
  actors: ActorOption[]
  conversations: ConversationOption[]
  members: MemberOption[]
  onOpenChange: (open: boolean) => void
  onSaved: (skillId?: string) => Promise<void> | void
}) {
  const [draft, setDraft] = useState<EditorDraft>(() =>
    mode === "marketplace"
      ? createMarketplaceDraft(initialSkill as SkillMarketplaceEntry | null)
      : mode === "installed"
        ? createInstalledDraft(initialSkill as InstalledSkill | null)
        : createWorkspaceDraft()
  )
  const [selectedFilePath, setSelectedFilePath] = useState("")
  const [newFilePath, setNewFilePath] = useState("attachments/new-note.md")
  const [scopeDraft, setScopeDraft] = useState<ScopeDraft>(createScopeDraft())
  const [saving, setSaving] = useState(false)
  const [iconUploading, setIconUploading] = useState(false)

  useEffect(() => {
    const nextDraft =
      mode === "marketplace"
        ? createMarketplaceDraft(initialSkill as SkillMarketplaceEntry | null)
        : mode === "installed"
          ? createInstalledDraft(initialSkill as InstalledSkill | null)
          : createWorkspaceDraft()
    setDraft(nextDraft)
    setSelectedFilePath(nextDraft.attachmentFiles[0]?.path || "")
    setNewFilePath("attachments/new-note.md")
    setScopeDraft(createScopeDraft())
  }, [initialSkill, mode, open])

  const selectedFile =
    findSkillFile(draft.attachmentFiles, selectedFilePath) ||
    draft.attachmentFiles[0] ||
    null

  const treeEntries = useMemo(
    () => buildFileTreeEntries(draft.attachmentFiles),
    [draft.attachmentFiles]
  )

  const commitFile = useCallback(
    (filePath: string, updater: (file: SkillFileDraft) => SkillFileDraft) => {
      setDraft((current) => ({
        ...current,
        attachmentFiles: current.attachmentFiles.map((file) =>
          file.path === filePath ? updater(file) : file
        ),
      }))
    },
    []
  )

  async function handleIconUpload(file: File) {
    setIconUploading(true)
    try {
      const nextIcon = await uploadSkillIcon(workspaceId, file)
      setDraft((current) => ({
        ...current,
        ...nextIcon,
      }))
      toast.success("Skill icon uploaded")
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Skill icon upload failed"
      )
    } finally {
      setIconUploading(false)
    }
  }

  function clearIcon() {
    setDraft((current) => ({
      ...current,
      iconFileId: null,
      iconPreviewUrl: undefined,
    }))
  }

  function addFile() {
    const nextPath = normalizeFilePath(newFilePath)
    if (!nextPath) {
      toast.error("Enter a file path first")
      return
    }
    if (draft.attachmentFiles.some((file) => file.path === nextPath)) {
      toast.error("That file already exists")
      return
    }

    setDraft((current) => ({
      ...current,
      attachmentFiles: [
        ...current.attachmentFiles,
        createEmptySkillFile(nextPath),
      ],
    }))
    setSelectedFilePath(nextPath)
    setNewFilePath("attachments/new-note.md")
  }

  function renameSelectedFile(nextPathInput: string) {
    if (!selectedFile) return
    const nextPath = normalizeFilePath(nextPathInput)
    if (!nextPath) {
      return
    }
    if (
      nextPath !== selectedFile.path &&
      draft.attachmentFiles.some((file) => file.path === nextPath)
    ) {
      toast.error("That file path is already in use")
      return
    }

    setDraft((current) => ({
      ...current,
      attachmentFiles: current.attachmentFiles.map((file) =>
        file.path === selectedFile.path ? { ...file, path: nextPath } : file
      ),
    }))
    setSelectedFilePath(nextPath)
  }

  function removeSelectedFile() {
    if (!selectedFile) return
    const remaining = draft.attachmentFiles.filter(
      (file) => file.path !== selectedFile.path
    )
    setDraft((current) => ({
      ...current,
      attachmentFiles: remaining,
    }))
    setSelectedFilePath(remaining[0]?.path || "")
  }

  async function handleSave() {
    if (!workspaceId) return
    let description: CanonicalContentBlock
    try {
      description = ensureSingleDescriptionBlock(draft.descriptionBlocks)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Skill description is invalid"
      )
      return
    }

    const attachmentFiles = draft.attachmentFiles.map((file) => ({
      path: normalizeFilePath(file.path),
      contentBlocks: file.contentBlocks,
    }))

    if (!draft.name.trim()) {
      toast.error("Skill name is required")
      return
    }
    if (mode === "marketplace" && !draft.slug.trim()) {
      toast.error("Skill slug is required")
      return
    }
    if (attachmentFiles.some((file) => !file.path)) {
      toast.error("Every attachment needs a valid path")
      return
    }

    setSaving(true)
    try {
      if (mode === "marketplace") {
        const result = await api.publishMarketplaceSkill({
          skillId: draft.skillId,
          slug: draft.slug.trim(),
          name: draft.name.trim(),
          description,
          iconFileId: draft.iconFileId,
          tags: parseTags(draft.tagsText),
          version: draft.version.trim() || "1.0.0",
          changelog: draft.changelog.trim(),
          attachmentFiles,
        })
        toast.success(
          draft.skillId
            ? "Marketplace skill updated"
            : "Marketplace skill published"
        )
        onOpenChange(false)
        await onSaved(result.skill.id)
        return
      }

      if (mode === "workspace") {
        const result = await api.createWorkspaceSkill(workspaceId, {
          name: draft.name.trim(),
          description,
          iconFileId: draft.iconFileId || undefined,
          tags: parseTags(draft.tagsText),
          attachmentFiles,
          grantScope: scopeDraft.useScope,
          actorId:
            scopeDraft.useScope === "actor_global" ||
            scopeDraft.useScope === "actor_conversation"
              ? scopeDraft.actorId || undefined
              : undefined,
          conversationId:
            scopeDraft.useScope === "conversation" ||
            scopeDraft.useScope === "actor_conversation"
              ? scopeDraft.conversationId || undefined
              : undefined,
          userId:
            scopeDraft.useScope === "user"
              ? scopeDraft.userId || undefined
              : undefined,
        })
        toast.success("Workspace skill created")
        onOpenChange(false)
        await onSaved(result.skill.id)
        return
      }

      const installedSkill = initialSkill as InstalledSkill | null
      if (!installedSkill?.id) {
        toast.error("Missing installed skill context")
        return
      }
      await api.updateInstalledSkill(workspaceId, installedSkill.id, {
        name: draft.name.trim(),
        description,
        iconFileId: draft.iconFileId,
        tags: parseTags(draft.tagsText),
        attachmentFiles,
      })
      toast.success("Installed skill updated")
      onOpenChange(false)
      await onSaved(installedSkill.id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-hidden p-0 sm:max-w-[min(96vw,1320px)]">
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle>
            {mode === "marketplace"
              ? "Skill marketplace editor"
              : mode === "installed"
                ? "Edit skill"
                : "New workspace skill"}
          </DialogTitle>
          <DialogDescription>
            {mode === "marketplace"
              ? "Publish a platform skill with one canonical description block and path-based attachments."
              : mode === "installed"
                ? "Edit the installed skill. The marketplace source stays linked so you can still upgrade later."
                : "Create a blank workspace skill, choose the first access grant, and add attachments when needed."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[280px_1fr]">
          <div className="border-b border-border bg-muted/20 lg:border-r lg:border-b-0">
            <div className="flex items-center justify-between gap-2 px-5 py-4">
              <div>
                <div className="text-sm font-medium text-foreground">
                  Attachments
                </div>
                <div className="text-xs text-muted-foreground">
                  {draft.attachmentFiles.length} path
                  {draft.attachmentFiles.length === 1 ? "" : "s"} in this skill
                </div>
              </div>
              <Badge variant="outline">
                {draft.descriptionBlocks.length} description block
              </Badge>
            </div>

            <div className="max-h-[42vh] overflow-y-auto px-3 pb-3 lg:max-h-[68vh]">
              {treeEntries.length === 0 ? (
                <div className="rounded-[24px] border border-dashed border-border bg-background/60 px-4 py-6 text-sm text-muted-foreground">
                  No attachments yet.
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {treeEntries.map((entry) =>
                    entry.kind === "folder" ? (
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
                            ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                            : "text-muted-foreground hover:bg-background/70 hover:text-foreground"
                        }`}
                        style={{ paddingLeft: `${entry.depth * 16 + 12}px` }}
                      >
                        <FileText className="size-4" />
                        <span className="min-w-0 flex-1 truncate">
                          {entry.label}
                        </span>
                      </button>
                    )
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
                  <CardDescription>
                    Keep the naming and metadata readable in both the
                    marketplace and workspace views.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <FieldGroup>
                    {mode === "marketplace" ? (
                      <Field>
                        <FieldLabel>Slug</FieldLabel>
                        <Input
                          value={draft.slug}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              slug: event.target.value,
                            }))
                          }
                          placeholder="meeting-brief"
                        />
                      </Field>
                    ) : null}

                    <Field>
                      <FieldLabel>Name</FieldLabel>
                      <Input
                        value={draft.name}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        placeholder="Meeting Brief"
                      />
                    </Field>

                    <Field>
                      <FieldLabel>Tags</FieldLabel>
                      <Input
                        value={draft.tagsText}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            tagsText: event.target.value,
                          }))
                        }
                        placeholder="meetings, summary, writing"
                      />
                    </Field>

                    <SkillIconField
                      previewUrl={draft.iconPreviewUrl}
                      uploading={iconUploading}
                      onUpload={handleIconUpload}
                      onClear={clearIcon}
                    />
                  </FieldGroup>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Description</CardTitle>
                  <CardDescription>
                    This is the fixed skill body. It is stored as a single
                    canonical content block.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <CanonicalContentEditor
                    workspaceId={workspaceId}
                    value={draft.descriptionBlocks}
                    onChange={(nextBlocks) =>
                      setDraft((current) => ({
                        ...current,
                        descriptionBlocks: nextBlocks,
                      }))
                    }
                    label="Skill description"
                    description="Keep exactly one block here. Use attachments for longer reference material."
                    showCount
                  />
                </CardContent>
              </Card>

              {mode === "workspace" ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Initial access</CardTitle>
                    <CardDescription>
                      Choose the first access grant. You can manage more access
                      rules after the skill is created.
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
                      <div className="font-medium text-foreground">
                        Initial access target
                      </div>
                      <div className="mt-1">
                        {resolveScopeTarget(
                          scopeDraft,
                          actors,
                          conversations,
                          members
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ) : null}

              {mode === "marketplace" ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Release metadata</CardTitle>
                    <CardDescription>
                      Publishing a new version updates the latest marketplace
                      release for this skill.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <FieldGroup>
                      <Field>
                        <FieldLabel>Version</FieldLabel>
                        <Input
                          value={draft.version}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              version: event.target.value,
                            }))
                          }
                          placeholder="1.0.0"
                        />
                      </Field>
                      <Field>
                        <FieldLabel>Changelog</FieldLabel>
                        <Textarea
                          value={draft.changelog}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              changelog: event.target.value,
                            }))
                          }
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
                        Attachments are edited as path plus canonical content
                        blocks. Folder hierarchy is derived from the path.
                      </CardDescription>
                    </div>
                    {selectedFile ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          variant="destructive"
                          onClick={removeSelectedFile}
                        >
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
                            onChange={(event) =>
                              renameSelectedFile(event.target.value)
                            }
                          />
                          <FieldDescription>
                            Use nested paths like `references/checklist.md` to
                            keep the skill organized.
                          </FieldDescription>
                        </Field>
                      </FieldGroup>

                      <CanonicalContentEditor
                        workspaceId={workspaceId}
                        value={selectedFile.contentBlocks}
                        onChange={(nextBlocks) =>
                          commitFile(selectedFile.path, (file) => ({
                            ...file,
                            contentBlocks: nextBlocks,
                          }))
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
            {saving ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : (
              <Save data-icon="inline-start" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
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
  open: boolean
  skill: SkillMarketplaceEntry | null
  actors: ActorOption[]
  conversations: ConversationOption[]
  members: MemberOption[]
  workspaceId: string | null
  onOpenChange: (open: boolean) => void
  onInstalled: (skillId: string) => Promise<void> | void
}) {
  const [scopeDraft, setScopeDraft] = useState<ScopeDraft>(createScopeDraft())
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    if (open) {
      setScopeDraft(createScopeDraft())
    }
  }, [open])

  async function handleInstall() {
    if (!workspaceId || !skill) return
    setInstalling(true)
    try {
      const result = await api.installSkill(workspaceId, {
        marketSkillId: skill.id,
        grantScope: scopeDraft.useScope,
        actorId:
          scopeDraft.useScope === "actor_global" ||
          scopeDraft.useScope === "actor_conversation"
            ? scopeDraft.actorId || undefined
            : undefined,
        conversationId:
          scopeDraft.useScope === "conversation" ||
          scopeDraft.useScope === "actor_conversation"
            ? scopeDraft.conversationId || undefined
            : undefined,
        userId:
          scopeDraft.useScope === "user"
            ? scopeDraft.userId || undefined
            : undefined,
      })
      toast.success("Skill installed")
      onOpenChange(false)
      await onInstalled(result.skill.id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Install failed")
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install skill</DialogTitle>
          <DialogDescription>
            Install this skill in the workspace and choose the first access
            grant. You can add more access rules later.
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
                    <CardTitle className="truncate text-base">
                      {skill.name}
                    </CardTitle>
                    <CardDescription className="mt-1">
                      {skillDescriptionText(skill.description) ||
                        "No description provided."}
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
              <div className="font-medium text-foreground">
                Initial access target
              </div>
              <div className="mt-1">
                {resolveScopeTarget(scopeDraft, actors, conversations, members)}
              </div>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleInstall()}
            disabled={installing || !skill}
          >
            {installing ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : (
              <UploadCloud data-icon="inline-start" />
            )}
            Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function InstalledSkillConfigurationPage({
  skillId,
}: {
  skillId: string
}) {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [skill, setSkill] = useState<InstalledSkill | null>(null)
  const [loading, setLoading] = useState(true)
  const [installedDetailTab, setInstalledDetailTab] = useState<
    "content" | "access"
  >("content")
  const [enabledDraft, setEnabledDraft] = useState(true)
  const [savingSettings, setSavingSettings] = useState(false)
  const [upgradingSkill, setUpgradingSkill] = useState(false)
  const [removingSkill, setRemovingSkill] = useState(false)
  const [selectedAttachmentPath, setSelectedAttachmentPath] = useState("")

  const refreshSkill = useCallback(async () => {
    if (!workspaceId || !skillId) {
      setSkill(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const response = await api.getInstalledSkill(workspaceId, skillId)
      setSkill(response.skill)
    } catch (error) {
      setSkill(null)
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to load installed skill"
      )
    } finally {
      setLoading(false)
    }
  }, [skillId, workspaceId])

  useEffect(() => {
    void refreshSkill()
  }, [refreshSkill])

  useEffect(() => {
    setEnabledDraft(skill?.isEnabled ?? true)
  }, [skill])

  useEffect(() => {
    setInstalledDetailTab("content")
  }, [skillId])

  useEffect(() => {
    setSelectedAttachmentPath(skill?.attachmentFiles?.[0]?.path || "")
  }, [skill])

  async function handleSettingsSave() {
    if (!workspaceId || !skill) return
    setSavingSettings(true)
    try {
      await api.updateInstalledSkill(workspaceId, skill.id, {
        isEnabled: enabledDraft,
      })
      await refreshSkill()
      toast.success("Skill settings updated")
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update skill settings"
      )
    } finally {
      setSavingSettings(false)
    }
  }

  async function handleUpgrade() {
    if (!workspaceId || !skill) return
    setUpgradingSkill(true)
    try {
      await api.upgradeInstalledSkill(workspaceId, skill.id)
      await refreshSkill()
      toast.success("Skill upgraded to the latest marketplace version")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upgrade failed")
    } finally {
      setUpgradingSkill(false)
    }
  }

  async function handleUninstall() {
    if (!workspaceId || !skill) return
    setRemovingSkill(true)
    try {
      await api.uninstallInstalledSkill(workspaceId, skill.id)
      toast.success("Skill uninstalled")
      router.push("/dashboard/skills")
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to uninstall skill"
      )
    } finally {
      setRemovingSkill(false)
    }
  }

  const installedAttachments =
    skill?.attachmentFiles?.map((file) => ({
      path: file.path,
      contentBlocks: file.contentBlocks,
    })) || []
  const selectedAttachment =
    findSkillFile(installedAttachments, selectedAttachmentPath) ||
    installedAttachments[0] ||
    null
  const installedAttachmentTree = useMemo(
    () => buildFileTreeEntries(installedAttachments),
    [installedAttachments]
  )

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => router.push("/dashboard/skills")}
        >
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b border-border bg-muted/20 pb-0">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <CardTitle>{skill?.name || "Skill configuration"}</CardTitle>
              <div className="mt-2 space-y-1">
                <CardDescription>
                  {skillDescriptionText(skill?.description) ||
                    "No description provided."}
                </CardDescription>
                {skill ? (
                  <div className="text-sm text-muted-foreground">
                    {skillVersionText(skill)}
                  </div>
                ) : null}
              </div>
            </div>

            {skill ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    router.push(`/dashboard/skills/installed/${skill.id}/edit`)
                  }
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
                      <Loader2
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : (
                      <UploadCloud data-icon="inline-start" />
                    )}
                    Upgrade
                  </Button>
                ) : null}
                <Button
                  variant="destructive"
                  onClick={() => void handleUninstall()}
                  disabled={removingSkill}
                >
                  {removingSkill ? (
                    <Loader2
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : (
                    <Trash2 data-icon="inline-start" />
                  )}
                  Uninstall
                </Button>
              </div>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="px-6 pt-0 pb-6">
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
              onValueChange={(nextValue) =>
                setInstalledDetailTab(nextValue as "content" | "access")
              }
              className="flex flex-col"
            >
              <TabsList>
                <TabsTrigger value="content">Content</TabsTrigger>
                <TabsTrigger value="access">Access</TabsTrigger>
              </TabsList>

              <TabsContent value="content" className="mt-0 flex flex-col gap-6">
                <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
                  <div className="rounded-[24px] border border-border bg-muted/10 p-4">
                    <div className="mb-4">
                      <div className="text-base font-medium text-foreground">
                        Files
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        {skill.attachmentFiles?.length || 0} path
                        {skill.attachmentFiles?.length === 1 ? "" : "s"}
                      </div>
                    </div>
                    <div>
                      {installedAttachmentTree.length === 0 ? (
                        <div className="rounded-[24px] border border-dashed border-border bg-muted/10 px-5 py-10 text-sm text-muted-foreground">
                          No attachments in this skill.
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {installedAttachmentTree.map((entry) =>
                            entry.kind === "folder" ? (
                              <div
                                key={`installed-folder-${entry.path}`}
                                className="flex items-center gap-2 rounded-2xl px-3 py-2 text-sm text-muted-foreground"
                                style={{
                                  paddingLeft: `${entry.depth * 16 + 12}px`,
                                }}
                              >
                                <FolderClosed className="size-4" />
                                <span>{entry.label}</span>
                              </div>
                            ) : (
                              <button
                                key={entry.path}
                                type="button"
                                onClick={() =>
                                  setSelectedAttachmentPath(entry.path)
                                }
                                className={`flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm transition-colors ${
                                  selectedAttachment?.path === entry.path
                                    ? "bg-muted text-foreground"
                                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                                }`}
                                style={{
                                  paddingLeft: `${entry.depth * 16 + 12}px`,
                                }}
                              >
                                <FileText className="size-4" />
                                <span className="min-w-0 flex-1 truncate">
                                  {entry.label}
                                </span>
                              </button>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-[24px] border border-border bg-background p-5">
                    {selectedAttachment ? (
                      <div className="flex flex-col gap-5">
                        <div>
                          <div className="text-lg font-semibold text-foreground">
                            {skillFileName(selectedAttachment.path)}
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            Preview
                          </div>
                        </div>
                        <CanonicalContentRenderer
                          blocks={selectedAttachment.contentBlocks}
                        />
                      </div>
                    ) : (
                      <div className="rounded-[24px] border border-dashed border-border bg-muted/10 px-5 py-14 text-sm text-muted-foreground">
                        No attachment selected.
                      </div>
                    )}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="access" className="mt-0 flex flex-col gap-6">
                <div className="rounded-[24px] border border-border bg-muted/10 p-5">
                  <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="max-w-2xl">
                      <div className="text-sm font-medium text-foreground">
                        Enabled
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        Disabled skills stay installed but are hidden from
                        runtime resolution.
                      </div>
                    </div>
                    <Switch
                      checked={enabledDraft}
                      onCheckedChange={setEnabledDraft}
                    />
                  </div>

                  <div className="mt-5">
                    <Button
                      onClick={() => void handleSettingsSave()}
                      disabled={savingSettings}
                    >
                      {savingSettings ? (
                        <Loader2
                          className="animate-spin"
                          data-icon="inline-start"
                        />
                      ) : (
                        <ShieldCheck data-icon="inline-start" />
                      )}
                      Save settings
                    </Button>
                  </div>
                </div>

                <PluginAccessStep
                  installation={skill}
                  accessAdapter={skillAccessAdapter}
                  resourceLabel="skill"
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
    </div>
  )
}

export function InstalledSkillEditorPage({ skillId }: { skillId: string }) {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [skill, setSkill] = useState<InstalledSkill | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editorTab, setEditorTab] = useState<"metadata" | "content">("metadata")
  const [draft, setDraft] = useState<EditorDraft>(() => ({
    ...createInstalledDraft(null),
    attachmentFiles: [],
  }))
  const [iconUploading, setIconUploading] = useState(false)
  const [selectedPath, setSelectedPath] = useState("")
  const [selectedPathDraft, setSelectedPathDraft] = useState("")
  const [newPath, setNewPath] = useState("content/new-note.md")

  const refreshSkill = useCallback(async () => {
    if (!workspaceId || !skillId) {
      setSkill(null)
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const response = await api.getInstalledSkill(workspaceId, skillId)
      const nextSkill = response.skill
      const attachmentFiles = ensureRequiredSkillPath(
        nextSkill.attachmentFiles?.map((file) => ({
          path: file.path,
          contentBlocks: file.contentBlocks,
        })) || []
      )
      setSkill(nextSkill)
      setDraft({
        slug: nextSkill.slug || "",
        name: nextSkill.name || "",
        descriptionBlocks: nextSkill.description
          ? [nextSkill.description]
          : createEmptyDescriptionBlocks(),
        iconFileId: undefined,
        iconPreviewUrl: nextSkill.iconUrl || undefined,
        tagsText: nextSkill.tags.join(", ") || "",
        version: nextSkill.sourceVersion || "",
        changelog: "",
        attachmentFiles,
      })
      const firstPath =
        attachmentFiles.find((file) => isRequiredSkillPath(file.path))?.path ||
        attachmentFiles[0]?.path ||
        ""
      setSelectedPath(firstPath)
      setSelectedPathDraft(firstPath)
    } catch (error) {
      setSkill(null)
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to load installed skill"
      )
    } finally {
      setLoading(false)
    }
  }, [skillId, workspaceId])

  useEffect(() => {
    void refreshSkill()
  }, [refreshSkill])

  useEffect(() => {
    setEditorTab("metadata")
  }, [skillId])

  const selectedFile =
    findSkillFile(draft.attachmentFiles, selectedPath) ||
    draft.attachmentFiles[0] ||
    null

  const treeEntries = useMemo(
    () => buildFileTreeEntries(draft.attachmentFiles),
    [draft.attachmentFiles]
  )

  useEffect(() => {
    setSelectedPathDraft(selectedFile?.path || "")
  }, [selectedFile?.path])

  const commitFile = useCallback(
    (filePath: string, updater: (file: SkillFileDraft) => SkillFileDraft) => {
      setDraft((current) => ({
        ...current,
        attachmentFiles: current.attachmentFiles.map((file) =>
          file.path === filePath ? updater(file) : file
        ),
      }))
    },
    []
  )

  async function handleIconUpload(file: File) {
    setIconUploading(true)
    try {
      const nextIcon = await uploadSkillIcon(workspaceId, file)
      setDraft((current) => ({
        ...current,
        ...nextIcon,
      }))
      toast.success("Skill icon uploaded")
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Skill icon upload failed"
      )
    } finally {
      setIconUploading(false)
    }
  }

  function clearIcon() {
    setDraft((current) => ({
      ...current,
      iconFileId: null,
      iconPreviewUrl: undefined,
    }))
  }

  function addPath() {
    const nextPath = normalizeFilePath(newPath)
    if (!nextPath) {
      toast.error("Enter a path first")
      return
    }
    if (draft.attachmentFiles.some((file) => file.path === nextPath)) {
      toast.error("That path already exists")
      return
    }

    setDraft((current) => ({
      ...current,
      attachmentFiles: [
        ...current.attachmentFiles,
        createEmptySkillFile(nextPath),
      ],
    }))
    setSelectedPath(nextPath)
    setSelectedPathDraft(nextPath)
    setNewPath("content/new-note.md")
    setEditorTab("content")
  }

  function applySelectedPathRename(nextPathInput: string) {
    if (!selectedFile) return
    if (isRequiredSkillPath(selectedFile.path)) {
      setSelectedPathDraft(selectedFile.path)
      return
    }
    const nextPath = normalizeFilePath(nextPathInput)
    if (!nextPath) {
      setSelectedPathDraft(selectedFile.path)
      return
    }
    if (
      nextPath !== selectedFile.path &&
      draft.attachmentFiles.some((file) => file.path === nextPath)
    ) {
      toast.error("That path is already in use")
      setSelectedPathDraft(selectedFile.path)
      return
    }

    setDraft((current) => ({
      ...current,
      attachmentFiles: current.attachmentFiles.map((file) =>
        file.path === selectedFile.path ? { ...file, path: nextPath } : file
      ),
    }))
    setSelectedPath(nextPath)
    setSelectedPathDraft(nextPath)
  }

  function removeSelectedPath() {
    if (!selectedFile) return
    if (isRequiredSkillPath(selectedFile.path)) {
      toast.error(`${REQUIRED_SKILL_PATH} is required and cannot be removed`)
      return
    }
    const remaining = draft.attachmentFiles.filter(
      (file) => file.path !== selectedFile.path
    )
    setDraft((current) => ({
      ...current,
      attachmentFiles: remaining,
    }))
    const nextSelectedPath = remaining[0]?.path || ""
    setSelectedPath(nextSelectedPath)
    setSelectedPathDraft(nextSelectedPath)
  }

  async function handleSave() {
    if (!workspaceId || !skill) return

    let description: CanonicalContentBlock
    try {
      description = ensureSingleDescriptionBlock(draft.descriptionBlocks)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Skill description is invalid"
      )
      return
    }

    const attachmentFiles = draft.attachmentFiles.map((file) => ({
      path: normalizeFilePath(file.path),
      contentBlocks: file.contentBlocks,
    }))

    if (!draft.name.trim()) {
      toast.error("Skill name is required")
      return
    }
    if (attachmentFiles.some((file) => !file.path)) {
      toast.error("Every path needs a valid value")
      return
    }

    setSaving(true)
    try {
      await api.updateInstalledSkill(workspaceId, skill.id, {
        name: draft.name.trim(),
        description,
        iconFileId: draft.iconFileId,
        tags: parseTags(draft.tagsText),
        attachmentFiles,
      })
      await refreshSkill()
      toast.success("Skill updated")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => router.push(`/dashboard/skills/installed/${skillId}`)}
        >
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
      </div>

      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="max-w-3xl">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {loading ? "Edit skill" : skill?.name || "Edit skill"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {loading
              ? "Loading skill metadata..."
              : skillDescriptionText(skill?.description) ||
                "No description provided."}
          </p>
          {!loading && skill ? (
            <div className="mt-2 text-sm text-muted-foreground">
              {skillVersionText(skill)}
            </div>
          ) : null}
        </div>

        {!loading && skill ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                router.push(`/dashboard/skills/installed/${skill.id}`)
              }
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              Save
            </Button>
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="rounded-[28px] border border-border bg-card px-6 py-16 text-sm text-muted-foreground">
          <div className="flex items-center justify-center">
            <Loader2 className="mr-2 animate-spin" />
            Loading skill...
          </div>
        </div>
      ) : !skill ? (
        <div className="rounded-[28px] border border-dashed border-border bg-card px-6 py-16 text-sm text-muted-foreground">
          Skill not found.
        </div>
      ) : (
        <Tabs
          value={editorTab}
          onValueChange={(nextValue) =>
            setEditorTab(nextValue as "metadata" | "content")
          }
          className="flex flex-col"
        >
          <TabsList>
            <TabsTrigger value="metadata">Metadata</TabsTrigger>
            <TabsTrigger value="content">Content</TabsTrigger>
          </TabsList>

          <TabsContent value="metadata" className="mt-6">
            <div className="grid gap-6 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
              <div className="rounded-[28px] border border-border bg-card p-6">
                <div className="mb-5">
                  <div className="text-base font-medium text-foreground">
                    Metadata
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    Update the name, tags, and icon shown across skill pages.
                  </div>
                </div>

                <FieldGroup>
                  <Field>
                    <FieldLabel>Name</FieldLabel>
                    <Input
                      value={draft.name}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      placeholder="Meeting Brief"
                    />
                  </Field>

                  <Field>
                    <FieldLabel>Tags</FieldLabel>
                    <Input
                      value={draft.tagsText}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          tagsText: event.target.value,
                        }))
                      }
                      placeholder="meetings, summary, writing"
                    />
                  </Field>

                  <SkillIconField
                    previewUrl={draft.iconPreviewUrl}
                    uploading={iconUploading}
                    onUpload={handleIconUpload}
                    onClear={clearIcon}
                  />
                </FieldGroup>
              </div>

              <div className="rounded-[28px] border border-border bg-card p-6">
                <div className="mb-5">
                  <div className="text-base font-medium text-foreground">
                    Description
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    Keep exactly one canonical content block for the skill
                    summary.
                  </div>
                </div>

                <CanonicalContentEditor
                  workspaceId={workspaceId}
                  value={draft.descriptionBlocks}
                  onChange={(nextBlocks) =>
                    setDraft((current) => ({
                      ...current,
                      descriptionBlocks: nextBlocks,
                    }))
                  }
                  label="Skill description"
                  description="This summary is shown in the skill header and list views."
                  showCount
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="content" className="mt-6">
            <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
              <div className="rounded-[28px] border border-border bg-card p-5">
                <div className="mb-5">
                  <div className="text-base font-medium text-foreground">
                    Paths
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {draft.attachmentFiles.length} path
                    {draft.attachmentFiles.length === 1 ? "" : "s"} in this
                    skill
                  </div>
                </div>

                <FieldGroup>
                  <Field>
                    <FieldLabel>New path</FieldLabel>
                    <Input
                      value={newPath}
                      onChange={(event) => setNewPath(event.target.value)}
                      placeholder="content/new-note.md"
                    />
                  </Field>
                  <Button type="button" variant="outline" onClick={addPath}>
                    <FilePlus2 data-icon="inline-start" />
                    Add path
                  </Button>
                </FieldGroup>

                <div className="mt-5">
                  {treeEntries.length === 0 ? (
                    <div className="rounded-[24px] border border-dashed border-border bg-muted/10 px-4 py-8 text-sm text-muted-foreground">
                      No paths yet.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {treeEntries.map((entry) =>
                        entry.kind === "folder" ? (
                          <div
                            key={`editor-folder-${entry.path}`}
                            className="flex items-center gap-2 rounded-2xl px-3 py-2 text-sm text-muted-foreground"
                            style={{
                              paddingLeft: `${entry.depth * 16 + 12}px`,
                            }}
                          >
                            <FolderClosed className="size-4" />
                            <span>{entry.label}</span>
                          </div>
                        ) : (
                          <button
                            key={entry.path}
                            type="button"
                            onClick={() => setSelectedPath(entry.path)}
                            className={`flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm transition-colors ${
                              selectedFile?.path === entry.path
                                ? "bg-muted text-foreground"
                                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                            }`}
                            style={{
                              paddingLeft: `${entry.depth * 16 + 12}px`,
                            }}
                          >
                            <FileText className="size-4" />
                            <span className="min-w-0 flex-1 truncate">
                              {entry.label}
                            </span>
                          </button>
                        )
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-[28px] border border-border bg-card p-6">
                {selectedFile ? (
                  <div className="flex flex-col gap-6">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                      <div className="min-w-0 flex-1">
                        <Field>
                          <FieldLabel>Path</FieldLabel>
                          <Input
                            value={selectedPathDraft}
                            onChange={(event) =>
                              setSelectedPathDraft(event.target.value)
                            }
                            onBlur={(event) =>
                              applySelectedPathRename(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault()
                                applySelectedPathRename(selectedPathDraft)
                              }
                            }}
                            disabled={isRequiredSkillPath(selectedFile.path)}
                          />
                          <FieldDescription>
                            {isRequiredSkillPath(selectedFile.path)
                              ? `${REQUIRED_SKILL_PATH} is required and its path is fixed.`
                              : "Rename this path with nested values like `references/checklist.md`."}
                          </FieldDescription>
                        </Field>
                      </div>

                      <Button
                        type="button"
                        variant="destructive"
                        onClick={removeSelectedPath}
                        disabled={isRequiredSkillPath(selectedFile.path)}
                      >
                        <Trash2 data-icon="inline-start" />
                        Remove path
                      </Button>
                    </div>

                    <CanonicalContentEditor
                      workspaceId={workspaceId}
                      value={selectedFile.contentBlocks}
                      onChange={(nextBlocks) =>
                        commitFile(selectedFile.path, (file) => ({
                          ...file,
                          contentBlocks: nextBlocks,
                        }))
                      }
                      label={skillFileName(selectedFile.path)}
                      description="Edit the blocks stored at this path."
                      showCount
                    />
                  </div>
                ) : (
                  <div className="rounded-[24px] border border-dashed border-border bg-muted/10 px-5 py-14 text-sm text-muted-foreground">
                    Create a path on the left to start editing content.
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

export function WorkspaceSkillCreationPage() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [iconUploading, setIconUploading] = useState(false)
  const [step, setStep] = useState<"metadata" | "content">("metadata")
  const [actors, setActors] = useState<ActorOption[]>([])
  const [conversations, setConversations] = useState<ConversationOption[]>([])
  const [members, setMembers] = useState<MemberOption[]>([])
  const [draft, setDraft] = useState<EditorDraft>(() => createWorkspaceDraft())
  const [scopeDraft, setScopeDraft] = useState<ScopeDraft>(createScopeDraft())
  const [selectedPath, setSelectedPath] = useState(REQUIRED_SKILL_PATH)
  const [selectedPathDraft, setSelectedPathDraft] =
    useState(REQUIRED_SKILL_PATH)
  const [newPath, setNewPath] = useState("content/new-note.md")

  const selectedFile =
    findSkillFile(draft.attachmentFiles, selectedPath) ||
    draft.attachmentFiles[0] ||
    null

  const treeEntries = useMemo(
    () => buildFileTreeEntries(draft.attachmentFiles),
    [draft.attachmentFiles]
  )

  useEffect(() => {
    if (!workspaceId) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    Promise.all([
      api.getActors(workspaceId),
      api.getThreads(workspaceId, { domain: "workspace" }),
      api.getWorkspaceMembers(workspaceId),
    ])
      .then(([actorsResponse, conversationsResponse, membersResponse]) => {
        if (cancelled) return
        setActors(
          Array.isArray(actorsResponse)
            ? actorsResponse.map(normalizeActorOption)
            : []
        )
        setConversations(
          Array.isArray(conversationsResponse?.threads)
            ? conversationsResponse.threads.map(
                normalizeConversationOption
              )
            : []
        )
        setMembers(
          Array.isArray(membersResponse?.data)
            ? membersResponse.data.map(normalizeMemberOption)
            : []
        )
      })
      .catch((error) => {
        if (cancelled) return
        toast.error(
          error instanceof Error ? error.message : "Failed to load skill editor"
        )
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  useEffect(() => {
    setSelectedPathDraft(selectedFile?.path || "")
  }, [selectedFile?.path])

  const commitFile = useCallback(
    (filePath: string, updater: (file: SkillFileDraft) => SkillFileDraft) => {
      setDraft((current) => ({
        ...current,
        attachmentFiles: current.attachmentFiles.map((file) =>
          file.path === filePath ? updater(file) : file
        ),
      }))
    },
    []
  )

  async function handleIconUpload(file: File) {
    setIconUploading(true)
    try {
      const nextIcon = await uploadSkillIcon(workspaceId, file)
      setDraft((current) => ({
        ...current,
        ...nextIcon,
      }))
      toast.success("Skill icon uploaded")
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Skill icon upload failed"
      )
    } finally {
      setIconUploading(false)
    }
  }

  function clearIcon() {
    setDraft((current) => ({
      ...current,
      iconFileId: null,
      iconPreviewUrl: undefined,
    }))
  }

  function addPath() {
    const nextPath = normalizeFilePath(newPath)
    if (!nextPath) {
      toast.error("Enter a path first")
      return
    }
    if (draft.attachmentFiles.some((file) => file.path === nextPath)) {
      toast.error("That path already exists")
      return
    }

    setDraft((current) => ({
      ...current,
      attachmentFiles: [
        ...current.attachmentFiles,
        createEmptySkillFile(nextPath),
      ],
    }))
    setSelectedPath(nextPath)
    setSelectedPathDraft(nextPath)
  }

  function applySelectedPathRename(nextPathInput: string) {
    if (!selectedFile) return
    if (isRequiredSkillPath(selectedFile.path)) {
      setSelectedPathDraft(selectedFile.path)
      return
    }
    const nextPath = normalizeFilePath(nextPathInput)
    if (!nextPath) {
      setSelectedPathDraft(selectedFile.path)
      return
    }
    if (
      nextPath !== selectedFile.path &&
      draft.attachmentFiles.some((file) => file.path === nextPath)
    ) {
      toast.error("That path is already in use")
      setSelectedPathDraft(selectedFile.path)
      return
    }

    setDraft((current) => ({
      ...current,
      attachmentFiles: current.attachmentFiles.map((file) =>
        file.path === selectedFile.path ? { ...file, path: nextPath } : file
      ),
    }))
    setSelectedPath(nextPath)
    setSelectedPathDraft(nextPath)
  }

  function removeSelectedPath() {
    if (!selectedFile) return
    if (isRequiredSkillPath(selectedFile.path)) {
      toast.error(`${REQUIRED_SKILL_PATH} is required and cannot be removed`)
      return
    }
    const remaining = draft.attachmentFiles.filter(
      (file) => file.path !== selectedFile.path
    )
    setDraft((current) => ({
      ...current,
      attachmentFiles: remaining,
    }))
    const nextSelectedPath =
      remaining.find((file) => isRequiredSkillPath(file.path))?.path ||
      remaining[0]?.path ||
      ""
    setSelectedPath(nextSelectedPath)
    setSelectedPathDraft(nextSelectedPath)
  }

  async function handleCreate() {
    if (!workspaceId) return

    let description: CanonicalContentBlock
    try {
      description = ensureSingleDescriptionBlock(draft.descriptionBlocks)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Skill description is invalid"
      )
      return
    }

    const attachmentFiles = draft.attachmentFiles.map((file) => ({
      path: normalizeFilePath(file.path),
      contentBlocks: file.contentBlocks,
    }))

    if (!draft.name.trim()) {
      toast.error("Skill name is required")
      return
    }

    setSaving(true)
    try {
      const result = await api.createWorkspaceSkill(workspaceId, {
        name: draft.name.trim(),
        description,
        iconFileId: draft.iconFileId || undefined,
        tags: parseTags(draft.tagsText),
        attachmentFiles,
        grantScope: scopeDraft.useScope,
        actorId:
          scopeDraft.useScope === "actor_global" ||
          scopeDraft.useScope === "actor_conversation"
            ? scopeDraft.actorId || undefined
            : undefined,
        conversationId:
          scopeDraft.useScope === "conversation" ||
          scopeDraft.useScope === "actor_conversation"
            ? scopeDraft.conversationId || undefined
            : undefined,
        userId:
          scopeDraft.useScope === "user"
            ? scopeDraft.userId || undefined
            : undefined,
      })
      toast.success("Workspace skill created")
      router.push(`/dashboard/skills/installed/${result.skill.id}`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create skill"
      )
    } finally {
      setSaving(false)
    }
  }

  const steps = [
    {
      key: "metadata" as const,
      number: 1,
      title: "Basic info",
      description: "Name, summary, and initial access",
    },
    {
      key: "content" as const,
      number: 2,
      title: "Content",
      description: "Edit Skill.md and any extra paths",
    },
  ]

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => router.push("/dashboard/skills")}
        >
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
      </div>

      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="max-w-3xl">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            New skill
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Create a workspace skill in two steps. {REQUIRED_SKILL_PATH} is
            always included and must be edited as the primary content file.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push("/dashboard/skills")}
          >
            Cancel
          </Button>
          {step === "content" ? (
            <Button
              type="button"
              onClick={() => void handleCreate()}
              disabled={saving || loading}
            >
              {saving ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              Create skill
            </Button>
          ) : null}
        </div>
      </div>

      <div className="rounded-[28px] border border-border bg-card p-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center">
          {steps.map((item, index) => {
            const isActive = step === item.key
            const isDone = item.number < (step === "content" ? 2 : 1)
            return (
              <div
                key={item.key}
                className="flex min-w-0 flex-1 items-center gap-4"
              >
                <button
                  type="button"
                  onClick={() => setStep(item.key)}
                  className={`flex min-w-0 flex-1 items-center gap-3 rounded-[22px] border px-4 py-3 text-left transition-colors ${
                    isActive
                      ? "border-foreground/15 bg-muted text-foreground"
                      : isDone
                        ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-100"
                        : "border-border bg-background text-muted-foreground"
                  }`}
                >
                  <div
                    className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                      isActive
                        ? "bg-foreground text-background"
                        : isDone
                          ? "bg-emerald-600 text-white"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {item.number}
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium">{item.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {item.description}
                    </div>
                  </div>
                </button>
                {index < steps.length - 1 ? (
                  <div className="hidden h-px flex-1 bg-border md:block" />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      {loading ? (
        <div className="rounded-[28px] border border-border bg-card px-6 py-16 text-sm text-muted-foreground">
          <div className="flex items-center justify-center">
            <Loader2 className="mr-2 animate-spin" />
            Loading skill setup...
          </div>
        </div>
      ) : step === "metadata" ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          <div className="rounded-[28px] border border-border bg-card p-6">
            <div className="mb-5">
              <div className="text-base font-medium text-foreground">
                Basic info
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                Set the skill title and list metadata. Workspace skills do not
                expose a custom slug.
              </div>
            </div>

            <FieldGroup>
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder="Meeting Brief"
                />
              </Field>

              <Field>
                <FieldLabel>Tags</FieldLabel>
                <Input
                  value={draft.tagsText}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      tagsText: event.target.value,
                    }))
                  }
                  placeholder="meetings, summary, writing"
                />
              </Field>

              <SkillIconField
                previewUrl={draft.iconPreviewUrl}
                uploading={iconUploading}
                onUpload={handleIconUpload}
                onClear={clearIcon}
              />
            </FieldGroup>
          </div>

          <div className="rounded-[28px] border border-border bg-card p-6">
            <div className="mb-5">
              <div className="text-base font-medium text-foreground">
                Description
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                This summary appears in the skill header and skills list.
              </div>
            </div>

            <CanonicalContentEditor
              workspaceId={workspaceId}
              value={draft.descriptionBlocks}
              onChange={(nextBlocks) =>
                setDraft((current) => ({
                  ...current,
                  descriptionBlocks: nextBlocks,
                }))
              }
              label="Skill description"
              description="Keep exactly one canonical content block here."
              showCount
            />

            <div className="mt-6 border-t border-border pt-6">
              <div className="mb-5">
                <div className="text-base font-medium text-foreground">
                  Initial access
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  Choose who can use this skill right after creation.
                </div>
              </div>

              <ScopeFields
                value={scopeDraft}
                onChange={setScopeDraft}
                actors={actors}
                conversations={conversations}
                members={members}
              />

              <div className="mt-5 rounded-2xl border border-border bg-muted/10 px-4 py-3 text-sm text-muted-foreground">
                <div className="font-medium text-foreground">
                  Initial access target
                </div>
                <div className="mt-1">
                  {resolveScopeTarget(
                    scopeDraft,
                    actors,
                    conversations,
                    members
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end xl:col-span-2">
            <Button type="button" onClick={() => setStep("content")}>
              Continue to content
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
          <div className="rounded-[28px] border border-border bg-card p-5">
            <div className="mb-5">
              <div className="text-base font-medium text-foreground">Paths</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {draft.attachmentFiles.length} path
                {draft.attachmentFiles.length === 1 ? "" : "s"} in this skill
              </div>
            </div>

            <FieldGroup>
              <Field>
                <FieldLabel>New path</FieldLabel>
                <Input
                  value={newPath}
                  onChange={(event) => setNewPath(event.target.value)}
                  placeholder="content/new-note.md"
                />
              </Field>
              <Button type="button" variant="outline" onClick={addPath}>
                <FilePlus2 data-icon="inline-start" />
                Add path
              </Button>
            </FieldGroup>

            <div className="mt-5">
              <div className="mb-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-100">
                {REQUIRED_SKILL_PATH} is required and cannot be removed.
              </div>

              <div className="flex flex-col gap-1">
                {treeEntries.map((entry) =>
                  entry.kind === "folder" ? (
                    <div
                      key={`new-skill-folder-${entry.path}`}
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
                      onClick={() => setSelectedPath(entry.path)}
                      className={`flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm transition-colors ${
                        selectedFile?.path === entry.path
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      }`}
                      style={{ paddingLeft: `${entry.depth * 16 + 12}px` }}
                    >
                      <FileText className="size-4" />
                      <span className="min-w-0 flex-1 truncate">
                        {entry.label}
                      </span>
                    </button>
                  )
                )}
              </div>
            </div>
          </div>

          <div className="rounded-[28px] border border-border bg-card p-6">
            {selectedFile ? (
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <Field>
                      <FieldLabel>Path</FieldLabel>
                      <Input
                        value={selectedPathDraft}
                        onChange={(event) =>
                          setSelectedPathDraft(event.target.value)
                        }
                        onBlur={(event) =>
                          applySelectedPathRename(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault()
                            applySelectedPathRename(selectedPathDraft)
                          }
                        }}
                        disabled={isRequiredSkillPath(selectedFile.path)}
                      />
                      <FieldDescription>
                        {isRequiredSkillPath(selectedFile.path)
                          ? `${REQUIRED_SKILL_PATH} is required and its path is fixed.`
                          : "Rename this path with nested values like `references/checklist.md`."}
                      </FieldDescription>
                    </Field>
                  </div>

                  <Button
                    type="button"
                    variant="destructive"
                    onClick={removeSelectedPath}
                    disabled={isRequiredSkillPath(selectedFile.path)}
                  >
                    <Trash2 data-icon="inline-start" />
                    Remove path
                  </Button>
                </div>

                <CanonicalContentEditor
                  workspaceId={workspaceId}
                  value={selectedFile.contentBlocks}
                  onChange={(nextBlocks) =>
                    commitFile(selectedFile.path, (file) => ({
                      ...file,
                      contentBlocks: nextBlocks,
                    }))
                  }
                  label={skillFileName(selectedFile.path)}
                  description="Edit the blocks stored at this path."
                  showCount
                />

                <div className="flex justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setStep("metadata")}
                  >
                    Back to basic info
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void handleCreate()}
                    disabled={saving}
                  >
                    {saving ? (
                      <Loader2
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : (
                      <Save data-icon="inline-start" />
                    )}
                    Create skill
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded-[24px] border border-dashed border-border bg-muted/10 px-5 py-14 text-sm text-muted-foreground">
                Create a path on the left to start editing content.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function MarketplaceSkillPreviewPage({ skillId }: { skillId: string }) {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [skill, setSkill] = useState<SkillMarketplaceEntry | null>(null)
  const [actors, setActors] = useState<ActorOption[]>([])
  const [conversations, setConversations] = useState<ConversationOption[]>([])
  const [members, setMembers] = useState<MemberOption[]>([])
  const [loading, setLoading] = useState(true)
  const [installDialogOpen, setInstallDialogOpen] = useState(false)
  const [selectedAttachmentPath, setSelectedAttachmentPath] = useState("")

  const refreshSkill = useCallback(async () => {
    if (!workspaceId || !skillId) {
      setSkill(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [
        skillResponse,
        actorsResponse,
        conversationsResponse,
        membersResponse,
      ] =
        await Promise.all([
          api.getSkillMarketplaceItem(skillId, workspaceId),
          api.getActors(workspaceId),
          api.getThreads(workspaceId, { domain: "workspace" }),
          api.getWorkspaceMembers(workspaceId),
        ])

      const nextActors = Array.isArray(actorsResponse)
        ? actorsResponse.map(normalizeActorOption)
        : []
      const nextConversations = Array.isArray(
        conversationsResponse?.threads
      )
        ? conversationsResponse.threads.map(normalizeConversationOption)
        : []
      const nextMembers = Array.isArray(membersResponse?.data)
        ? membersResponse.data.map(normalizeMemberOption)
        : []
      setSkill(skillResponse.skill)
      setActors(nextActors)
      setConversations(nextConversations)
      setMembers(nextMembers)
    } catch (error) {
      setSkill(null)
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to load marketplace skill"
      )
    } finally {
      setLoading(false)
    }
  }, [skillId, workspaceId])

  useEffect(() => {
    void refreshSkill()
  }, [refreshSkill])

  useEffect(() => {
    setSelectedAttachmentPath(
      skill?.latestVersion?.attachmentFiles?.[0]?.path || ""
    )
  }, [skill])

  const marketplaceAttachments =
    skill?.latestVersion?.attachmentFiles?.map((file) => ({
      path: file.path,
      contentBlocks: file.contentBlocks,
    })) || []
  const selectedAttachment =
    findSkillFile(marketplaceAttachments, selectedAttachmentPath) ||
    marketplaceAttachments[0] ||
    null
  const marketplaceAttachmentTree = useMemo(
    () => buildFileTreeEntries(marketplaceAttachments),
    [marketplaceAttachments]
  )

  async function handleInstalled(installedSkillId: string) {
    router.push(`/dashboard/skills/installed/${installedSkillId}`)
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => router.push("/dashboard/skills")}
        >
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b border-border bg-muted/20">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <CardTitle>{skill?.name || "Skill preview"}</CardTitle>
              <CardDescription>
                {skill
                  ? "Preview this official skill before installing it in the workspace."
                  : "Select a skill from the list to preview it."}
              </CardDescription>
            </div>

            {skill ? (
              <div className="flex flex-wrap gap-2">
                {skill.workspaceInstallation?.installed &&
                skill.workspaceInstallation.installedSkillId ? (
                  <Button
                    onClick={() =>
                      router.push(
                        `/dashboard/skills/installed/${skill.workspaceInstallation?.installedSkillId}`
                      )
                    }
                  >
                    <FileText data-icon="inline-start" />
                    Open installed skill
                  </Button>
                ) : (
                  <Button onClick={() => setInstallDialogOpen(true)}>
                    <UploadCloud data-icon="inline-start" />
                    Install
                  </Button>
                )}
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
                      <CardDescription>
                        Marketplace metadata for discovery and installation.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline">Official</Badge>
                        <Badge variant="outline">{skill.slug}</Badge>
                        {skill.latestVersion?.version ? (
                          <Badge variant="secondary">
                            v{skill.latestVersion.version}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {skillDescriptionText(skill.description) ||
                          "No description provided."}
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-2xl border border-border bg-muted/10 p-4">
                          <div className="text-xs tracking-[0.16em] text-muted-foreground uppercase">
                            Publisher
                          </div>
                          <div className="mt-2 text-sm font-medium text-foreground">
                            {skill.authorName || "Platform admin"}
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            Updated {formatDate(skill.updatedAt)}
                          </div>
                        </div>
                        <div className="rounded-2xl border border-border bg-muted/10 p-4">
                          <div className="text-xs tracking-[0.16em] text-muted-foreground uppercase">
                            Attachments
                          </div>
                          <div className="mt-2 text-sm font-medium text-foreground">
                            {skill.latestVersion?.attachmentFiles?.length || 0}{" "}
                            path
                            {skill.latestVersion?.attachmentFiles?.length === 1
                              ? ""
                              : "s"}
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            {skill.latestVersion?.version
                              ? `Version ${skill.latestVersion.version}`
                              : "Latest release"}
                          </div>
                        </div>
                      </div>
                      <div className="rounded-2xl border border-border bg-muted/10 p-4 text-sm text-muted-foreground">
                        Install this skill to create a workspace-managed version
                        with its own description, attachments, and access rules.
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Attachments</CardTitle>
                      <CardDescription>
                        Attachments included in the latest published version.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {marketplaceAttachmentTree.length === 0 ? (
                        <div className="rounded-[24px] border border-dashed border-border bg-muted/10 px-5 py-10 text-sm text-muted-foreground">
                          No attachments in this release.
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {marketplaceAttachmentTree.map((entry) =>
                            entry.kind === "folder" ? (
                              <div
                                key={`market-folder-${entry.path}`}
                                className="flex items-center gap-2 rounded-2xl px-3 py-2 text-sm text-muted-foreground"
                                style={{
                                  paddingLeft: `${entry.depth * 16 + 12}px`,
                                }}
                              >
                                <FolderClosed className="size-4" />
                                <span>{entry.label}</span>
                              </div>
                            ) : (
                              <button
                                key={entry.path}
                                type="button"
                                onClick={() =>
                                  setSelectedAttachmentPath(entry.path)
                                }
                                className={`flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm transition-colors ${
                                  selectedAttachment?.path === entry.path
                                    ? "bg-muted text-foreground"
                                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                                }`}
                                style={{
                                  paddingLeft: `${entry.depth * 16 + 12}px`,
                                }}
                              >
                                <FileText className="size-4" />
                                <span className="min-w-0 flex-1 truncate">
                                  {entry.label}
                                </span>
                              </button>
                            )
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Description</CardTitle>
                    <CardDescription>
                      The fixed skill body published in the latest release.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <CanonicalContentRenderer blocks={[skill.description]} />
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Attachment preview
                  </CardTitle>
                  <CardDescription>
                    {selectedAttachment?.path ||
                      "Select an attachment to preview it."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <CanonicalContentRenderer
                    blocks={
                      selectedAttachment?.contentBlocks ||
                      textBlocks("No attachment selected.")
                    }
                  />
                </CardContent>
              </Card>
            </div>
          )}
        </CardContent>
      </Card>
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
  )
}

export default function SkillsPage() {
  const router = useRouter()
  const { workspaceId, workspaceName } = useWorkspace()
  const [search, setSearch] = useState("")
  const deferredSearch = useDeferredValue(search)
  const [marketplace, setMarketplace] = useState<SkillMarketplaceEntry[]>([])
  const [installed, setInstalled] = useState<InstalledSkill[]>([])
  const [loadingPage, setLoadingPage] = useState(false)

  const skillRows = useMemo(() => {
    const marketplaceIds = new Set(marketplace.map((skill) => skill.id))

    const customRows: SkillListRow[] = [...installed]
      .filter((skill) => !skill.sourceSkillId)
      .sort((left, right) => compareDatesDesc(left.updatedAt, right.updatedAt))
      .map((skill) => ({
        id: getSkillRowId(skill),
        kind: "custom",
        name: skill.name,
        slug: skill.slug,
        descriptionText: skillDescriptionText(skill.description),
        tags: skill.tags,
        installedSkillId: skill.id,
        version: skill.sourceVersion,
        updatedAt: skill.updatedAt,
      }))

    const officialInstalledRows: SkillListRow[] = [...marketplace]
      .filter(
        (skill) =>
          skill.workspaceInstallation?.installed &&
          skill.workspaceInstallation.installedSkillId
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({
        id: `official-installed:${skill.id}`,
        kind: "official-installed",
        name: skill.name,
        slug: skill.slug,
        descriptionText: skillDescriptionText(skill.description),
        tags: skill.tags,
        installedSkillId: skill.workspaceInstallation?.installedSkillId,
        marketplaceSkillId: skill.id,
        version: skill.latestVersion?.version,
        updatedAt: skill.updatedAt,
      }))

    const orphanOfficialRows: SkillListRow[] = [...installed]
      .filter(
        (skill) =>
          skill.sourceSkillId && !marketplaceIds.has(skill.sourceSkillId)
      )
      .sort((left, right) => compareDatesDesc(left.updatedAt, right.updatedAt))
      .map((skill) => ({
        id: `official-installed:${skill.sourceSkillId}`,
        kind: "official-installed",
        name: skill.name,
        slug: skill.slug,
        descriptionText: skillDescriptionText(skill.description),
        tags: skill.tags,
        installedSkillId: skill.id,
        marketplaceSkillId: skill.sourceSkillId,
        version: skill.sourceVersion,
        updatedAt: skill.updatedAt,
      }))

    const officialAvailableRows: SkillListRow[] = [...marketplace]
      .filter((skill) => !skill.workspaceInstallation?.installed)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({
        id: `official-available:${skill.id}`,
        kind: "official-available",
        name: skill.name,
        slug: skill.slug,
        descriptionText: skillDescriptionText(skill.description),
        tags: skill.tags,
        marketplaceSkillId: skill.id,
        version: skill.latestVersion?.version,
        updatedAt: skill.updatedAt,
      }))

    const rows = [
      ...customRows,
      ...officialInstalledRows,
      ...orphanOfficialRows,
      ...officialAvailableRows,
    ]
    const query = deferredSearch.trim().toLowerCase()
    if (!query) return rows
    return rows.filter((row) => matchesSkillRowQuery(row, query))
  }, [deferredSearch, installed, marketplace])

  const refreshIndex = useCallback(async () => {
    if (!workspaceId) return
    setLoadingPage(true)
    try {
      const [marketplaceResponse, installedResponse] = await Promise.all([
        api.getSkillMarketplace({ workspaceId }),
        api.getInstalledSkills(workspaceId),
      ])

      const nextMarketplace = Array.isArray(marketplaceResponse?.skills)
        ? marketplaceResponse.skills
        : []
      const nextInstalled = Array.isArray(installedResponse?.skills)
        ? installedResponse.skills
        : []

      setMarketplace(nextMarketplace)
      setInstalled(nextInstalled)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to load skills"
      )
    } finally {
      setLoadingPage(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void refreshIndex()
  }, [refreshIndex])

  function openSkillRow(row: SkillListRow) {
    if (row.installedSkillId) {
      router.push(`/dashboard/skills/installed/${row.installedSkillId}`)
      return
    }
    if (row.marketplaceSkillId) {
      router.push(`/dashboard/skills/marketplace/${row.marketplaceSkillId}`)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="max-w-3xl">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Skills
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Browse workspace skills and official skills in one list.
            {workspaceName ? ` Current workspace: ${workspaceName}.` : ""}
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:min-w-80">
            <Search className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search skills"
              className="pl-10"
            />
          </div>

          <Button onClick={() => router.push("/dashboard/skills/new")}>
            <Plus data-icon="inline-start" />
            New skill
          </Button>
          <Button
            variant="outline"
            onClick={() => void refreshIndex()}
            disabled={loadingPage}
          >
            {loadingPage ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : (
              <ArrowUpRight data-icon="inline-start" />
            )}
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
            <div className="px-6 py-12 text-sm text-muted-foreground">
              No skills matched this view.
            </div>
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[52%] whitespace-normal">
                    Skill
                  </TableHead>
                  <TableHead className="w-[18%] whitespace-normal">
                    Source
                  </TableHead>
                  <TableHead className="w-[14%] whitespace-normal">
                    Status
                  </TableHead>
                  <TableHead className="w-[16%] whitespace-normal">
                    Updated
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skillRows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    onClick={() => openSkillRow(row)}
                  >
                    <TableCell className="align-top whitespace-normal">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                          {row.kind === "custom" ? (
                            <ScrollText />
                          ) : (
                            <Sparkles />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="truncate font-medium text-foreground">
                              {row.name}
                            </div>
                            {row.version ? (
                              <Badge variant="outline">v{row.version}</Badge>
                            ) : null}
                          </div>
                          <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                            {row.descriptionText || "No description provided."}
                          </div>
                          <div className="mt-2 text-xs text-muted-foreground">
                            {row.slug}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="break-words whitespace-normal text-muted-foreground">
                      {rowSourceLabel(row)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={rowStatusVariant(row)}
                        className={rowStatusBadgeClassName(row)}
                      >
                        {rowStatusLabel(row)}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-normal text-muted-foreground">
                      {formatDate(row.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  )
}
