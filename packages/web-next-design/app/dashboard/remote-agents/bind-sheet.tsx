"use client"

// 改绑定 — point an agent at a machine + a working directory. Validated pickers:
// only trusted machines are selectable (offline flagged), and the chosen runtime
// is cross-checked against that machine's runtime catalog (warn + block if not
// installed). Renders the binding as a constrained editor, not raw fields.
import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import type {
  RemoteAgentView,
  RemoteAgentMachineView,
  RemoteAgentRuntimeKind,
} from "@synapse/shared"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { RuntimeKindIcon } from "@/components/runtime-kind-icon"

export function BindSheet({
  open,
  onOpenChange,
  agent,
  machines,
  workspaceId,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  agent: RemoteAgentView
  machines: RemoteAgentMachineView[]
  workspaceId: string
}) {
  const qc = useQueryClient()
  const [machineId, setMachineId] = useState(agent.binding?.machineId ?? "")
  const [runtimeKind, setRuntimeKind] = useState<RemoteAgentRuntimeKind>(
    agent.runtimeKind
  )
  const [runtimePath, setRuntimePath] = useState(
    agent.binding?.runtimePath ?? ""
  )
  const [localRootPath, setLocalRootPath] = useState(
    agent.binding?.localRootPath ?? ""
  )
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setMachineId(agent.binding?.machineId ?? "")
      setRuntimeKind(agent.runtimeKind)
      setRuntimePath(agent.binding?.runtimePath ?? "")
      setLocalRootPath(agent.binding?.localRootPath ?? "")
    }
  }, [open, agent])

  const selectable = machines.filter((m) => m.trustStatus === "active")
  const detailQuery = useQuery({
    queryKey: ["remote-agent-machine", workspaceId, machineId],
    queryFn: () => api.getRemoteAgentMachine(workspaceId, machineId),
    enabled: open && !!machineId,
  })
  const catalog = detailQuery.data?.runtimeCatalog ?? []
  const runtimeAvailable = useMemo(
    () =>
      catalog.find((c) => c.runtimeKind === runtimeKind)?.status ===
      "available",
    [catalog, runtimeKind]
  )
  const runtimeChecked = catalog.length > 0

  const save = async () => {
    if (!machineId) return toast.error("请选择主机")
    if (runtimeChecked && !runtimeAvailable) return
    setSaving(true)
    try {
      await api.bindRemoteAgent(workspaceId, agent.id, {
        machineId,
        runtimeKind,
        runtimePath: runtimePath.trim() || undefined,
        localRootPath: localRootPath.trim() || undefined,
      })
      qc.invalidateQueries({ queryKey: ["remote-agents", workspaceId] })
      qc.invalidateQueries({
        queryKey: ["remote-agent", workspaceId, agent.id],
      })
      toast.success("已更新绑定")
      onOpenChange(false)
    } catch {
      toast.error("绑定失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>绑定 · {agent.displayName}</SheetTitle>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">主机</Label>
            <Select value={machineId} onValueChange={setMachineId}>
              <SelectTrigger>
                <SelectValue placeholder="选择一台已信任的主机" />
              </SelectTrigger>
              <SelectContent>
                {selectable.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.title}
                    {m.lifecycleState === "offline" && (
                      <span className="ml-1 text-muted-foreground">· 离线</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectable.length === 0 && (
              <p className="text-[11px] text-amber-600">
                没有已信任的主机 · 先配对一台
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">运行时</Label>
            <Select
              value={runtimeKind}
              onValueChange={(v) => setRuntimeKind(v as RemoteAgentRuntimeKind)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude_code">
                  <span className="flex items-center gap-2">
                    <RuntimeKindIcon kind="claude_code" className="size-3.5" />{" "}
                    Claude Code
                  </span>
                </SelectItem>
                <SelectItem value="codex">
                  <span className="flex items-center gap-2">
                    <RuntimeKindIcon kind="codex" className="size-3.5" /> Codex
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            {machineId && runtimeChecked && !runtimeAvailable && (
              <p className="flex items-center gap-1 text-[11px] text-amber-600">
                <TriangleAlert className="size-3" />
                该主机上未安装此运行时
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              工作目录（localRootPath）
            </Label>
            <Input
              value={localRootPath}
              onChange={(e) => setLocalRootPath(e.target.value)}
              placeholder="留空 = 仓库根目录"
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              运行时路径（可选）
            </Label>
            <Input
              value={runtimePath}
              onChange={(e) => setRuntimePath(e.target.value)}
              placeholder={
                catalog.find((c) => c.runtimeKind === runtimeKind)
                  ?.executablePath ?? "自动检测"
              }
              className="font-mono text-xs"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={save}
            disabled={
              saving || !machineId || (runtimeChecked && !runtimeAvailable)
            }
          >
            {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
            保存绑定
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
