"use client"

// The unified Automations surface: two peer tabs (Rules authoring/list + the
// Event Sources registry) on one route — the literal merge of the old Triggers
// and Event Sources pages. Phase 1 focuses on the Rules authoring flow.
import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Bell, Plus, Search, Sparkles } from "lucide-react"
import { toast } from "sonner"
import type { AutomationRule } from "@synapse/shared"
import type { AutomationRuleCreateInput } from "@synapse/shared/schemas"
import { api } from "@/lib/api"
import { qk } from "@/lib/query-keys"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { RuleCard } from "./rule-card"
import { RuleEditor, type ConversationOption } from "./rule-editor"
import { EventSourcesTab } from "./event-sources-tab"

export function AutomationsClient() {
  const { workspaceId } = useWorkspace()
  const queryClient = useQueryClient()

  const rulesQuery = useQuery({
    queryKey: workspaceId
      ? qk.automations(workspaceId)
      : ["automations", "none"],
    queryFn: () => api.getAutomations(workspaceId!),
    enabled: !!workspaceId,
  })
  const sourcesQuery = useQuery({
    queryKey: workspaceId
      ? qk.automationEventSources(workspaceId)
      : ["event-sources", "none"],
    queryFn: () => api.getAutomationEventSources(workspaceId!),
    enabled: !!workspaceId,
  })
  const bootstrapQuery = useQuery({
    queryKey: workspaceId
      ? [...qk.workspace(workspaceId), "chat-bootstrap"]
      : ["cb", "none"],
    queryFn: () => api.getChatBootstrap(workspaceId!),
    enabled: !!workspaceId,
  })

  const rules = rulesQuery.data ?? []
  const sources = sourcesQuery.data ?? []
  const conversations: ConversationOption[] = useMemo(
    () =>
      (bootstrapQuery.data?.conversations ?? []).map((c) => ({
        id: c.conversationId,
        name: c.title,
        members: (c.participants ?? []).map((p) => ({
          id: p.participantId,
          name: p.name || "成员",
        })),
      })),
    [bootstrapQuery.data]
  )
  const convName = (id: string) => conversations.find((c) => c.id === id)?.name

  // filters
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("all")
  const [category, setCategory] = useState("all")
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rules.filter((r) => {
      if (status !== "all" && r.status !== status) return false
      if (category !== "all" && r.category !== category) return false
      if (
        needle &&
        !`${r.name} ${r.delivery.messageText} ${r.trigger.eventSourceName ?? ""}`
          .toLowerCase()
          .includes(needle)
      )
        return false
      return true
    })
  }, [rules, q, status, category])

  // editor + delete
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<AutomationRule | undefined>()
  const [deleteTarget, setDeleteTarget] = useState<AutomationRule | null>(null)

  const invalidate = () =>
    workspaceId &&
    queryClient.invalidateQueries({ queryKey: qk.automations(workspaceId) })

  const submit = async (input: AutomationRuleCreateInput) => {
    if (!workspaceId) return
    if (editing) await api.updateAutomation(workspaceId, editing.id, input)
    else await api.createAutomation(workspaceId, input)
    invalidate()
  }
  const toggle = async (rule: AutomationRule, next: "active" | "paused") => {
    if (!workspaceId) return
    try {
      await api.updateAutomation(workspaceId, rule.id, { status: next })
      invalidate()
      toast.success(next === "active" ? "已启用" : "已暂停")
    } catch {
      toast.error("操作失败")
    }
  }
  const doDelete = async () => {
    if (!workspaceId || !deleteTarget) return
    try {
      await api.deleteAutomation(workspaceId, deleteTarget.id)
      invalidate()
      toast.success("已删除")
    } catch {
      toast.error("删除失败")
    } finally {
      setDeleteTarget(null)
    }
  }

  const openNew = () => {
    setEditing(undefined)
    setEditorOpen(true)
  }
  const openEdit = (rule: AutomationRule) => {
    setEditing(rule)
    setEditorOpen(true)
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">自动化</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            定时与事件驱动的消息
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-1 size-4" />
          新建自动化
        </Button>
      </div>

      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules">规则</TabsTrigger>
          <TabsTrigger value="sources">
            <Bell className="mr-1 size-3.5" />
            事件源
          </TabsTrigger>
        </TabsList>

        <TabsContent value="rules" className="mt-4">
          {/* filters */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索名称、消息、事件源…"
                className="pl-8"
              />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="active">运行中</SelectItem>
                <SelectItem value="paused">已暂停</SelectItem>
                <SelectItem value="error">出错</SelectItem>
                <SelectItem value="completed">已完成</SelectItem>
              </SelectContent>
            </Select>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                <SelectItem value="schedule">定时</SelectItem>
                <SelectItem value="event_subscription">事件</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {rules.length === 0 && !rulesQuery.isPending ? (
            <EmptyState onNew={openNew} />
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
              没有匹配的自动化
            </div>
          ) : (
            <div className="space-y-2.5">
              {filtered.map((rule) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  conversationName={convName(rule.conversationId)}
                  onEdit={() => openEdit(rule)}
                  onToggle={(next) => toggle(rule, next)}
                  onDelete={() => setDeleteTarget(rule)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="sources" className="mt-4">
          <EventSourcesTab sources={sources} />
        </TabsContent>
      </Tabs>

      <RuleEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        initial={editing}
        conversations={conversations}
        sources={sources}
        onSubmit={submit}
      />

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除自动化</DialogTitle>
            <DialogDescription>
              确定删除「{deleteTarget?.name}」？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={doDelete}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="rounded-xl border border-dashed py-16 text-center">
      <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="size-6" />
      </div>
      <div className="text-sm font-medium">还没有自动化</div>
      <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
        用一个常用场景快速开始：每天提醒、工作日站会、GitHub 推送通知…
      </p>
      <Button className="mt-4" onClick={onNew}>
        <Plus className="mr-1 size-4" />
        新建自动化
      </Button>
    </div>
  )
}
