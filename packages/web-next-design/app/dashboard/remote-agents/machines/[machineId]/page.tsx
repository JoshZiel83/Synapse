"use client"

// Machine (daemon/host) detail — summary header (trust · liveness · last-seen ·
// hosted counts), the runtime catalog (which agent binaries are installed + their
// status), and the hosted-agent list (reconciled: a child agent under an offline/
// untrusted host never reads live-green). Trust mutation has no API — displayed,
// not faked. A collapsed debug block holds ids/timestamps.
import { useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, ChevronDown, ChevronRight, Loader2 } from "lucide-react"
import type { RemoteAgentRuntimeKind } from "@synapse/shared"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { RuntimeKindIcon } from "@/components/runtime-kind-icon"
import {
  formatRelative,
  livenessDot,
  runtimeKindLabel,
  shortPath,
  trustMeta,
} from "@/lib/remote-agent-status"

const CATALOG_META: Record<string, { label: string; className: string }> = {
  available: { label: "可用", className: "text-emerald-600" },
  missing_binary: { label: "未安装", className: "text-muted-foreground" },
  broken_path: { label: "路径无效", className: "text-amber-600" },
  unsupported_platform: {
    label: "平台不支持",
    className: "text-muted-foreground",
  },
  runtime_error: { label: "运行时错误", className: "text-red-600" },
}

export default function MachineDetailPage() {
  const { workspaceId } = useWorkspace()
  const params = useParams<{ machineId: string }>()
  const id = params.machineId
  const [debugOpen, setDebugOpen] = useState(false)

  const detailQuery = useQuery({
    queryKey: ["remote-agent-machine", workspaceId, id],
    queryFn: () => api.getRemoteAgentMachine(workspaceId!, id),
    enabled: !!workspaceId && !!id,
    refetchInterval: 15000,
  })
  const detail = detailQuery.data

  if (detailQuery.isPending || !detail) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const { machine, runtimeCatalog, bindings } = detail
  const trust = trustMeta(machine.trustStatus)
  const online = machine.lifecycleState === "online"

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <Link
        href="/dashboard/remote-agents/machines"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 主机
      </Link>

      {/* header */}
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-1.5 size-2.5 shrink-0 rounded-full",
            livenessDot(online)
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold">{machine.title}</h1>
            <span
              className={cn(
                "shrink-0 rounded border px-1.5 py-0.5 text-[11px]",
                trust.className
              )}
            >
              {trust.label}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {online ? "在线" : "离线"} · 活跃于{" "}
            {formatRelative(machine.lastSeenAt)} · {bindings.length} 个 Agent ·{" "}
            {runtimeCatalog.length} 个运行时
          </p>
          {machine.description && (
            <p className="text-xs text-muted-foreground/70">
              {machine.description}
            </p>
          )}
        </div>
      </div>

      <div className="mt-6 space-y-5">
        {/* runtime catalog */}
        <section>
          <h2 className="mb-2 text-sm font-medium">运行时清单</h2>
          <div className="divide-y rounded-lg border">
            {runtimeCatalog.map((c) => {
              const meta = CATALOG_META[c.status] ?? {
                label: c.status,
                className: "text-muted-foreground",
              }
              return (
                <div
                  key={c.runtimeKind}
                  className="flex items-center gap-3 px-3 py-2.5 text-sm"
                >
                  <RuntimeKindIcon
                    kind={c.runtimeKind as RemoteAgentRuntimeKind}
                    className="size-4 text-muted-foreground/70"
                  />
                  <span className="font-medium">
                    {runtimeKindLabel(c.runtimeKind)}
                  </span>
                  {c.version && (
                    <span className="text-xs text-muted-foreground">
                      v{c.version}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1.5">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        c.status === "available"
                          ? "bg-emerald-500"
                          : c.status === "runtime_error"
                            ? "bg-red-500"
                            : "bg-muted-foreground/40"
                      )}
                    />
                    <span className={cn("text-xs", meta.className)}>
                      {meta.label}
                    </span>
                  </span>
                </div>
              )
            })}
          </div>
        </section>

        {/* hosted agents (reconciled) */}
        <section>
          <h2 className="mb-2 text-sm font-medium">
            托管的 Agent（{bindings.length}）
          </h2>
          {bindings.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
              这台主机还没有绑定 Agent
            </p>
          ) : (
            <div className="space-y-2">
              {bindings.map((bd) => {
                // reconcile: child status defers to the host
                const hostDown = !online || machine.trustStatus !== "active"
                const label = hostDown
                  ? online
                    ? "主机未信任"
                    : "主机离线"
                  : bd.runtimeSummary?.state === "running"
                    ? "运行中"
                    : bd.runtimeSummary?.state === "error"
                      ? "出错"
                      : "空闲"
                return (
                  <Link
                    key={bd.remoteAgentId}
                    href={`/dashboard/remote-agents/agents/${bd.remoteAgentId}`}
                    className="flex items-center gap-3 rounded-xl border p-3 transition-colors hover:border-foreground/20"
                  >
                    <RuntimeKindIcon
                      kind={bd.runtimeKind as RemoteAgentRuntimeKind}
                      className="size-4 shrink-0 text-muted-foreground/70"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {bd.displayName}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {bd.localRootPath ? (
                          <code className="font-mono text-muted-foreground/60">
                            {shortPath(bd.localRootPath)}
                          </code>
                        ) : (
                          "仓库根目录（默认）"
                        )}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 text-xs",
                        label === "出错"
                          ? "text-red-600"
                          : "text-muted-foreground"
                      )}
                    >
                      {label}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground/40" />
                  </Link>
                )
              })}
            </div>
          )}
        </section>

        {/* debug */}
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
              <div>id: {machine.id}</div>
              <div>createdAt: {machine.createdAt ?? "—"}</div>
              <div>updatedAt: {machine.updatedAt ?? "—"}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
