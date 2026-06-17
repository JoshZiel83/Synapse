"use client"

import { useDeferredValue, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { ChevronDown, Search } from "lucide-react"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import {
  AppCard,
  AppCardContent,
  AppCardDescription,
  AppCardHeader,
  AppCardTitle,
} from "@/components/app-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { usePluginStore } from "@/stores/plugin-store"
import { PluginIcon, getLocale, translate } from "./plugin-ui"

export default function PluginsPage() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const {
    marketplace,
    installations,
    loadingMarketplace,
    loadMarketplace,
    loadInstallations,
  } = usePluginStore()

  const [search, setSearch] = useState("")
  const locale = getLocale()
  const deferredSearch = useDeferredValue(search)

  useEffect(() => {
    void loadMarketplace()
  }, [loadMarketplace])

  useEffect(() => {
    if (!workspaceId) return
    void loadInstallations(workspaceId)
  }, [loadInstallations, workspaceId])

  const pluginInstallationsByPluginId = useMemo(() => {
    const next = new Map<string, typeof installations>()

    for (const installation of installations) {
      const pluginId = installation.pluginId
      if (!pluginId) continue
      const current = next.get(pluginId) || []
      current.push(installation)
      next.set(pluginId, current)
    }

    return next
  }, [installations])

  const filteredPlugins = useMemo(() => {
    const normalizedSearch = deferredSearch.trim().toLowerCase()

    return marketplace.filter((plugin) => {
      if (!normalizedSearch) return true
      const title =
        translate(
          plugin.displayNameI18n,
          locale,
          plugin.defaultLocale || "en"
        ) ||
        plugin.displayName ||
        ""
      const summary =
        translate(
          plugin.summaryI18n || plugin.descriptionI18n,
          locale,
          plugin.defaultLocale || "en"
        ) ||
        plugin.description ||
        ""
      const haystack = [
        title,
        summary,
        plugin.orgDisplayName || "",
        ...(plugin.tags || []),
      ]
        .join(" ")
        .toLowerCase()

      return haystack.includes(normalizedSearch)
    })
  }, [deferredSearch, locale, marketplace])

  const configuredPlugins = useMemo(
    () =>
      filteredPlugins.filter(
        (plugin) =>
          (pluginInstallationsByPluginId.get(plugin.id) || []).length > 0
      ),
    [filteredPlugins, pluginInstallationsByPluginId]
  )

  const unconfiguredPlugins = useMemo(
    () =>
      filteredPlugins.filter(
        (plugin) =>
          (pluginInstallationsByPluginId.get(plugin.id) || []).length === 0
      ),
    [filteredPlugins, pluginInstallationsByPluginId]
  )

  const loading = loadingMarketplace

  return (
    <div className="flex flex-col gap-6 pt-3 sm:pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search plugins"
            className="pl-10"
          />
        </div>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          Loading plugins...
        </div>
      ) : filteredPlugins.length === 0 ? (
        <div className="rounded-[28px] border border-dashed border-border px-6 py-14 text-center">
          <div className="text-base font-medium text-foreground">
            No plugins found
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            Try a different search.
          </div>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {[...configuredPlugins, ...unconfiguredPlugins].map((plugin) => {
            const title =
              translate(
                plugin.displayNameI18n,
                locale,
                plugin.defaultLocale || "en"
              ) ||
              plugin.displayName ||
              "Untitled plugin"
            const summary =
              translate(
                plugin.summaryI18n || plugin.descriptionI18n,
                locale,
                plugin.defaultLocale || "en"
              ) ||
              plugin.description ||
              ""
            const pluginInstallations =
              pluginInstallationsByPluginId.get(plugin.id) || []
            const primaryInstallation = pluginInstallations[0]
            const configHref =
              pluginInstallations.length > 1
                ? `/dashboard/plugins/${plugin.id}`
                : primaryInstallation
                  ? `/dashboard/plugins/installations/${primaryInstallation.id}`
                  : `/dashboard/plugins/${plugin.id}`

            return (
              <AppCard
                key={plugin.id}
                variant="interactive"
                size="sm"
                onClick={() => router.push(`/dashboard/plugins/${plugin.id}`)}
              >
                <AppCardHeader className="gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <PluginIcon
                        iconUrl={plugin.iconUrl}
                        title={title}
                        transport={plugin.transport}
                        containerClassName="size-14 rounded-[18px]"
                        className="size-6"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <AppCardTitle className="truncate text-sm">
                            {title}
                          </AppCardTitle>
                        </div>
                        <AppCardDescription className="mt-1 line-clamp-2 text-xs leading-5">
                          {summary || "No description provided."}
                        </AppCardDescription>
                      </div>
                    </div>

                    {pluginInstallations.length > 0 ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0 gap-2 rounded-full"
                            onClick={(event) => event.stopPropagation()}
                          >
                            Manage
                            <ChevronDown className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuItem
                            onSelect={() => router.push(configHref)}
                          >
                            {pluginInstallations.length > 1
                              ? "Open configurations"
                              : "Open configuration"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              router.push(
                                `/dashboard/plugins/${plugin.id}/install`
                              )
                            }
                          >
                            Install new configuration
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <Button
                        size="sm"
                        className="shrink-0 rounded-full"
                        onClick={(event) => {
                          event.stopPropagation()
                          router.push(`/dashboard/plugins/${plugin.id}/install`)
                        }}
                      >
                        Install
                      </Button>
                    )}
                  </div>
                </AppCardHeader>

                <AppCardContent className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    {plugin.orgDisplayName ? (
                      <Badge variant="secondary">{plugin.orgDisplayName}</Badge>
                    ) : null}
                    {(plugin.categories || []).slice(0, 2).map((category) => (
                      <Badge key={category.slug} variant="secondary">
                        {translate(
                          category.displayNameI18n,
                          locale,
                          category.defaultLocale || "en"
                        ) || category.displayName}
                      </Badge>
                    ))}
                    {pluginInstallations.length > 0 ? (
                      <Badge variant="outline">
                        {pluginInstallations.length} installation
                        {pluginInstallations.length > 1 ? "s" : ""}
                      </Badge>
                    ) : null}
                  </div>
                </AppCardContent>
              </AppCard>
            )
          })}
        </div>
      )}
    </div>
  )
}
