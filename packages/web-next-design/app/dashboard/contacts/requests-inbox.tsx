"use client"

// Requests inbox (right pane) — the 3 request types as ONE surface reached from a
// single badged "Requests" row, so pending never crowds the roster. Three
// segmented tabs (friend / actor-access / remote-agent-access), each splitting
// incoming (approve/reject, with trust context) from outgoing (pending/cancel).
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Cpu, Loader2, UserPlus } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

const K = (ws: string) => ["contact-requests", ws]

export function RequestsInbox({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient()
  const friend = useQuery({
    queryKey: [...K(workspaceId), "friend"],
    queryFn: () => api.getFriendRequests(workspaceId),
  })
  const actor = useQuery({
    queryKey: [...K(workspaceId), "actor"],
    queryFn: () => api.getActorAccessRequests(workspaceId),
  })
  const agent = useQuery({
    queryKey: [...K(workspaceId), "agent"],
    queryFn: () => api.getRemoteAgentAccessRequests(workspaceId),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: K(workspaceId) })
  const pending = <T extends { status: string }>(arr?: T[]): T[] =>
    (arr ?? []).filter((r) => r.status === "pending")

  const fIn = pending(friend.data?.incoming)
  const fOut = pending(friend.data?.outgoing)
  const aIn = pending(actor.data?.incoming)
  const aOut = pending(actor.data?.outgoing)
  const rIn = pending(agent.data?.incoming)
  const rOut = pending(agent.data?.outgoing)

  if (friend.isPending || actor.isPending || agent.isPending) {
    return (
      <div className="flex justify-center p-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">请求</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        好友、Actor 授权、远程 Agent 授权
      </p>

      <Tabs defaultValue="friend" className="mt-4">
        <TabsList>
          <TabsTrigger value="friend">
            好友{fIn.length > 0 && ` · ${fIn.length}`}
          </TabsTrigger>
          <TabsTrigger value="actor">
            Actor 授权{aIn.length > 0 && ` · ${aIn.length}`}
          </TabsTrigger>
          <TabsTrigger value="agent">
            远程 Agent{rIn.length > 0 && ` · ${rIn.length}`}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="friend" className="mt-4">
          <Queue
            incoming={fIn.map((r) => ({
              id: r.id,
              icon: UserPlus,
              title: r.requester?.name ?? "某人",
              detail: `想加你为好友${r.requester?.workspace?.name ? ` · 来自 ${r.requester.workspace.name}` : ""}`,
            }))}
            outgoing={fOut.map((r) => ({
              id: r.id,
              title: r.targetMember?.name ?? "对方",
              detail: "好友申请待通过",
            }))}
            onApprove={async (id) => {
              await api.approveFriendRequest(workspaceId, id)
              invalidate()
              toast.success("已通过")
            }}
            onReject={async (id) => {
              await api.rejectFriendRequest(workspaceId, id)
              invalidate()
              toast.success("已拒绝")
            }}
          />
        </TabsContent>

        <TabsContent value="actor" className="mt-4">
          <Queue
            incoming={aIn.map((r) => ({
              id: r.id,
              icon: Cpu,
              title: r.requester?.name ?? "某人",
              detail: `申请使用 Actor「${r.actor?.displayName ?? "?"}」`,
            }))}
            outgoing={aOut.map((r) => ({
              id: r.id,
              title: r.actor?.displayName ?? "Actor",
              detail: "授权申请待通过",
            }))}
            onApprove={async (id) => {
              await api.approveActorAccessRequest(workspaceId, id)
              invalidate()
              toast.success("已授权")
            }}
            onReject={async (id) => {
              await api.rejectActorAccessRequest(workspaceId, id)
              invalidate()
              toast.success("已拒绝")
            }}
          />
        </TabsContent>

        <TabsContent value="agent" className="mt-4">
          <Queue
            incoming={rIn.map((r) => ({
              id: r.id,
              icon: Bot,
              title: r.requester?.name ?? "某人",
              detail: `申请使用 Agent「${r.remoteAgent?.displayName ?? "?"}」`,
            }))}
            outgoing={rOut.map((r) => ({
              id: r.id,
              title: r.remoteAgent?.displayName ?? "Agent",
              detail: "授权申请待通过",
            }))}
            onApprove={async (id) => {
              await api.approveRemoteAgentAccessRequest(workspaceId, id)
              invalidate()
              toast.success("已授权")
            }}
            onReject={async (id) => {
              await api.rejectRemoteAgentAccessRequest(workspaceId, id)
              invalidate()
              toast.success("已拒绝")
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

type InRow = {
  id: string
  icon: typeof UserPlus
  title: string
  detail: string
}
type OutRow = { id: string; title: string; detail: string }

function Queue({
  incoming,
  outgoing,
  onApprove,
  onReject,
}: {
  incoming: InRow[]
  outgoing: OutRow[]
  onApprove: (id: string) => Promise<void>
  onReject: (id: string) => Promise<void>
}) {
  if (incoming.length === 0 && outgoing.length === 0) {
    return (
      <div className="rounded-xl border border-dashed py-14 text-center text-sm text-muted-foreground">
        没有待处理的请求
      </div>
    )
  }
  return (
    <div className="space-y-5">
      {incoming.length > 0 && (
        <Section title="收到的">
          {incoming.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-3 rounded-xl border p-3"
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <r.icon className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{r.title}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {r.detail}
                </div>
              </div>
              <Button size="sm" onClick={() => onApprove(r.id)}>
                通过
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => onReject(r.id)}
              >
                拒绝
              </Button>
            </div>
          ))}
        </Section>
      )}
      {outgoing.length > 0 && (
        <Section title="发出的">
          {outgoing.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-3 rounded-xl border p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{r.title}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {r.detail}
                </div>
              </div>
              <span className="text-xs text-muted-foreground">待通过</span>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
              >
                撤回
              </Button>
            </div>
          ))}
        </Section>
      )}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}
