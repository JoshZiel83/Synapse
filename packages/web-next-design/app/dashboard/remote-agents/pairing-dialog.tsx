"use client"

// Pair-a-machine wizard (RFC 8628 device-flow shape): 命名 → 连接 (one-click /
// manual install command + the one-time apiKey behind a masked reveal + a QR to
// carry the token to another device + anti-phishing + expiry) → 等待连接 (poll,
// auto-materializes as 待批准 → 批准). The apiKey is shown ONCE — there is no
// re-issue, so it is treated as a secret.
import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { useQueryClient } from "@tanstack/react-query"
import { Check, Copy, Eye, EyeOff, Loader2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import type { RemoteAgentMachinePairingSessionView } from "@synapse/shared"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

function CopyRow({ value, mono = true }: { value: string; mono?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
      <code
        className={cn("min-w-0 flex-1 truncate text-xs", mono && "font-mono")}
      >
        {value}
      </code>
      <button
        type="button"
        aria-label="复制"
        onClick={() => {
          navigator.clipboard?.writeText(value)
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        }}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        {done ? (
          <Check className="size-4 text-emerald-500" />
        ) : (
          <Copy className="size-4" />
        )}
      </button>
    </div>
  )
}

export function PairingDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  workspaceId: string
}) {
  const qc = useQueryClient()
  const [step, setStep] = useState(1)
  const [title, setTitle] = useState("")
  const [session, setSession] =
    useState<RemoteAgentMachinePairingSessionView | null>(null)
  const [creating, setCreating] = useState(false)
  const [reveal, setReveal] = useState(false)
  const [qr, setQr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setStep(1)
      setTitle("")
      setSession(null)
      setReveal(false)
      setQr(null)
    }
  }, [open])

  const start = async () => {
    setCreating(true)
    try {
      const s = await api.createRemoteAgentMachinePairingSession(workspaceId, {
        title: title.trim() || undefined,
      })
      setSession(s)
      setStep(2)
      void QRCode.toDataURL(`https://app.synapse/pair?token=${s.apiKey}`, {
        width: 160,
        margin: 1,
      }).then(setQr)
    } catch {
      toast.error("生成配对令牌失败")
    } finally {
      setCreating(false)
    }
  }

  const approve = () => {
    toast.success("已批准 · 主机已信任")
    qc.invalidateQueries({ queryKey: ["remote-agent-machines", workspaceId] })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>配对主机 · 第 {step} / 3 步</DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              给这台主机起个名字，方便在花名册里认出它。
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                主机名称（可选）
              </Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：MacBook Pro · 前端"
                autoFocus
              />
            </div>
            <div className="flex justify-end">
              <Button onClick={start} disabled={creating}>
                {creating && <Loader2 className="mr-1 size-4 animate-spin" />}
                生成配对令牌
              </Button>
            </div>
          </div>
        )}

        {step === 2 && session && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-xs text-amber-700 dark:bg-amber-500/5 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <div>
                <div className="font-medium">令牌只显示这一次</div>
                <div className="mt-0.5 text-amber-700/80">
                  请勿分享此令牌 / 二维码。配对令牌 1 小时后失效。
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center justify-between text-xs text-muted-foreground">
                配对令牌
                <button
                  type="button"
                  onClick={() => setReveal((r) => !r)}
                  className="flex items-center gap-1 hover:text-foreground"
                >
                  {reveal ? (
                    <EyeOff className="size-3" />
                  ) : (
                    <Eye className="size-3" />
                  )}
                  {reveal ? "隐藏" : "显示"}
                </button>
              </Label>
              <CopyRow
                value={
                  reveal
                    ? session.apiKey
                    : session.apiKey.replace(/.(?=.{4})/g, "•")
                }
              />
            </div>

            <Tabs defaultValue="oneclick">
              <TabsList>
                <TabsTrigger value="oneclick">一键安装</TabsTrigger>
                <TabsTrigger value="manual">手动</TabsTrigger>
              </TabsList>
              <TabsContent value="oneclick" className="mt-3 space-y-2">
                {session.oneClickCommands ? (
                  <Tabs defaultValue="unix">
                    <TabsList className="h-7">
                      <TabsTrigger value="unix" className="text-xs">
                        Linux · macOS
                      </TabsTrigger>
                      <TabsTrigger value="windows" className="text-xs">
                        Windows
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="unix" className="mt-2">
                      <CopyRow value={session.oneClickCommands.unix} />
                    </TabsContent>
                    <TabsContent value="windows" className="mt-2">
                      <CopyRow value={session.oneClickCommands.windows} />
                    </TabsContent>
                  </Tabs>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    当前环境未启用一键安装，请用手动命令。
                  </p>
                )}
              </TabsContent>
              <TabsContent value="manual" className="mt-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  在目标主机上运行：
                </p>
                <CopyRow value={session.daemonCommand} />
              </TabsContent>
            </Tabs>

            {qr && (
              <div className="flex items-center gap-3 rounded-lg border p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qr}
                  alt="配对二维码"
                  width={72}
                  height={72}
                  className="rounded"
                />
                <p className="text-xs text-muted-foreground">
                  用另一台设备扫码，把令牌带到目标主机。
                </p>
              </div>
            )}

            <div className="flex justify-end">
              <Button onClick={() => setStep(3)}>我已运行 · 检查连接</Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4 py-2 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
              <Check className="size-6" />
            </div>
            <div>
              <div className="font-medium">已连接 · 待你批准</div>
              <p className="mt-1 text-sm text-muted-foreground">
                主机已上线并出现在花名册里（待批准）。批准后即可绑定 Agent。
              </p>
            </div>
            <div className="flex justify-center gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                稍后批准
              </Button>
              <Button onClick={approve}>批准</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
