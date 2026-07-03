"use client"

// Provider-FIRST model-item editor. Leads with the 3 fields that matter
// (vendor → model → key) driven by the real vendor catalog; providerKind is
// derived (a chip, not an input); connection / capabilities / provider-options
// are progressive-disclosure sections; a Test-connection action decoupled from
// Save; and a "saving mints version n+1" consequence line (edits are versioned).
import { useMemo, useState } from "react"
import {
  ChevronDown,
  Loader2,
  Plug,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react"
import { toast } from "sonner"
import {
  getDefaultModelBaseUrl,
  getDefaultModelName,
  getKnownModelDefinitions,
  getProviderKindForVendor,
  listModelVendorDefinitions,
  vendorSupportsServerTools,
} from "@synapse/shared"
import type { ModelGroupItemView } from "@synapse/shared"
import type { ModelGroupItemCreateInput } from "@synapse/shared/schemas"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Combobox } from "@/app/dashboard/automations/combobox"

const VENDORS = listModelVendorDefinitions()

interface Draft {
  displayName: string
  vendor: string
  modelName: string
  apiKey: string
  baseUrl: string
  maxOutputTokens?: number
  serverTools: string[]
  multimodal: boolean
  crossTurnToolHistory: boolean
}

function fromItem(it?: ModelGroupItemView): Draft {
  return {
    displayName: it?.displayName ?? "",
    vendor: it?.vendor ?? "anthropic",
    modelName: it?.modelName ?? getDefaultModelName("anthropic"),
    apiKey: "",
    baseUrl: it?.baseUrl ?? getDefaultModelBaseUrl("anthropic"),
    maxOutputTokens: it?.maxOutputTokens ?? undefined,
    serverTools: it?.features?.serverTools ?? [],
    multimodal: !!it?.features?.multimodal?.supported,
    crossTurnToolHistory: !!it?.features?.crossTurnToolHistory,
  }
}

