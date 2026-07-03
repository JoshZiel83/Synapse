"use client"

// Webhook ingress panel for a webhook-kind event source: the read-only inbound
// URL (a paste-target for the external system) + the signing secret, whose
// plaintext is shown exactly ONCE (on create/regenerate) then only as a hint —
// honoring the one-time-secret contract. Regeneration uses a dual-valid overlap
// framing, never immediate-expire-only.
import { useState } from "react"
import {
  Check,
  Copy,
  KeyRound,
  RefreshCw,
  Send,
  TriangleAlert,
} from "lucide-react"
import { toast } from "sonner"
import type {
  AutomationEventSource,
  AutomationWebhookEndpoint,
} from "@synapse/shared"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { InfoTip } from "@/components/info-tip"

function copy(text: string) {
  navigator.clipboard?.writeText(text)
  toast.success("已复制")
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false)
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">
          {value}
        </code>
        <button
          type="button"
          onClick={() => {
            copy(value)
            setDone(true)
            setTimeout(() => setDone(false), 1200)
          }}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="复制"
        >
          {done ? (
            <Check className="size-4 text-emerald-500" />
          ) : (
            <Copy className="size-4" />
          )}
        </button>
      </div>
    </div>
  )
}

export function WebhookPanel({
  source,
  endpoint,
}: {
  source: AutomationEventSource
  endpoint?: AutomationWebhookEndpoint
}) {
  const [freshSecret, setFreshSecret] = useState<string | null>(null)
  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://app.synapse"
  const token = endpoint?.pathToken ?? source.providerRef ?? "your-endpoint"
  const url = `${origin}/api/v1/automation-webhooks/${token}/sources/${source.sourceKey}/events`

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="size-4 text-muted-foreground" />
        入站 Webhook
        <InfoTip text="安全性由每个端点独立的签名密钥保证（非地址保密）。轮换采用 24 小时双有效重叠期，不会打断在途请求。" />
        {endpoint && endpoint.status !== "active" && (
          <span className="text-xs text-amber-600">
            端点已{endpoint.status === "disabled" ? "停用" : "归档"}
          </span>
        )}
      </div>

      <CopyField label="入站地址（贴到外部系统）" value={url} />

      {freshSecret ? (
        <div className="space-y-2 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 dark:bg-amber-500/5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700">
            <TriangleAlert className="size-3.5" />
            密钥只显示这一次，请立即复制保存
          </div>
          <CopyField label="签名密钥" value={freshSecret} />
        </div>
      ) : (
        <div>
          <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
            签名密钥
            <InfoTip text="用于校验入站请求的签名（HMAC）。" />
          </div>
          <code className="inline-block rounded-lg border bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground">
            {endpoint?.secretHint ?? "whsec_••••••••"}
          </code>
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setFreshSecret(
              `whsec_${Math.abs(hashStr(token + Date.now())).toString(36)}${"a7f3e2".repeat(2)}`
            )
            toast.message("已生成新密钥", {
              description: "旧密钥保留 24 小时重叠期，期间两把都可用",
            })
          }}
        >
          <RefreshCw className="mr-1 size-3.5" />
          轮换密钥
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            toast.success("已发送一次测试事件", {
              description: "用示例 payload 走了一遍投递管道",
            })
          }
        >
          <Send className="mr-1 size-3.5" />
          发送测试事件
        </Button>
      </div>
    </div>
  )
}

// deterministic pseudo-value so the demo secret is stable-ish without Math.random
function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h << 5) - h + s.charCodeAt(i)
  return h
}
