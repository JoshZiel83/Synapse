"use client"

// The card system for the Skills grid — one shared shell, two variants (installed
// / marketplace) differing only in the primary action. Quiet by design
// (impeccable · 10% rule): neutral-dominant, ≤2 muted meta chips, and at most ONE
// colored status per card (amber 有更新 OR red 同步失败). Uniform height via
// line-clamp + a fixed icon tile so CJK never raggeds the grid.
import Link from "next/link"
import { MoreHorizontal, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import type {
  InstalledSkillView,
  SkillMarketplaceEntryView,
} from "@synapse/shared"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// ── helpers (exported for filters/hub) ───────────────────────────────────────
export function descText(block: unknown): string {
  const b = block as { type?: string; text?: string }
  return b?.type === "text" && b.text ? b.text : ""
}
export function scopeLabel(
  subject: InstalledSkillView["accessTarget"]["subject"]
): string | null {
  switch ((subject as { kind: string }).kind) {
    case "workspace_member":
      return "成员"
    case "conversation":
      return "会话"
    case "actor":
      return "智能体"
    case "remote_agent":
      return "远程 Agent"
    default:
      return null // workspace default — hidden to reduce noise
  }
}
export function sourceLabel(s: InstalledSkillView): string | null {
  if (s.mirrorSource?.sourceType === "github") return "GitHub"
  if (s.mirrorSource?.sourceType === "clawhub") return "ClawHub"
  if (s.sourceSkillId || s.sourcePackageSlug) return "市场"
  return null // local — neutral default, no chip
}
const EFFORT: Record<string, string> = {
  low: "轻",
  medium: "中",
  high: "重",
  max: "极重",
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border px-1 py-0 text-[10px] leading-4 text-muted-foreground">
      {children}
    </span>
  )
}

export function SkillIcon({
  url,
  name,
  dimmed,
  className,
}: {
  url?: string
  name: string
  dimmed?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        "flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted text-base font-medium text-foreground/70",
        dimmed && "grayscale",
        className
      )}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="size-full object-cover" />
      ) : (
        (name.trim()[0] ?? "?")
      )}
    </span>
  )
}

function Shell({
  href,
  icon,
  name,
  desc,
  chips,
  action,
  dimmed,
}: {
  href: string
  icon: React.ReactNode
  name: string
  desc: string
  chips: React.ReactNode
  action: React.ReactNode
  dimmed?: boolean
}) {
  return (
    <div
      className={cn(
        "group relative flex items-start gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40",
        dimmed && "opacity-60"
      )}
    >
      {/* whole card is a link; the action sits above it */}
      <Link
        href={href}
        className="absolute inset-0 rounded-xl"
        aria-label={name}
      />
      {icon}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">
          {desc || "—"}
        </div>
        <div className="mt-2 flex items-center gap-1.5 overflow-hidden">
          {chips}
        </div>
      </div>
      <div className="relative z-10 shrink-0">{action}</div>
    </div>
  )
}

// ── installed variant ────────────────────────────────────────────────────────
export function InstalledSkillCard({ skill }: { skill: InstalledSkillView }) {
  const scope = scopeLabel(skill.accessTarget.subject)
  const src = sourceLabel(skill)
  const eff = skill.frontmatter.effort ? EFFORT[skill.frontmatter.effort] : null
  const syncError = skill.mirrorSource?.lastSyncStatus === "error"
  const href = `/dashboard/skills/installed/${skill.id}`
  return (
    <Shell
      href={href}
      dimmed={!skill.isEnabled}
      icon={
        <SkillIcon
          url={skill.iconUrl}
          name={skill.displayName}
          dimmed={!skill.isEnabled}
        />
      }
      name={skill.displayName}
      desc={descText(skill.description)}
      chips={
        <>
          {scope && <Chip>{scope}</Chip>}
          {src && <Chip>{src}</Chip>}
          {eff && (
            <span className="text-[10px] text-muted-foreground/60">{eff}</span>
          )}
          {!skill.isEnabled && (
            <span className="text-[10px] text-muted-foreground/60">已停用</span>
          )}
          {syncError ? (
            <span className="flex items-center gap-0.5 text-[10px] text-red-600">
              <TriangleAlert className="size-2.5" />
              同步失败
            </span>
          ) : skill.upgradeAvailable ? (
            <span className="text-[10px] text-amber-600">有更新</span>
          ) : null}
        </>
      }
      action={
        <div className="flex items-center gap-1">
          <Switch
            checked={skill.isEnabled}
            onCheckedChange={() =>
              toast.success(skill.isEnabled ? "已停用" : "已启用")
            }
            aria-label="启用"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="更多"
                className="rounded-lg p-1 text-muted-foreground/50 hover:bg-accent hover:text-foreground"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={href}>打开详情</Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`${href}/edit`}>编辑</Link>
              </DropdownMenuItem>
              {skill.mirrorSource && (
                <DropdownMenuItem onClick={() => toast.success("已开始同步")}>
                  立即同步
                </DropdownMenuItem>
              )}
              {skill.upgradeAvailable && (
                <DropdownMenuItem onClick={() => toast.success("已更新")}>
                  更新到 {skill.latestSourceVersion}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-600"
                onClick={() => toast.message("卸载需确认（Phase 2）")}
              >
                卸载
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    />
  )
}

// ── marketplace variant ──────────────────────────────────────────────────────
export function MarketSkillCard({
  skill,
}: {
  skill: SkillMarketplaceEntryView
}) {
  const installed = skill.workspaceInstallation?.installed
  const src =
    skill.mirrorSource?.sourceType === "github"
      ? "GitHub"
      : skill.mirrorSource?.sourceType === "clawhub"
        ? "ClawHub"
        : null
  const count = skill.workspaceInstallation?.installedCount ?? 0
  const href = `/dashboard/skills/marketplace/${skill.id}`
  return (
    <Shell
      href={href}
      icon={<SkillIcon url={skill.iconUrl} name={skill.name} />}
      name={skill.name}
      desc={descText(skill.description)}
      chips={
        <>
          {src && (
            <span className="shrink-0">
              <Chip>{src}</Chip>
            </span>
          )}
          {skill.authorName && (
            <span className="truncate text-[10px] text-muted-foreground/60">
              {skill.authorName}
            </span>
          )}
          {count > 0 && (
            <span className="shrink-0 text-[10px] whitespace-nowrap text-muted-foreground/50">
              · {count} 次安装
            </span>
          )}
        </>
      }
      action={
        installed ? (
          <Button
            variant="ghost"
            size="sm"
            asChild
            className="text-muted-foreground"
          >
            <Link href={`/dashboard/skills/installed/sk-${skill.slug}`}>
              已安装
            </Link>
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => toast.success(`已安装「${skill.name}」`)}
          >
            安装
          </Button>
        )
      }
    />
  )
}
