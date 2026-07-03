"use client"

// Requests inbox (right pane) — the 3 request types as ONE surface reached from
// a single badged "Requests" row, so pending never crowds the roster. Phase 1 is
// a functional incoming list with approve/reject + trust context; the polished
// 3-tab / incoming-outgoing / set-alias-on-accept version is Phase 2.
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Cpu, Loader2, UserPlus } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"

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

  const friends = pending(friend.data?.incoming)
  const actors = pending(actor.data?.incoming)
  const agents = pending(agent.data?.incoming)
  const total = friends.length + actors.length + agents.length

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

      {total === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
          没有待处理的请求
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          {friends.length > 0 && (
            <Group title="好友请求" count={friends.length}>
              {friends.map((r) => (
                <Card
                  key={r.id}
                  icon={UserPlus}
                  title={r.requester?.name ?? "某人"}
                  detail={`想加你为好友${r.requester?.workspace?.name ? ` · 来自 ${r.requester.workspace.name}` : ""}`}
                  onApprove={async () => {
                    await api.approveFriendRequest(workspaceId, r.id)
                    invalidate()
                    toast.success("已通过")
                  }}
                  onReject={async () => {
                    await api.rejectFriendRequest(workspaceId, r.id)
                    invalidate()
                    toast.success("已拒绝")
                  }}
                />
              ))}
            </Group>
          )}
          {actors.length > 0 && (
            <Group title="Actor 授权请求" count={actors.length}>
              {actors.map((r) => (
                <Card
                  key={r.id}
                  icon={Cpu}
                  title={r.requester?.name ?? "某人"}
                  detail={`申请使用 Actor「${r.actor?.displayName ?? "?"}」`}
                  onApprove={async () => {
                    await api.approveActorAccessRequest(workspaceId, r.id)
                    invalidate()
                    toast.success("已授权")
                  }}
                  onReject={async () => {
                    await api.rejectActorAccessRequest(workspaceId, r.id)
                    invalidate()
                    toast.success("已拒绝")
                  }}
                />
              ))}
            </Group>
          )}
          {agents.length > 0 && (
            <Group title="远程 Agent 授权请求" count={agents.length}>
              {agents.map((r) => (
                <Card
                  key={r.id}
                  icon={Bot}
                  title={r.requester?.name ?? "某人"}
                  detail={`申请使用 Agent「${r.remoteAgent?.displayName ?? "?"}」`}
                  onApprove={async () => {
                    await api.approveRemoteAgentAccessRequest(workspaceId, r.id)
                    invalidate()
                    toast.success("已授权")
                  }}
                  onReject={async () => {
                    await api.rejectRemoteAgentAccessRequest(workspaceId, r.id)
                    invalidate()
                    toast.success("已拒绝")
                  }}
                />
              ))}
            </Group>
          )}
        </div>
      )}
    </div>
  )
}

function Group({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        {title} · {count}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Card({
  icon: Icon,
  title,
  detail,
  onApprove,
  onReject,
}: {
  icon: typeof UserPlus
  title: string
  detail: string
  onApprove: () => Promise<void>
  onReject: () => Promise<void>
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border p-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{detail}</div>
      </div>
      <Button size="sm" onClick={onApprove}>
        通过
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground"
        onClick={onReject}
      >
        拒绝
      </Button>
    </div>
  )
}