export function ItemEditor({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  initial?: ModelGroupItemView
  onSave: (input: ModelGroupItemCreateInput) => Promise<void>
}) {
  const [draft, setDraft] = useState<Draft>(() => fromItem(initial))
  const [advanced, setAdvanced] = useState(false)
  const [caps, setCaps] = useState(false)
  const [saving, setSaving] = useState(false)
  const [test, setTest] = useState<"idle" | "testing" | "ok" | "err">("idle")

  // reset when (re)opening
  const [seenOpen, setSeenOpen] = useState(false)
  if (open && !seenOpen) {
    setDraft(fromItem(initial))
    setAdvanced(false)
    setCaps(false)
    setTest("idle")
    setSeenOpen(true)
  }
  if (!open && seenOpen) setSeenOpen(false)

  const providerKind = getProviderKindForVendor(draft.vendor)
  const models = useMemo(
    () => getKnownModelDefinitions(draft.vendor),
    [draft.vendor]
  )
  const modelOptions = [
    ...models.map((m) => ({ value: m.modelName, label: m.label })),
    // keep an already-saved model listed even if dropped from the catalog
    ...(draft.modelName && !models.some((m) => m.modelName === draft.modelName)
      ? [{ value: draft.modelName, label: `${draft.modelName}（自定义）` }]
      : []),
  ]

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }))
  const pickVendor = (vendor: string) =>
    patch({
      vendor,
      baseUrl: getDefaultModelBaseUrl(vendor),
      modelName: getDefaultModelName(vendor),
    })

  const runTest = () => {
    setTest("testing")
    // design mock: succeed unless key empty on create
    setTimeout(() => setTest(!initial && !draft.apiKey ? "err" : "ok"), 900)
  }

  const save = async () => {
    if (!draft.displayName.trim()) return toast.error("请填写显示名")
    if (!draft.modelName.trim()) return toast.error("请选择模型")
    if (!initial && !draft.apiKey.trim()) return toast.error("请填写 API Key")
    setSaving(true)
    try {
      await onSave({
        displayName: draft.displayName.trim(),
        vendor: draft.vendor,
        modelName: draft.modelName.trim(),
        apiKey: draft.apiKey || "unchanged",
        baseUrl: draft.baseUrl,
        maxOutputTokens: draft.maxOutputTokens,
        features: {
          serverTools: draft.serverTools as ("web_search" | "web_fetch")[],
          multimodal: draft.multimodal
            ? { supported: true, types: ["image"] }
            : undefined,
          crossTurnToolHistory: draft.crossTurnToolHistory,
        },
      })
      toast.success(initial ? "已保存（生成新版本）" : "已添加模型")
      onOpenChange(false)
    } catch {
      toast.error("保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-lg"
      >
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>{initial ? "编辑模型" : "添加模型"}</SheetTitle>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="space-y-4 p-5">
            {/* provider-first: vendor → model → key */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">厂商</Label>
              <Combobox
                options={VENDORS.map((v) => ({
                  value: v.vendor,
                  label: v.label,
                }))}
                value={draft.vendor}
                onChange={pickVendor}
                placeholder="选择厂商"
                searchPlaceholder="搜索厂商…"
              />
              <div className="text-[11px] text-muted-foreground/60">
                协议：<code className="font-mono">{providerKind}</code>
                （由厂商推断）
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">模型</Label>
              <Combobox
                options={modelOptions}
                value={draft.modelName}
                onChange={(v) => patch({ modelName: v })}
                placeholder="选择模型"
                searchPlaceholder="搜索或输入模型 id…"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">API Key</Label>
              {initial ? (
                <div className="flex items-center gap-2">
                  <code className="rounded-md border bg-muted/30 px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
                    •••• 已保存
                  </code>
                  <Input
                    type="password"
                    value={draft.apiKey}
                    onChange={(e) => patch({ apiKey: e.target.value })}
                    placeholder="替换密钥（留空则不变）"
                    className="h-8 flex-1"
                  />
                </div>
              ) : (
                <Input
                  type="password"
                  value={draft.apiKey}
                  onChange={(e) => patch({ apiKey: e.target.value })}
                  placeholder="sk-…（只写，永不回显）"
                />
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                显示名（别名）
              </Label>
              <Input
                value={draft.displayName}
                onChange={(e) => patch({ displayName: e.target.value })}
                placeholder="例如：Claude 主力"
              />
            </div>

            {/* advanced: connection */}
            <Disclosure
              open={advanced}
              onToggle={() => setAdvanced((a) => !a)}
              label="连接与限制"
            >
              <div className="space-y-3 pt-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Base URL
                  </Label>
                  <Input
                    value={draft.baseUrl}
                    onChange={(e) => patch({ baseUrl: e.target.value })}
                    disabled={providerKind !== "openai_compatible"}
                    className="font-mono text-xs"
                  />
                  {providerKind !== "openai_compatible" && (
                    <p className="text-[11px] text-muted-foreground/60">
                      官方厂商地址由协议决定，不可改。
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    最大输出 tokens
                  </Label>
                  <Input
                    type="number"
                    value={draft.maxOutputTokens ?? ""}
                    onChange={(e) =>
                      patch({
                        maxOutputTokens: e.target.value
                          ? +e.target.value
                          : undefined,
                      })
                    }
                    placeholder="默认"
                    className="w-40"
                  />
                </div>
              </div>
            </Disclosure>

            {/* capabilities */}
            <Disclosure
              open={caps}
              onToggle={() => setCaps((a) => !a)}
              label="能力与特性"
            >
              <div className="space-y-2 pt-2">
                {vendorSupportsServerTools(draft.vendor) && (
                  <label className="flex items-center justify-between text-sm">
                    联网搜索（web_search）
                    <Switch
                      checked={draft.serverTools.includes("web_search")}
                      onCheckedChange={(v) =>
                        patch({ serverTools: v ? ["web_search"] : [] })
                      }
                    />
                  </label>
                )}
                <label className="flex items-center justify-between text-sm">
                  多模态（图片）
                  <Switch
                    checked={draft.multimodal}
                    onCheckedChange={(v) => patch({ multimodal: v })}
                  />
                </label>
                <label className="flex items-center justify-between text-sm">
                  跨轮工具历史
                  <Switch
                    checked={draft.crossTurnToolHistory}
                    onCheckedChange={(v) => patch({ crossTurnToolHistory: v })}
                  />
                </label>
              </div>
            </Disclosure>
          </div>
        </ScrollArea>

        {/* footer: test + save */}
        <div className="space-y-2 border-t p-4">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={runTest}
              disabled={test === "testing"}
            >
              {test === "testing" ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              ) : (
                <Plug className="mr-1 size-3.5" />
              )}
              测试连接
            </Button>
            {test === "ok" && (
              <span className="flex items-center gap-1 text-xs text-emerald-600">
                <ShieldCheck className="size-3.5" /> 连接成功
              </span>
            )}
            {test === "err" && (
              <span className="flex items-center gap-1 text-xs text-red-600">
                <TriangleAlert className="size-3.5" /> 401 — 检查 API Key
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground/60">
            {initial
              ? "保存将生成新的一版配置（保留历史）。"
              : "保存后可在路由里调整顺序/权重。"}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
              {initial ? "保存" : "添加"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Disclosure({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean
  onToggle: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border p-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1 text-sm font-medium"
      >
        <ChevronDown
          className={cn("size-4 transition", open && "rotate-180")}
        />
        {label}
      </button>
      {open && children}
    </div>
  )
}
