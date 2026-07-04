"use client"

// Skill detail — one shared skeleton for both surfaces (installed / marketplace),
// sectioned not over-tabbed. The load-bearing block is 「何时触发」 (the description
// IS the trigger contract). Elevated capabilities (allowedTools) get a consent
// note. Provenance + sync are the quiet home for the one status accent. Reuses the
// card's icon + label helpers so detail reads identically to the grid.
import { useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowLeft,
  ChevronDown,
  Pencil,
  Loader2,
  Sparkles,
  TriangleAlert,
} from "lucide-react"
import { toast } from "sonner"
import type {
  InstalledSkillView,
  SkillMarketplaceEntryView,
  SkillFrontmatterView,
} from "@synapse/shared"
import { api } from "@/lib/api"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { descText, scopeLabel, sourceLabel, SkillIcon } from "./skill-card"

const EFFORT: Record<string, string> = {
  low: "轻",
  medium: "中",
  high: "重",
  max: "极重",
}
const SYNC: Record<string, string> = {
  pending: "同步中…",
  synced: "已同步",
  error: "同步失败",
}

function Loading() {
  return (
    <div className="flex justify-center py-24">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  )
}

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}
function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

// ── shared body: trigger + overview + invocation/permissions ─────────────────
function CommonSections({
  fm,
  body,
}: {
  fm: SkillFrontmatterView
  body: string
}) {
  return (
    <>
      <Section title="何时触发">
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
          <p className="text-sm">{fm.description}</p>
        </div>
      </Section>

      {body && body !== fm.description && (
        <Section title="说明">
          <p className="text-sm whitespace-pre-line text-foreground/80">
            {body}
          </p>
        </Section>
      )}

      <Section title="调用与权限">
        <div className="space-y-1.5">
          <Row label="调用方式">
            {fm.disableModelInvocation
              ? "仅手动（用户触发）"
              : "自动 · 模型可按需调用"}
            {fm.userInvocable && (
              <span className="text-muted-foreground"> · 用户也可手动触发</span>
            )}
          </Row>
          {fm.model && <Row label="模型">{fm.model}</Row>}
          {fm.effort && <Row label="思考强度">{EFFORT[fm.effort]}</Row>}
          <Row label="允许工具">
            {fm.allowedTools.length ? (
              <span className="flex flex-wrap gap-1">
                {fm.allowedTools.map((t) => (
                  <code
                    key={t}
                    className="rounded bg-muted px-1 py-0.5 text-[11px]"
                  >
                    {t}
                  </code>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground">无额外工具</span>
            )}
          </Row>
          {fm.allowedTools.length > 0 && (
            <p className="flex items-center gap-1 pt-0.5 text-[11px] text-amber-600">
              <TriangleAlert className="size-3" />{" "}
              该技能会用到上述工具，首次启用时需你确认授权。
            </p>
          )}
        </div>
      </Section>
    </>
  )
}

function SyncRow({ skill }: { skill: InstalledSkillView }) {
  const m = skill.mirrorSource
  if (!m) return null
  const error = m.lastSyncStatus === "error"
  return (
    <Row label="同步状态">
      <span className="flex items-center gap-2">
        <span className={error ? "text-red-600" : "text-muted-foreground"}>
          {SYNC[m.lastSyncStatus]}
        </span>
        {error && m.lastError && (
          <span className="text-xs text-muted-foreground">· {m.lastError}</span>
        )}
        <button
          onClick={() => toast.success("已开始同步")}
          className="text-xs text-primary hover:underline"
        >
          重新同步
        </button>
      </span>
    </Row>
  )
}

// ── installed detail ─────────────────────────────────────────────────────────
export function InstalledSkillDetail() {
  const { workspaceId } = useWorkspace()
  const { skillId } = useParams<{ skillId: string }>()
  const [debugOpen, setDebugOpen] = useState(false)
  const query = useQuery({
    queryKey: ["installed-skill", workspaceId, skillId],
    queryFn: () => api.getInstalledSkill(workspaceId!, skillId),
    enabled: !!workspaceId && !!skillId,
  })
  const skill = query.data?.skill
  if (query.isPending || !skill) return <Loading />

  const scope = scopeLabel(skill.accessTarget.subject)
  const src = sourceLabel(skill)
  const body = descText(skill.bodyBlocks[0])
  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <Link
        href="/dashboard/skills"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 技能
      </Link>

      <div className="flex items-start gap-4">
        <SkillIcon
          url={skill.iconUrl}
          name={skill.displayName}
          dimmed={!skill.isEnabled}
          className="size-14 rounded-2xl text-2xl"
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">
            {skill.displayName}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {scope && <span className="rounded border px-1">{scope}</span>}
            {src && <span className="rounded border px-1">{src}</span>}
            {skill.frontmatter.effort && (
              <span>{EFFORT[skill.frontmatter.effort]}</span>
            )}
            {!skill.isEnabled && <span>· 已停用</span>}
            {skill.upgradeAvailable && (
              <span className="text-amber-600">
                · 有更新 {skill.latestSourceVersion}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={skill.isEnabled}
            onCheckedChange={() =>
              toast.success(skill.isEnabled ? "已停用" : "已启用")
            }
            aria-label="启用"
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" asChild>
          <Link href={`/dashboard/skills/installed/${skill.id}/edit`}>
            <Pencil className="mr-1.5 size-4" /> 编辑
          </Link>
        </Button>
        {skill.upgradeAvailable && (
          <Button variant="outline" onClick={() => toast.success("已更新")}>
            更新到 {skill.latestSourceVersion}
          </Button>
        )}
        <Button
          variant="outline"
          className="text-red-600 hover:text-red-600"
          onClick={() => toast.message("卸载需确认（Phase 2.5）")}
        >
          卸载
        </Button>
      </div>

      {skill.isCustomized && skill.mirrorSource && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-xs text-amber-700 dark:bg-amber-500/5 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <div>本地已有修改。下次从来源同步时，这些改动会被覆盖。</div>
        </div>
      )}

      <div className="mt-6 space-y-5">
        <CommonSections fm={skill.frontmatter} body={body} />

        <Section title="适用范围">
          <div className="space-y-1.5">
            <Row label="范围">{scope ?? "整个工作区"}</Row>
            <Row label="会话类型">
              {skill.effectiveConversationTypeMask === 15
                ? "全部会话类型"
                : `掩码 ${skill.effectiveConversationTypeMask}`}
            </Row>
          </div>
        </Section>

        {(src || skill.mirrorSource) && (
          <Section title="来源与同步">
            <div className="space-y-1.5">
              <Row label="来源">{src ?? "本地"}</Row>
              {skill.sourceVersion && (
                <Row label="版本">{skill.sourceVersion}</Row>
              )}
              <SyncRow skill={skill} />
            </div>
          </Section>
        )}

        <div className="rounded-lg border">
          <button
            onClick={() => setDebugOpen((o) => !o)}
            className="flex w-full items-center gap-1 px-3 py-2.5 text-sm font-medium text-muted-foreground"
          >
            <ChevronDown
              className={cn("size-4 transition", debugOpen && "rotate-180")}
            />{" "}
            调试
          </button>
          {debugOpen && (
            <div className="space-y-1 border-t p-3 font-mono text-[11px] text-muted-foreground">
              <div>id: {skill.id}</div>
              <div>entryPath: {skill.entryPath}</div>
              <div>contentHash: {skill.contentHash}</div>
              <div>updatedAt: {skill.updatedAt}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── marketplace detail ───────────────────────────────────────────────────────
export function MarketSkillDetail() {
  const { workspaceId } = useWorkspace()
  const { skillId } = useParams<{ skillId: string }>()
  const query = useQuery({
    queryKey: ["market-skill", workspaceId, skillId],
    queryFn: () => api.getSkillMarketplaceItem(workspaceId!, skillId),
    enabled: !!workspaceId && !!skillId,
  })
  const skill = query.data?.skill as SkillMarketplaceEntryView | undefined
  if (query.isPending || !skill) return <Loading />

  const src =
    skill.mirrorSource?.sourceType === "github"
      ? "GitHub"
      : skill.mirrorSource?.sourceType === "clawhub"
        ? "ClawHub"
        : "市场"
  const body = descText(skill.bodyBlocks[0])
  const installed = skill.workspaceInstallation?.installed
  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <Link
        href="/dashboard/skills"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 技能
      </Link>

      <div className="flex items-start gap-4">
        <SkillIcon
          url={skill.iconUrl}
          name={skill.name}
          className="size-14 rounded-2xl text-2xl"
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">{skill.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="rounded border px-1">{src}</span>
            {skill.authorName && <span>{skill.authorName}</span>}
            {(skill.workspaceInstallation?.installedCount ?? 0) > 0 && (
              <span>
                · {skill.workspaceInstallation!.installedCount} 次安装
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0">
          {installed ? (
            <Button variant="ghost" asChild className="text-muted-foreground">
              <Link href={`/dashboard/skills/installed/sk-${skill.slug}`}>
                已安装
              </Link>
            </Button>
          ) : (
            <Button onClick={() => toast.success(`已安装「${skill.name}」`)}>
              安装
            </Button>
          )}
        </div>
      </div>

      <div className="mt-6 space-y-5">
        <CommonSections fm={skill.frontmatter} body={body} />
        <Section title="来源">
          <div className="space-y-1.5">
            <Row label="来源">{src}</Row>
            {skill.authorName && <Row label="作者">{skill.authorName}</Row>}
            {skill.latestVersion?.version && (
              <Row label="最新版本">{skill.latestVersion.version}</Row>
            )}
          </div>
        </Section>
      </div>
    </div>
  )
}
