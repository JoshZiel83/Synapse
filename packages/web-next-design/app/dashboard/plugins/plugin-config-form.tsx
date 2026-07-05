"use client"

// Auto-generated config form for an installed plugin — one control per real
// configField (never raw JSON), driven by the local installation's configState.
// Secrets are write-only (masked ••••last4, leave-blank-to-keep, 更新密钥). An
// auth_connection field is the Connect control: OAuth (startPluginAuth → poll) or
// a QR (feishu/mijia). Type→control map honors PLUGIN_CONFIG_FIELD_TYPES.
import { useEffect, useRef, useState } from "react"
import QRCode from "qrcode"
import { Check, Loader2 } from "lucide-react"
import { toast } from "sonner"
import type {
  MarketplacePluginView,
  PluginInstallationDetailView,
  PluginConfigFieldDefinition,
} from "@synapse/shared"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { pluginAccountName } from "@/lib/design/fixtures/mcp-plugins"

type ConfigState = PluginInstallationDetailView["configState"]
const maskSecret = (v: string) =>
  v.length <= 4 ? "••••" : "••••" + v.slice(-4)

export function PluginConfigForm({
  plugin,
  installation,
  workspaceId,
  onConfigStateChange,
}: {
  plugin: MarketplacePluginView
  installation: PluginInstallationDetailView
  workspaceId: string
  onConfigStateChange: (next: ConfigState) => void
}) {
  const state = installation.configState
  const get = (key: string) => state.find((s) => s.key === key)
  const patch = (key: string, next: Partial<ConfigState[number]>) => {
    const rest = state.filter((s) => s.key !== key)
    onConfigStateChange([
      ...rest,
      { key, isConfigured: false, ...get(key), ...next },
    ])
  }

  return (
    <div className="space-y-4">
      {plugin.configFields.map((f) => (
        <FieldRow
          key={f.key}
          field={f}
          plugin={plugin}
          workspaceId={workspaceId}
          value={get(f.key)}
          onSet={(next) => patch(f.key, next)}
        />
      ))}
    </div>
  )
}

function FieldRow({
  field,
  plugin,
  workspaceId,
  value,
  onSet,
}: {
  field: PluginConfigFieldDefinition
  plugin: MarketplacePluginView
  workspaceId: string
  value: ConfigState[number] | undefined
  onSet: (next: Partial<ConfigState[number]>) => void
}) {
  const label = field.titleI18n["zh-CN"] ?? field.key
  const help = field.descriptionI18n?.["zh-CN"]

  if (field.type === "auth_connection") {
    return (
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {label}
          {field.required && " *"}
        </Label>
        <ConnectControl
          plugin={plugin}
          field={field}
          workspaceId={workspaceId}
          value={value}
          onSet={onSet}
        />
        {help && <p className="text-[11px] text-muted-foreground/60">{help}</p>}
      </div>
    )
  }

  if (field.type === "boolean") {
    return (
      <label className="flex items-center justify-between rounded-lg border p-3">
        <div>
          <div className="text-sm">{label}</div>
          {help && <div className="text-xs text-muted-foreground">{help}</div>}
        </div>
        <Switch
          checked={!!value?.isConfigured && value?.maskedValue === "on"}
          onCheckedChange={(v) =>
            onSet({ isConfigured: true, maskedValue: v ? "on" : "off" })
          }
        />
      </label>
    )
  }

  if (field.type === "secret")
    return (
      <SecretField
        label={label}
        help={help}
        required={field.required}
        value={value}
        onSet={onSet}
      />
    )

  if (field.type === "select") {
    return (
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {label}
          {field.required && " *"}
        </Label>
        <Select
          value={value?.maskedValue}
          onValueChange={(v) => onSet({ isConfigured: true, maskedValue: v })}
        >
          <SelectTrigger>
            <SelectValue placeholder="请选择" />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={String(o.value)} value={String(o.value)}>
                {o.labelI18n?.["zh-CN"] ?? String(o.value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  // text / number / textarea
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">
        {label}
        {field.required && " *"}
      </Label>
      <Input
        defaultValue={
          value?.maskedValue ?? (field.defaultValue as string | undefined) ?? ""
        }
        placeholder={field.placeholderI18n?.["zh-CN"] ?? ""}
        type={field.type === "number" ? "number" : "text"}
        className="font-mono text-xs"
        onBlur={(e) =>
          e.target.value &&
          onSet({ isConfigured: true, maskedValue: e.target.value })
        }
      />
      {help && <p className="text-[11px] text-muted-foreground/60">{help}</p>}
    </div>
  )
}

function SecretField({
  label,
  help,
  required,
  value,
  onSet,
}: {
  label: string
  help?: string
  required?: boolean
  value: ConfigState[number] | undefined
  onSet: (next: Partial<ConfigState[number]>) => void
}) {
  const configured = value?.isConfigured && value?.maskedValue
  const [editing, setEditing] = useState(!configured)
  const [val, setVal] = useState("")

  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">
        {label}
        {required && " *"}
      </Label>
      {configured && !editing ? (
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
            {value!.maskedValue}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditing(true)
              setVal("")
            }}
          >
            更新密钥
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            value={val}
            onChange={(e) => setVal(e.target.value)}
            type="password"
            autoComplete="off"
            placeholder={configured ? "留空则保持不变" : "粘贴密钥…"}
            className="flex-1 font-mono text-xs"
          />
          <Button
            size="sm"
            disabled={!val.trim()}
            onClick={() => {
              onSet({ isConfigured: true, maskedValue: maskSecret(val.trim()) })
              setEditing(false)
              toast.success("已保存")
            }}
          >
            保存
          </Button>
        </div>
      )}
      {help && <p className="text-[11px] text-muted-foreground/60">{help}</p>}
    </div>
  )
}

