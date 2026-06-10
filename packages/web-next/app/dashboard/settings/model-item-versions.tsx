"use client"

import { useEffect, useState } from "react"
import { useWorkspace } from "../workspace-provider"
import { api } from "@/lib/api"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ArrowLeft, History, Clock } from "lucide-react"
import { MODEL_GROUP_GRANT_SCOPE, type Timestamp } from "@synapse/shared"

interface ConfigVersion {
  id: string
  bindingId: string
  version: number
  providerKind: string
  vendor: string
  baseUrl: string
  modelName: string | null
  maxOutputTokens: number | null
  capabilityTags: string[]
  createdAt: Timestamp | null
}

export default function ModelItemVersions({
  groupId,
  itemId,
  scope = "workspace",
  onBack,
}: {
  groupId: string
  itemId: string
  scope?: "workspace" | "platform" | "workspace_member"
  onBack: () => void
}) {
  const { workspaceId } = useWorkspace()
  const [versions, setVersions] = useState<ConfigVersion[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!workspaceId && scope === MODEL_GROUP_GRANT_SCOPE.WORKSPACE) return
    setLoading(true)
    const request =
      scope === MODEL_GROUP_GRANT_SCOPE.PLATFORM
        ? api.getPlatformItemVersions(groupId, itemId)
        : scope === MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER
          ? api.getWorkspaceMemberItemVersions(workspaceId!, groupId, itemId)
          : api.getItemVersions(workspaceId!, groupId, itemId)
    request
      .then((res) => setVersions(res.versions || []))
      .catch((err) => console.error("Failed to load versions:", err))
      .finally(() => setLoading(false))
  }, [workspaceId, groupId, itemId, scope])

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Back
        </Button>
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <History className="h-5 w-5 text-blue-400" />
            Configuration History
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Each edit creates an immutable version snapshot
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
        </div>
      ) : versions.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">
          No versions found
        </p>
      ) : (
        <div className="grid gap-3">
          {versions.map((v, idx) => (
            <Card
              key={v.id}
              className={`border-gray-200 bg-white ring-1 ring-gray-200 dark:border-white/10 dark:bg-gray-900 dark:ring-white/10 ${idx === 0 ? "border-emerald-500/20" : ""}`}
            >
              <CardContent className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge
                      className={`text-xs ${
                        idx === 0
                          ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                          : "border-blue-500/20 bg-blue-500/10 text-blue-400"
                      }`}
                    >
                      v{v.version} {idx === 0 && "(current)"}
                    </Badge>
                    <Badge className="border-violet-500/20 bg-violet-500/10 text-xs text-violet-400">
                      {v.vendor}
                    </Badge>
                    {v.providerKind ? (
                      <Badge className="border-slate-500/20 bg-slate-500/10 text-xs text-slate-300">
                        {v.providerKind}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {v.createdAt ? new Date(v.createdAt).toLocaleString() : ""}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                  <div>
                    <span className="block text-xs text-muted-foreground">
                      Model
                    </span>
                    <span className="text-foreground">{v.modelName}</span>
                  </div>
                  <div>
                    <span className="block text-xs text-muted-foreground">
                      Base URL
                    </span>
                    <span className="block truncate text-foreground">
                      {v.baseUrl}
                    </span>
                  </div>
                  <div>
                    <span className="block text-xs text-muted-foreground">
                      Max Output Tokens
                    </span>
                    <span className="text-foreground">{v.maxOutputTokens}</span>
                  </div>
                  <div>
                    <span className="block text-xs text-muted-foreground">
                      Capabilities
                    </span>
                    <span className="text-foreground">
                      {v.capabilityTags?.length
                        ? v.capabilityTags.join(", ")
                        : "None"}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
