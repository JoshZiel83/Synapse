"use client"

// Register a new event source, branched by provider kind up front (not a
// provider <Select> that wipes the form on change). Integration = connect an
// account + pick a target; Webhook = we mint an inbound URL + secret; Internal =
// hand-authored. Reachable from both the Event Sources tab and inline from the
// rule editor's event branch.
import { useState } from "react"
import { ArrowLeft, GitBranch, Radio, Webhook } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type Kind = "integration" | "webhook" | "internal"

const KINDS: {
  kind: Kind
  icon: React.ComponentType<{ className?: string }>
  title: string
  desc: string
}[] = [
  {
    kind: "integration",
    icon: GitBranch,
    title: "集成",
    desc: "连接 GitHub / GitLab，选择仓库或项目",
  },
  {
    kind: "webhook",
    icon: Webhook,
    title: "Webhook",
    desc: "我们生成入站地址与密钥，外部系统回调",
  },
  {
    kind: "internal",
    icon: Radio,
    title: "内部事件",
    desc: "手动定义的工作区内部事件",
  },
]

export function SourceRegisterDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated?: () => void
}) {
  const [kind, setKind] = useState<Kind | null>(null)
  const [name, setName] = useState("")
  const [desc, setDesc] = useState("")
  const [provider, setProvider] = useState("github")
  const [target, setTarget] = useState("")

  const reset = () => {
    setKind(null)
    setName("")
    setDesc("")
    setTarget("")
  }
  const close = (o: boolean) => {
    if (!o) reset()
    onOpenChange(o)
  }
  const create = () => {
    toast.success("已注册事件源")
    onCreated?.()
    close(false)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {kind && (
              <button
                type="button"
                onClick={() => setKind(null)}
                aria-label="返回"
              >
                <ArrowLeft className="size-4 text-muted-foreground hover:text-foreground" />
              </button>
            )}
            注册事件源
          </DialogTitle>
        </DialogHeader>

        {!kind ? (
          <div className="grid gap-2">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                onClick={() => setKind(k.kind)}
                className="flex items-start gap-3 rounded-xl border p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/30"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <k.icon className="size-4.5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{k.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {k.desc}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {kind === "integration" && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    提供方
                  </Label>
                  <Select value={provider} onValueChange={setProvider}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="github">GitHub（仓库）</SelectItem>
                      <SelectItem value="gitlab">GitLab（项目）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    {provider === "github" ? "仓库" : "项目"}
                  </Label>
                  <Input
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    placeholder={
                      provider === "github" ? "synapse-ai/api" : "synapse/web"
                    }
                  />
                  <p className="text-[11px] text-muted-foreground/60">
                    需要已安装 official-mcp 集成。
                  </p>
                </div>
              </>
            )}

            {kind === "webhook" && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">名称</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：部署回调"
                  />
                </div>
                <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                  创建后生成入站地址与一次性签名密钥。
                </div>
              </>
            )}

            {kind === "internal" && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">名称</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：新成员加入"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">说明</Label>
                  <Textarea
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    rows={2}
                    placeholder="这个事件在什么时候发生"
                  />
                </div>
              </>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => close(false)}>
                取消
              </Button>
              <Button
                onClick={create}
                disabled={
                  (kind === "integration" && !target.trim()) ||
                  (kind !== "integration" && !name.trim())
                }
              >
                注册
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