function ConnectControl({
  plugin,
  field,
  workspaceId,
  value,
  onSet,
}: {
  plugin: MarketplacePluginView
  field: PluginConfigFieldDefinition
  workspaceId: string
  value: ConfigState[number] | undefined
  onSet: (next: Partial<ConfigState[number]>) => void
}) {
  const bindingKey =
    field.authBindingKey ?? plugin.authBindings[0]?.key ?? "oauth"
  const driver =
    plugin.authBindings.find((b) => b.key === bindingKey)?.driver ??
    "oauth2_authorization_code_pkce"
  const isQr = driver !== "oauth2_authorization_code_pkce"
  const [phase, setPhase] = useState<"idle" | "connecting">("idle")
  const [qr, setQr] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current)
    },
    []
  )

  if (value?.authConnectionId) {
    return (
      <div className="flex items-center justify-between rounded-lg border p-3">
        <span className="flex items-center gap-2 text-sm">
          <Check className="size-4 text-emerald-500" />
          已连接 · {value.accountDisplayName ?? pluginAccountName(plugin.id)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() =>
            onSet({
              isConfigured: false,
              authConnectionId: undefined,
              accountDisplayName: undefined,
            })
          }
        >
          断开
        </Button>
      </div>
    )
  }

  const connect = async () => {
    setPhase("connecting")
    try {
      const session = await api.startPluginAuth(
        workspaceId,
        plugin.id,
        bindingKey
      )
      if (session.challenge?.kind === "qr_code") {
        const url =
          session.challenge.qrUrl ?? `https://app.synapse/connect/${plugin.id}`
        setQr(await QRCode.toDataURL(url, { width: 160, margin: 1 }))
      }
      // poll until the session completes
      pollRef.current = setInterval(async () => {
        const s = await api.getPluginAuthSession(workspaceId, session.id)
        if (s.status === "completed") {
          if (pollRef.current) clearInterval(pollRef.current)
          onSet({
            isConfigured: true,
            authConnectionId: s.authConnectionId,
            accountDisplayName: (s.resultPreview as { displayName?: string })
              ?.displayName,
          })
          setPhase("idle")
          setQr(null)
          toast.success("已连接")
        }
      }, 1500)
    } catch {
      toast.error("连接失败")
      setPhase("idle")
    }
  }

  if (phase === "connecting") {
    return (
      <div className="rounded-lg border p-3 text-sm">
        {isQr ? (
          <div className="flex items-center gap-3">
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qr}
                alt="扫码"
                width={80}
                height={80}
                className="rounded"
              />
            ) : (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            )}
            <div className="text-muted-foreground">
              <div>
                请用{driver === "mijia_qr_login" ? "米家" : "飞书"} App 扫码
              </div>
              <div className="text-xs">扫码后在手机上确认，完成后自动连接…</div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            已发起授权，完成后自动返回…
          </div>
        )}
      </div>
    )
  }

  const label = isQr ? "扫码连接" : `使用 ${plugin.displayName} 登录`
  return <Button onClick={connect}>{label}</Button>
}
