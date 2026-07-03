"use client"

// Event Sources registry admin (master-detail): the reusable event catalog with
// its own lifecycle, occurrence log, integration binding, and webhook URL/secret
// — the concerns that don't belong inside a single rule's editor. Register-new
// is reachable here and inline from the rule editor's event branch.
import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { GitBranch, Plus, Radio, Webhook } from "lucide-react"
import { toast } from "sonner"
import type { AutomationEventSource } from "@synapse/shared"
import { api } from "@/lib/api"
import { qk } from "@/lib/query-keys"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  PROVIDER_KIND_LABEL,
  SOURCE_STATUS_LABEL,
  formatInstant,
} from "@/lib/automation/describe"
import {
  designWebhookEndpoints,
  sourceSubscriberCount,
} from "@/lib/design/fixtures/automation"
import { WebhookPanel } from "./webhook-panel"
import { OccurrencesLog } from "./occurrences-log"
import { SourceRegisterDialog } from "./source-register-dialog"

const STATUS_TONE: Record<string, string> = {
  active: "text-emerald-600",
  deprecated: "text-amber-600",
  disabled: "text-muted-foreground",
  archived: "text-muted-foreground",
}
const PROVIDER_ICON: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  integration: GitBranch,
  webhook: Webhook,
  internal: Radio,
  device: Radio,
}

export function EventSourcesTab({
  sources,
}: {
  sources: AutomationEventSource[]
}) {
  const { workspaceId } = useWorkspace()
  const [providerFilter, setProviderFilter] = useState("all")
  const [selectedId, setSelectedId] = useState<string | undefined>(
    sources[0]?.id
  )
  const [registerOpen, setRegisterOpen] = useState(false)

  const visible = useMemo(
    () =>
      sources.filter(
        (s) => providerFilter === "all" || s.providerKind === providerFilter
      ),
    [sources, providerFilter]
  )
  useEffect(() => {
    if (!visible.find((s) => s.id === selectedId)) setSelectedId(visible[0]?.id)
  }, [visible, selectedId])
  const selected = sources.find((s) => s.id === selectedId)

  const occurrencesQuery = useQuery({
    queryKey:
      workspaceId && selectedId
        ? [...qk.automationEventSources(workspaceId), selectedId, "occurrences"]
        : ["occ", "none"],
    queryFn: () =>
      api.getAutomationEventSourceOccurrences(workspaceId!, selectedId!),
    enabled: !!workspaceId && !!selectedId,
  })

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Select value={providerFilter} onValueChange={setProviderFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部来源</SelectItem>
            <SelectItem value="integration">集成</SelectItem>
            <SelectItem value="webhook">Webhook</SelectItem>
            <SelectItem value="internal">内部</SelectItem>
            <SelectItem value="device">设备</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" onClick={() => setRegisterOpen(true)}>
          <Plus className="mr-1 size-4" />
          注册事件源
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
        {/* list */}
        <div className="divide-y overflow-hidden rounded-xl border">
          {visible.map((s) => {
            const Icon = PROVIDER_ICON[s.providerKind] ?? Radio
            const subs = sourceSubscriberCount(s.id)
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedId(s.id)}
                className={cn(
                  "flex w-full items-start gap-2.5 p-3 text-left transition-colors hover:bg-accent/40",
                  s.id === selectedId && "bg-accent/50"
                )}
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {s.name}
                    </span>
                    <span className={cn("text-[10px]", STATUS_TONE[s.status])}>
                      {SOURCE_STATUS_LABEL[s.status]}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground/70">
                    {PROVIDER_KIND_LABEL[s.providerKind]} · {subs} 条规则订阅
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        {/* detail */}
        {selected ? (
          <SourceDetail
            source={selected}
            occurrences={occurrencesQuery.data ?? []}
            subscribers={sourceSubscriberCount(selected.id)}
            onLifecycle={async (status) => {
              if (!workspaceId) return
              const subs = sourceSubscriberCount(selected.id)
              if (
                (status === "deprecated" || status === "disabled") &&
                subs > 0
              )
                toast.warning(`有 ${subs} 条规则在用此源`, {
                  description: "已存在的规则仍会继续工作。",
                })
              try {
                if (status === "archived")
                  await api.archiveAutomationEventSource(
                    workspaceId,
                    selected.id
                  )
                else
                  await api.updateAutomationEventSource(
                    workspaceId,
                    selected.id,
                    { status }
                  )
                toast.success("已更新事件源状态")
              } catch {
                toast.error("操作失败")
              }
            }}
          />
        ) : (
          <div className="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
            选择一个事件源查看详情
          </div>
        )}
      </div>

      <SourceRegisterDialog
        open={registerOpen}
        onOpenChange={setRegisterOpen}
      />
    </div>
  )
}

function SourceDetail({
  source,
  occurrences,
  subscribers,
  onLifecycle,
}: {
  source: AutomationEventSource
  occurrences: import("@synapse/shared").AutomationOccurrence[]
  subscribers: number
  onLifecycle: (status: AutomationEventSource["status"]) => void
}) {
  const endpoint = source.providerRef
    ? designWebhookEndpoints[source.providerRef]
    : undefined
  const lifecycleActions: {
    status: AutomationEventSource["status"]
    label: string
  }[] =
    source.status === "active"
      ? [
          { status: "deprecated", label: "标记弃用" },
          { status: "disabled", label: "停用" },
        ]
      : source.status === "deprecated"
        ? [
            { status: "active", label: "重新启用" },
            { status: "disabled", label: "停用" },
          ]
        : source.status === "disabled"
          ? [{ status: "active", label: "重新启用" }]
          : []

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold">{source.name}</h3>
            <Badge variant="secondary" className="text-[10px]">
              {PROVIDER_KIND_LABEL[source.providerKind]}
            </Badge>
            <span className={cn("text-xs", STATUS_TONE[source.status])}>
              {SOURCE_STATUS_LABEL[source.status]}
            </span>
          </div>
          {source.description && (
            <p className="mt-1 text-sm text-muted-foreground">
              {source.description}
            </p>
          )}
          <div className="mt-1 text-xs text-muted-foreground/70">
            <code className="font-mono">{source.sourceKey}</code> ·{" "}
            {subscribers} 条规则订阅
            {source.lastTriggeredAt && (
              <> · 上次 {formatInstant(source.lastTriggeredAt)}</>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {lifecycleActions.map((a) => (
            <Button
              key={a.status}
              variant="outline"
              size="sm"
              onClick={() => onLifecycle(a.status)}
            >
              {a.label}
            </Button>
          ))}
          {source.status !== "archived" && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => onLifecycle("archived")}
            >
              归档
            </Button>
          )}
        </div>
      </div>

      {source.integration && (
        <div className="rounded-lg border bg-muted/20 p-3 text-sm">
          <div className="text-xs text-muted-foreground">集成绑定</div>
          <div className="mt-0.5">
            {source.integration.provider} · {source.integration.targetLabel}
            <span className="ml-2 text-xs text-primary hover:underline">
              重新连接
            </span>
          </div>
        </div>
      )}

      {source.providerKind === "webhook" && (
        <WebhookPanel source={source} endpoint={endpoint} />
      )}

      <div>
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">
          示例 payload
        </div>
        <pre className="max-h-48 overflow-auto rounded-lg border bg-muted/20 px-3 py-2 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(source.examplePayload, null, 2)}
        </pre>
      </div>

      <div>
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">
          事件记录（{occurrences.length}）
        </div>
        <OccurrencesLog occurrences={occurrences} />
      </div>
    </div>
  )
}
