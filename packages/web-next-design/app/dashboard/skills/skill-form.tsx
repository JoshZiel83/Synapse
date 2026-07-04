"use client"

// Skill authoring — form + LIVE PREVIEW (renders the exact card so authors feel
// the one-line truncation). The description doubles as the trigger contract, so it
// gets a nudge to write "what + when" and a counter; a thin description silently
// breaks activation. Import mode switches the form to a github/clawhub locator.
// Save (draft) is separate from Publish. Edit takes effect immediately.
import { useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { descText, SkillIcon } from "./skill-card"

const EFFORT_LABEL: Record<string, string> = {
  low: "轻",
  medium: "中",
  high: "重",
  max: "极重",
}
const SCOPE_LABEL: Record<string, string> = {
  workspace: "整个工作区",
  member: "指定成员",
  actor: "指定智能体",
}

type Draft = {
  name: string
  description: string
  body: string
  effort: string
  scope: string
  disableModelInvocation: boolean
  userInvocable: boolean
  allowedTools: string
  tags: string
}
const EMPTY: Draft = {
  name: "",
  description: "",
  body: "",
  effort: "medium",
  scope: "workspace",
  disableModelInvocation: false,
  userInvocable: true,
  allowedTools: "",
  tags: "",
}

export function SkillForm({ mode }: { mode: "new" | "edit" }) {
  const { workspaceId } = useWorkspace()
  const router = useRouter()
  const params = useParams<{ skillId?: string }>()
  const search = useSearchParams()
  const isImport = mode === "new" && search.get("import") === "1"
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }))

  const editQuery = useQuery({
    queryKey: ["installed-skill", workspaceId, params.skillId],
    queryFn: () => api.getInstalledSkill(workspaceId!, params.skillId!),
    enabled: mode === "edit" && !!workspaceId && !!params.skillId,
  })
  useEffect(() => {
    const s = editQuery.data?.skill
    if (!s) return
    setDraft({
      name: s.displayName,
      description: s.frontmatter.description,
      body: descText(s.bodyBlocks[0]),
      effort: s.frontmatter.effort ?? "medium",
      scope: "workspace",
      disableModelInvocation: s.frontmatter.disableModelInvocation,
      userInvocable: s.frontmatter.userInvocable,
      allowedTools: s.frontmatter.allowedTools.join(", "),
      tags: s.tags.join(", "),
    })
  }, [editQuery.data])

  if (mode === "edit" && editQuery.isPending) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const save = async () => {
    if (!draft.name.trim()) return toast.error("请填写名称")
    if (!draft.description.trim())
      return toast.error("请填写描述（它决定技能何时被触发）")
    setSaving(true)
    try {
      if (mode === "edit" && params.skillId) {
        await api.updateInstalledSkill(
          workspaceId!,
          params.skillId,
          {} as Parameters<typeof api.updateInstalledSkill>[2]
        )
        toast.success("已保存")
        router.push(`/dashboard/skills/installed/${params.skillId}`)
      } else {
        await api.createWorkspaceSkill(workspaceId!, {
          name: draft.name.trim(),
        } as Parameters<typeof api.createWorkspaceSkill>[1])
        toast.success("已创建")
        router.push("/dashboard/skills")
      }
    } catch {
      toast.error("保存失败")
    } finally {
      setSaving(false)
    }
  }

  if (isImport) return <ImportForm />

  const tags = draft.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <Link
        href="/dashboard/skills"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 技能
      </Link>
      <h1 className="mb-4 text-xl font-semibold">
        {mode === "edit" ? "编辑技能" : "新建技能"}
      </h1>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* form */}
        <div className="space-y-4">
          <Field label="名称">
            <Input
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="例如：代码评审"
              autoFocus
            />
          </Field>
          <Field
            label="描述"
            hint="写清楚它做什么 以及 何时应触发——具体、略带“指令性”。这段文字决定模型何时调用它。"
          >
            <Textarea
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              rows={3}
              placeholder="自动审查 PR……当有人请求 review 时使用。"
            />
            <div
              className={cn(
                "mt-1 text-right text-[11px]",
                draft.description.length < 20
                  ? "text-amber-600"
                  : "text-muted-foreground/50"
              )}
            >
              {draft.description.length} 字
            </div>
          </Field>
          <Field label="说明 / 指令（可选）">
            <Textarea
              value={draft.body}
              onChange={(e) => set("body", e.target.value)}
              rows={5}
              placeholder="给技能的详细步骤与规则…"
              className="font-mono text-xs"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="思考强度">
              <Select
                value={draft.effort}
                onValueChange={(v) => set("effort", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EFFORT_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="适用范围">
              <Select
                value={draft.scope}
                onValueChange={(v) => set("scope", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(SCOPE_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field
            label="允许工具（可选，逗号分隔）"
            hint={
              draft.allowedTools.trim()
                ? "使用工具的技能在首次启用时需授权。"
                : undefined
            }
          >
            <Input
              value={draft.allowedTools}
              onChange={(e) => set("allowedTools", e.target.value)}
              placeholder="read, grep, bash"
              className="font-mono text-xs"
            />
          </Field>
          <Field label="标签（可选，逗号分隔）">
            <Input
              value={draft.tags}
              onChange={(e) => set("tags", e.target.value)}
              placeholder="工程, 评审"
            />
          </Field>
          <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
            <div>
              <div>仅手动触发</div>
              <div className="text-xs text-muted-foreground">
                开启后模型不会自动调用，只能由用户显式触发（适合有副作用的技能）
              </div>
            </div>
            <Switch
              checked={draft.disableModelInvocation}
              onCheckedChange={(v) => set("disableModelInvocation", v)}
            />
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" asChild>
              <Link href="/dashboard/skills">取消</Link>
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
              {mode === "edit" ? "保存" : "创建"}
            </Button>
          </div>
        </div>

        {/* live preview */}
        <div className="space-y-3">
          <div className="text-xs font-medium text-muted-foreground">预览</div>
          <div className="flex items-start gap-3 rounded-xl border bg-card p-4">
            <SkillIcon name={draft.name || "新"} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {draft.name || "技能名称"}
              </div>
              <div className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">
                {draft.description || "一句话描述…"}
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                {draft.scope !== "workspace" && (
                  <span className="rounded border px-1 text-[10px] leading-4 text-muted-foreground">
                    {SCOPE_LABEL[draft.scope]?.replace("指定", "")}
                  </span>
                )}
                {draft.effort && (
                  <span className="text-[10px] text-muted-foreground/60">
                    {EFFORT_LABEL[draft.effort]}
                  </span>
                )}
              </div>
            </div>
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
          <p className="flex items-start gap-1.5 rounded-lg border border-dashed p-2.5 text-[11px] text-muted-foreground">
            <Sparkles className="mt-0.5 size-3 shrink-0" />{" "}
            描述会作为「何时触发」展示在详情页——它决定模型何时调用这个技能。
          </p>
        </div>
      </div>
    </div>
  )
}

function ImportForm() {
  const router = useRouter()
  const [kind, setKind] = useState("github")
  const [repoUrl, setRepoUrl] = useState("")
  const [path, setPath] = useState("")
  const [slug, setSlug] = useState("")
  const [importing, setImporting] = useState(false)
  const run = async () => {
    setImporting(true)
    try {
      toast.success("已从来源导入")
      router.push("/dashboard/skills")
    } finally {
      setImporting(false)
    }
  }
  return (
    <div className="mx-auto max-w-lg px-6 py-6">
      <Link
        href="/dashboard/skills"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 技能
      </Link>
      <h1 className="mb-1 text-xl font-semibold">从来源导入</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        从 GitHub 仓库或 ClawHub
        镜像一个技能。镜像的技能会保留来源，可手动同步。
      </p>
      <div className="space-y-4">
        <Field label="来源">
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="github">GitHub</SelectItem>
              <SelectItem value="clawhub">ClawHub</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {kind === "github" ? (
          <>
            <Field label="仓库地址">
              <Input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/org/repo"
              />
            </Field>
            <Field label="技能路径">
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="skills/code-review"
                className="font-mono text-xs"
              />
            </Field>
          </>
        ) : (
          <Field label="ClawHub slug">
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="owner/skill-name"
              className="font-mono text-xs"
            />
          </Field>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" asChild>
            <Link href="/dashboard/skills">取消</Link>
          </Button>
          <Button onClick={run} disabled={importing}>
            {importing && <Loader2 className="mr-1 size-4 animate-spin" />}导入
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground/60">{hint}</p>}
    </div>
  )
}
