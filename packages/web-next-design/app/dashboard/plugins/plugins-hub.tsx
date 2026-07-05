"use client"

// Plugins — a quiet, brand-forward MCP-plugin console. Two continuous surfaces
// (市场 / 已安装) under one page via a segmented switch, sharing the same card +
// grid. Categories are a light filter-chip rail (only 12 plugins — no nav tree);
// region (海外/国内) + auth are secondary facets. Detail opens in a centered
// Dialog. Replaces the empty faker "No plugins found" page.
import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Loader2, Search } from "lucide-react"
import type {
  MarketplacePluginView,
  PluginInstallationDetailView,
} from "@synapse/shared"
import { api } from "@/lib/api"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { MarketPluginCard, InstalledPluginCard } from "./plugin-card"
import { PluginDetailDialog } from "./plugin-detail-dialog"
import {
  pluginAuthLabel,
  pluginRegion,
  findMarketplacePlugin,
} from "@/lib/design/fixtures/mcp-plugins"

const GRID = "grid gap-3 sm:grid-cols-2 xl:grid-cols-3"

export default function PluginsHub() {
  const { workspaceId } = useWorkspace()
  const [tab, setTab] = useState<"market" | "installed">("market")
  const [q, setQ] = useState("")
  const [cat, setCat] = useState<string | null>(null)
  const [region, setRegion] = useState<string | null>(null)
  const [auth, setAuth] = useState<string | null>(null)
  const [detail, setDetail] = useState<{
    plugin: MarketplacePluginView
    installation: PluginInstallationDetailView | null
  } | null>(null)

  const marketQuery = useQuery({
    queryKey: ["plugin-marketplace", workspaceId],
    queryFn: () => api.getMarketplace(),
    enabled: !!workspaceId,
  })
  const installedQuery = useQuery({
    queryKey: ["plugin-installations", workspaceId],
    queryFn: () => api.getInstallations(workspaceId!),
    enabled: !!workspaceId,
  })
  const plugins = marketQuery.data ?? []
  const installations = installedQuery.data ?? []
  const installedByPluginId = useMemo(
    () => new Map(installations.map((i) => [i.pluginId, i])),
    [installations]
  )

  const categories = useMemo(() => {
    const seen = new Map<string, string>()
    for (const p of plugins)
      for (const c of p.categories) seen.set(c.slug, c.displayName)
    return [...seen.entries()]
  }, [plugins])
  const authLabels = useMemo(
    () => [...new Set(plugins.map(pluginAuthLabel))],
    [plugins]
  )

  const matches = (p: MarketplacePluginView) => {
    const n = q.trim().toLowerCase()
    if (cat && !p.categorySlugs.includes(cat)) return false
    if (region && pluginRegion(p.slug) !== region) return false
    if (auth && pluginAuthLabel(p) !== auth) return false
    if (
      n &&
      !`${p.displayName} ${p.description} ${p.tags.join(" ")}`
        .toLowerCase()
        .includes(n)
    )
      return false
    return true
  }

  const marketList = plugins.filter(matches)
  const installedList = installations
    .map((i) => ({ inst: i, plugin: findMarketplacePlugin(i.pluginId) }))
    .filter(
      (
        x
      ): x is {
        inst: PluginInstallationDetailView
        plugin: MarketplacePluginView
      } => !!x.plugin && matches(x.plugin)
    )

  const pending = marketQuery.isPending || installedQuery.isPending
  const hasFilters = !!(q || cat || region || auth)

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">插件</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          给 AI 团队接入外部工具的 MCP 插件
        </p>
      </div>

      {/* segment */}
      <div className="mb-4 inline-flex rounded-lg bg-muted p-0.5 text-sm">
        <Seg active={tab === "market"} onClick={() => setTab("market")}>
          市场
        </Seg>
        <Seg active={tab === "installed"} onClick={() => setTab("installed")}>
          已安装{installations.length > 0 ? ` · ${installations.length}` : ""}
        </Seg>
      </div>

      {/* filters */}
      <div className="mb-4 space-y-2">
        <div className="relative max-w-sm">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/50" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索插件…"
            className="h-9 pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip active={!cat} onClick={() => setCat(null)}>
            全部
          </Chip>
          {categories.map(([slug, label]) => (
            <Chip
              key={slug}
              active={cat === slug}
              onClick={() => setCat(cat === slug ? null : slug)}
            >
              {label}
            </Chip>
          ))}
          <span className="mx-1 h-4 w-px bg-border" />
          <Chip
            active={region === "china"}
            onClick={() => setRegion(region === "china" ? null : "china")}
          >
            国内
          </Chip>
          <Chip
            active={region === "overseas"}
            onClick={() => setRegion(region === "overseas" ? null : "overseas")}
          >
            海外
          </Chip>
          <span className="mx-1 h-4 w-px bg-border" />
          {authLabels.map((a) => (
            <Chip
              key={a}
              active={auth === a}
              onClick={() => setAuth(auth === a ? null : a)}
            >
              {a}
            </Chip>
          ))}
        </div>
      </div>

      {/* body */}
      {pending ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : tab === "market" ? (
        marketList.length === 0 ? (
          <Empty
            hasFilters={hasFilters}
            onClear={() => {
              setQ("")
              setCat(null)
              setRegion(null)
              setAuth(null)
            }}
          />
        ) : (
          <div className={GRID}>
            {marketList.map((p) => (
              <MarketPluginCard
                key={p.id}
                plugin={p}
                installed={installedByPluginId.has(p.id)}
                onOpen={() =>
                  setDetail({
                    plugin: p,
                    installation: installedByPluginId.get(p.id) ?? null,
                  })
                }
              />
            ))}
          </div>
        )
      ) : installedList.length === 0 ? (
        <Empty
          installed
          hasFilters={hasFilters}
          onClear={() => {
            setQ("")
            setCat(null)
            setRegion(null)
            setAuth(null)
          }}
        />
      ) : (
        <div className={GRID}>
          {installedList.map(({ inst, plugin }) => (
            <InstalledPluginCard
              key={inst.id}
              inst={inst}
              plugin={plugin}
              onOpen={() => setDetail({ plugin, installation: inst })}
            />
          ))}
        </div>
      )}

      <PluginDetailDialog
        plugin={detail?.plugin ?? null}
        installation={detail?.installation ?? null}
        open={!!detail}
        onOpenChange={(o) => !o && setDetail(null)}
      />
    </div>
  )
}

function Seg({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-3 py-1 transition",
        active
          ? "bg-background shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-2.5 py-1 text-xs transition",
        active
          ? "bg-secondary text-secondary-foreground"
          : "bg-muted text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

function Empty({
  installed,
  hasFilters,
  onClear,
}: {
  installed?: boolean
  hasFilters: boolean
  onClear: () => void
}) {
  return (
    <div className="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
      {hasFilters ? (
        <>
          没有匹配的插件 ·{" "}
          <button className="text-primary hover:underline" onClick={onClear}>
            清除筛选
          </button>
        </>
      ) : installed ? (
        "还没有安装任何插件 · 去市场看看"
      ) : (
        "暂无插件"
      )}
    </div>
  )
}
