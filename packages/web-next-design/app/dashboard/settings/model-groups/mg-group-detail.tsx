"use client"

// Group detail: a full-width tinted SCOPE banner naming the blast radius (the
// safety fix), the header (name / default / active), and Config | Grants tabs.
// Cross-scope guardrail: a group granted in from another scope renders read-only
// with "manage it there".
import { useState } from "react"
import { Star } from "lucide-react"
import type {
  ModelGroupDetailView,
  ModelGroupGrantScope,
  ModelGroupItemView,
  ModelGroupOwnerType,
  ModelGroupRoutingStrategy,
} from "@synapse/shared"
import type { ModelGroupItemCreateInput } from "@synapse/shared/schemas"
import { cn } from "@/lib/utils"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { getModelGroupScopeMeta } from "../model-group-shared"
import { ConfigTab } from "./mg-config-tab"
import { GrantsTab } from "./mg-grants-tab"
import { ItemEditor } from "./mg-item-editor"

const BANNER: Record<string, { tint: string; text: string }> = {
  platform: {
    tint: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
    text: "平台组 · 影响所有工作区，谨慎修改",
  },
  workspace: {
    tint: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    text: "工作区组 · 本工作区可用",
  },
  workspace_member: {
    tint: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
    text: "个人组 · 只有你可见",
  },
}

export function GroupDetail({
  group,
  activeScope,
  onSaveConfig,
  onSaveItem,
  onDeleteItem,
  onRevokeGrant,
  onIssueGrant,
  onSetDefault,
  onToggleActive,
}: {
  group: ModelGroupDetailView
  activeScope: ModelGroupOwnerType
  onSaveConfig: (
    strategy: ModelGroupRoutingStrategy,
    items: ModelGroupItemView[]
  ) => Promise<void>
  onSaveItem: (
    input: ModelGroupItemCreateInput,
    itemId?: string
  ) => Promise<void>
  onDeleteItem: (item: ModelGroupItemView) => Promise<void>
  onRevokeGrant: (grantId: string) => Promise<void>
  onIssueGrant: (scope: ModelGroupGrantScope, actorId?: string) => Promise<void>
  onSetDefault: () => Promise<void>
  onToggleActive: (active: boolean) => Promise<void>
}) {
  const scope = group.ownerType
  const meta = getModelGroupScopeMeta(scope)
  const readOnly = scope !== activeScope // granted in from elsewhere
  const banner = BANNER[scope] ?? BANNER.workspace

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<
    ModelGroupItemView | undefined
  >()

  return (
    <div className="flex h-full flex-col">
      {/* scope banner */}
      <div
        className={cn(
          "flex items-center gap-2 rounded-t-xl px-4 py-2 text-xs font-medium",
          banner.tint
        )}
      >
        <meta.icon className="size-3.5" />
        {readOnly ? `在其他作用域拥有 · 在那里管理` : banner.text}
      </div>

      <div className="flex-1 space-y-5 rounded-b-xl border border-t-0 p-5">
        {/* header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{group.name}</h2>
              {group.isDefault && (
                <span className="flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600">
                  <Star className="size-3 fill-current" /> 默认
                </span>
              )}
              {!group.isActive && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  已暂停
                </span>
              )}
            </div>
            {group.description && (
              <p className="mt-1 text-sm text-muted-foreground">
                {group.description}
              </p>
            )}
          </div>
          {!readOnly && (
            <div className="flex shrink-0 flex-col items-end gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                启用
                <Switch
                  checked={group.isActive}
                  onCheckedChange={onToggleActive}
                />
              </label>
              {!group.isDefault && (
                <button
                  type="button"
                  onClick={onSetDefault}
                  className="text-xs text-primary hover:underline"
                >
                  设为{meta.label}默认
                </button>
              )}
            </div>
          )}
        </div>

        <Tabs defaultValue="config">
          <TabsList>
            <TabsTrigger value="config">配置</TabsTrigger>
            <TabsTrigger value="grants">
              分享 · {group.grants.filter((g) => g.status === "active").length}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="config" className="mt-4">
            <ConfigTab
              group={group}
              readOnly={readOnly}
              onAddItem={() => {
                setEditingItem(undefined)
                setEditorOpen(true)
              }}
              onEditItem={(it) => {
                setEditingItem(it)
                setEditorOpen(true)
              }}
              onDeleteItem={onDeleteItem}
              onSave={onSaveConfig}
            />
          </TabsContent>
          <TabsContent value="grants" className="mt-4">
            <GrantsTab
              group={group}
              onRevoke={onRevokeGrant}
              onIssue={onIssueGrant}
            />
          </TabsContent>
        </Tabs>
      </div>

      <ItemEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        initial={editingItem}
        onSave={(input) => onSaveItem(input, editingItem?.id)}
      />
    </div>
  )
}
