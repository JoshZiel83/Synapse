"use client"

import QRCode from "qrcode"
import type {
  RelayDashboardView,
  RelayDeviceSummaryView,
  RelayLocalDesktopStatusView,
  RelayPairingSessionView,
} from "@synapse/shared"
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react"
import Image from "next/image"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ChevronDown,
  Copy,
  Link2,
  Monitor,
  MonitorUp,
  Plus,
  Radio,
  Search,
  Send,
  Settings,
  Wifi,
  WifiOff,
  XCircle,
} from "lucide-react"

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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import {
  buildRelayDesktopDeepLink,
  probeLocalRelayDesktop,
  sendPairingToLocalRelayDesktop,
} from "@/lib/relay-local"
import { usePluginStore } from "@/stores/plugin-store"
import { toast } from "sonner"
import { PluginIcon, getLocale, translate } from "./plugin-ui"

function formatDateTime(value?: string) {
  if (!value) return "Never"
  return new Date(value).toLocaleString()
}

function pairingStatusVariant(status: RelayPairingSessionView["status"]) {
  switch (status) {
    case "consumed":
      return "secondary"
    case "expired":
    case "cancelled":
    case "rejected":
      return "destructive"
    default:
      return "outline"
  }
}

function relayTrustVariant(trustStatus: RelayDeviceSummaryView["trustStatus"]) {
  switch (trustStatus) {
    case "active":
      return "secondary"
    case "blocked":
    case "revoked":
      return "destructive"
    default:
      return "outline"
  }
}

function isOpenPairingStatus(status?: RelayPairingSessionView["status"]) {
  return status === "pending" || status === "confirmed"
}

type RelayDashboardPayload = Partial<RelayDashboardView> & {
  pairings?: RelayPairingSessionView[]
}

type PluginInstallationEntry = {
  id: string
  plugin_id?: string | null
}

type PluginMarketplaceCategory = {
  slug: string
  displayName?: string
  displayNameI18n?: Record<string, string>
  defaultLocale?: string
}

type PluginMarketplaceEntry = {
  id: string
  display_name?: string
  display_name_i18n?: Record<string, string>
  default_locale?: string
  summary_i18n?: Record<string, string>
  description_i18n?: Record<string, string>
  description?: string
  org_display_name?: string
  tags?: string[]
  categories?: PluginMarketplaceCategory[]
  icon_url?: string
  transport?: string
}

function normalizeRelayDashboard(
  dashboard?: RelayDashboardPayload | null
): RelayDashboardView {
  return {
    devices: Array.isArray(dashboard?.devices) ? dashboard.devices : [],
    pendingPairings: Array.isArray(dashboard?.pendingPairings)
      ? dashboard.pendingPairings
      : Array.isArray(dashboard?.pairings)
        ? dashboard.pairings
        : [],
  }
}

async function copyText(text: string, label: string) {
  await navigator.clipboard.writeText(text)
  toast.success(`${label} copied`)
}

function PairingQrCode({ value }: { value: string }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void QRCode.toDataURL(value, {
      width: 220,
      margin: 1,
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    })
      .then((nextImageUrl: string) => {
        if (!cancelled) {
          setImageUrl(nextImageUrl)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setImageUrl(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [value])

  return (
    <div className="flex min-h-60 items-center justify-center rounded-[28px] border border-border/70 bg-white p-4 shadow-sm">
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt="Relay pairing QR code"
          width={220}
          height={220}
          unoptimized
          className="size-[220px] rounded-[20px]"
        />
      ) : (
        <div className="text-sm text-slate-500">Generating QR code...</div>
      )}
    </div>
  )
}

export default function PluginsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { workspaceId } = useWorkspace()
  const {
    marketplace,
    installations,
    loadingMarketplace,
    loadMarketplace,
    loadInstallations,
  } = usePluginStore()

  const [relayDashboard, setRelayDashboard] = useState<RelayDashboardView>(
    normalizeRelayDashboard()
  )
  const [loadingRelays, setLoadingRelays] = useState(false)
  const [search, setSearch] = useState("")
  const [creatingPairing, setCreatingPairing] = useState(false)
  const [activePairing, setActivePairing] =
    useState<RelayPairingSessionView | null>(null)
  const [pairingOptionsOpen, setPairingOptionsOpen] = useState(false)
  const [localRelayDesktop, setLocalRelayDesktop] =
    useState<RelayLocalDesktopStatusView | null>(null)
  const [probingLocalRelayDesktop, setProbingLocalRelayDesktop] = useState(true)
  const [sendingToDesktop, setSendingToDesktop] = useState(false)
  const [sentToDesktopPairingId, setSentToDesktopPairingId] = useState<
    string | null
  >(null)
  const locale = getLocale()
  const deferredSearch = useDeferredValue(search)
  const activePairingId = activePairing?.id || null
  const typedMarketplace = marketplace as PluginMarketplaceEntry[]
  const typedInstallations = installations as PluginInstallationEntry[]

  const loadRelayDashboard = useCallback(
    async (showLoading = true): Promise<RelayDashboardView | null> => {
      if (!workspaceId) return null
      if (showLoading) setLoadingRelays(true)

      try {
        const data = await api.getRelayDashboard(workspaceId)
        const normalized = normalizeRelayDashboard(data)
        setRelayDashboard(normalized)
        return normalized
      } catch (error) {
        console.error("Failed to load relays:", error)
        toast.error(
          error instanceof Error ? error.message : "Failed to load relays"
        )
        return null
      } finally {
        if (showLoading) setLoadingRelays(false)
      }
    },
    [workspaceId]
  )

  const clearRelayPairingSearchParams = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString())
    next.delete("relayPairing")
    next.delete("code")
    const query = next.toString()
    router.replace(
      query ? `/dashboard/plugins?${query}` : "/dashboard/plugins",
      {
        scroll: false,
      }
    )
  }, [router, searchParams])

  const dismissActivePairing = useCallback(() => {
    setActivePairing(null)
    setPairingOptionsOpen(false)
    setSentToDesktopPairingId(null)
    clearRelayPairingSearchParams()
  }, [clearRelayPairingSearchParams])

  useEffect(() => {
    void loadMarketplace()
  }, [loadMarketplace])

  useEffect(() => {
    if (!workspaceId) return

    void loadInstallations(workspaceId)
    void loadRelayDashboard()
  }, [loadInstallations, loadRelayDashboard, workspaceId])

  useEffect(() => {
    if (!workspaceId) return

    const pairingId = searchParams.get("relayPairing")
    if (!pairingId || pairingId === activePairingId) return

    let cancelled = false

    void api
      .getRelayPairingSession(workspaceId, pairingId)
      .then(({ pairing }) => {
        if (cancelled) return
        setActivePairing(pairing)
      })
      .catch((error) => {
        if (cancelled) return
        console.error("Failed to load relay pairing from URL:", error)
      })

    return () => {
      cancelled = true
    }
  }, [activePairingId, searchParams, workspaceId])

  useEffect(() => {
    setPairingOptionsOpen(false)
    if (sentToDesktopPairingId && sentToDesktopPairingId !== activePairingId) {
      setSentToDesktopPairingId(null)
    }
  }, [activePairingId, sentToDesktopPairingId])

  useEffect(() => {
    if (
      !workspaceId ||
      !activePairing ||
      !isOpenPairingStatus(activePairing.status)
    )
      return

    let cancelled = false
    const interval = window.setInterval(() => {
      void api
        .getRelayPairingSession(workspaceId, activePairing.id)
        .then(async ({ pairing }) => {
          if (cancelled) return
          setActivePairing(pairing)

          if (pairing.status === "consumed") {
            const dashboard = await loadRelayDashboard(false)
            if (cancelled) return

            const pairedDevice = dashboard?.devices.find(
              (device) => device.id === pairing.deviceId
            )
            toast.success(
              pairedDevice?.isConnected
                ? "Relay paired and connected"
                : "Relay paired. Waiting for the desktop app to come online."
            )

            window.setTimeout(() => {
              if (!cancelled) dismissActivePairing()
            }, 1200)
            return
          }

          setRelayDashboard((current) => {
            const normalizedCurrent = normalizeRelayDashboard(current)
            return {
              ...normalizedCurrent,
              pendingPairings: normalizedCurrent.pendingPairings.map((item) =>
                item.id === pairing.id ? pairing : item
              ),
            }
          })
        })
        .catch((error) => {
          if (!cancelled)
            console.error("Failed to refresh relay pairing:", error)
        })
    }, 4000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [activePairing, dismissActivePairing, loadRelayDashboard, workspaceId])

  useEffect(() => {
    let cancelled = false

    async function refreshLocalRelayDesktop() {
      const next = await probeLocalRelayDesktop()
      if (cancelled) return
      setLocalRelayDesktop(next)
      setProbingLocalRelayDesktop(false)
    }

    void refreshLocalRelayDesktop()
    const interval = window.setInterval(() => {
      void refreshLocalRelayDesktop()
    }, 5000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

  const pluginInstallationsByPluginId = useMemo(() => {
    const next = new Map<string, PluginInstallationEntry[]>()

    for (const installation of typedInstallations) {
      const pluginId = installation.plugin_id
      if (!pluginId) continue
      const current = next.get(pluginId) || []
      current.push(installation)
      next.set(pluginId, current)
    }

    return next
  }, [typedInstallations])

  const filteredPlugins = useMemo(() => {
    const normalizedSearch = deferredSearch.trim().toLowerCase()

    return typedMarketplace.filter((plugin) => {
      if (!normalizedSearch) return true
      const title =
        translate(
          plugin.display_name_i18n,
          locale,
          plugin.default_locale || "en"
        ) ||
        plugin.display_name ||
        ""
      const summary =
        translate(
          plugin.summary_i18n || plugin.description_i18n,
          locale,
          plugin.default_locale || "en"
        ) ||
        plugin.description ||
        ""
      const haystack = [
        title,
        summary,
        plugin.org_display_name || "",
        ...(plugin.tags || []),
      ]
        .join(" ")
        .toLowerCase()

      return haystack.includes(normalizedSearch)
    })
  }, [deferredSearch, locale, typedMarketplace])

  const filteredRelays = useMemo(() => {
    const normalizedSearch = deferredSearch.trim().toLowerCase()
    if (!normalizedSearch) return relayDashboard.devices

    return relayDashboard.devices.filter((relay) =>
      [
        relay.title,
        relay.deviceType,
        relay.platform || "",
        relay.publicKeyFingerprint,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearch)
    )
  }, [deferredSearch, relayDashboard.devices])

  const filteredPairings = useMemo(() => {
    const normalizedSearch = deferredSearch.trim().toLowerCase()
    if (!normalizedSearch) return relayDashboard.pendingPairings

    return relayDashboard.pendingPairings.filter((pairing) =>
      [pairing.requestedDisplayName || "", pairing.pairingCode, pairing.status]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearch)
    )
  }, [deferredSearch, relayDashboard.pendingPairings])

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

  const latestPendingPairing = relayDashboard.pendingPairings[0] || null
  const activePairingIsPending = isOpenPairingStatus(activePairing?.status)
  const activePairingSentToDesktop = Boolean(
    activePairing && sentToDesktopPairingId === activePairing.id
  )

  const pairingHero = useMemo(() => {
    if (!activePairing) {
      return {
        title: "",
        description: "",
      }
    }

    if (activePairing.status === "consumed") {
      return {
        title: "Relay paired",
        description:
          "This device is now trusted. If it is not online yet, keep the desktop app open until it connects.",
      }
    }

    if (sendingToDesktop) {
      return {
        title: "Sending pairing request",
        description:
          "The local desktop app is being asked to confirm this relay pairing.",
      }
    }

    if (activePairingSentToDesktop) {
      return {
        title: "Confirm in the desktop app",
        description:
          "Accept the pairing request in the desktop app to finish binding this relay.",
      }
    }

    if (localRelayDesktop) {
      return {
        title: "Desktop relay detected",
        description:
          "The fastest path is to send this pairing to the local desktop app on this computer.",
      }
    }

    return {
      title: "Open the desktop relay app",
      description:
        "If the app is on this computer, open it now. Otherwise use the QR code or copy the pairing code.",
    }
  }, [
    activePairing,
    activePairingSentToDesktop,
    localRelayDesktop,
    sendingToDesktop,
  ])

  const loading = loadingMarketplace || loadingRelays

  async function createPairingSession(): Promise<RelayPairingSessionView | null> {
    if (!workspaceId) return null

    setCreatingPairing(true)
    try {
      const result = await api.createRelayPairingSession(workspaceId, {})
      setActivePairing(result.pairing)
      await loadRelayDashboard(false)
      toast.success("Relay pairing ready")
      return result.pairing
    } catch (error) {
      console.error("Failed to create relay pairing:", error)
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to create relay pairing"
      )
      return null
    } finally {
      setCreatingPairing(false)
    }
  }

  async function handleRefreshLocalRelayDesktop() {
    setProbingLocalRelayDesktop(true)
    const next = await probeLocalRelayDesktop()
    setLocalRelayDesktop(next)
    setProbingLocalRelayDesktop(false)
  }

  async function handleSendPairingToDesktop(
    pairingOverride?: RelayPairingSessionView | null
  ) {
    const pairing = pairingOverride || activePairing
    if (!pairing) return

    setSendingToDesktop(true)
    try {
      const response = await sendPairingToLocalRelayDesktop({
        serverBaseUrl: pairing.serverBaseUrl,
        pairingCode: pairing.pairingCode,
        title: pairing.requestedDisplayName,
      })
      setSentToDesktopPairingId(pairing.id)
      toast.success(
        response.message || "Pairing request sent to the desktop app"
      )
      await handleRefreshLocalRelayDesktop()
    } catch (error) {
      console.error("Failed to send pairing to local desktop client:", error)
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to send pairing to the desktop app"
      )
    } finally {
      setSendingToDesktop(false)
    }
  }

  function handleOpenDesktopApp(
    pairingOverride?: RelayPairingSessionView | null
  ) {
    const pairing = pairingOverride || activePairing
    if (!pairing) return
    window.location.href = buildRelayDesktopDeepLink(pairing)
  }

  async function handleStartPairing() {
    let pairing: RelayPairingSessionView | null = latestPendingPairing
    if (!pairing) {
      pairing = await createPairingSession()
    } else {
      setActivePairing(pairing)
    }

    if (!pairing) return

    if (localRelayDesktop) {
      await handleSendPairingToDesktop(pairing)
      return
    }

    handleOpenDesktopApp(pairing)
  }

  async function handleCancelPairing() {
    if (!workspaceId || !activePairing) return

    try {
      await api.cancelRelayPairingSession(workspaceId, activePairing.id)
      await loadRelayDashboard(false)
      toast.success("Relay pairing cancelled")
      dismissActivePairing()
    } catch (error) {
      console.error("Failed to cancel relay pairing:", error)
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to cancel relay pairing"
      )
    }
  }

  return (
    <div className="flex flex-col gap-6 pt-3 sm:pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search plugins, pairings, and relays"
            className="pl-10"
          />
        </div>

        <Button
          type="button"
          onClick={() => void handleStartPairing()}
          disabled={creatingPairing}
        >
          <Plus data-icon="inline-start" />
          {creatingPairing
            ? "Preparing..."
            : latestPendingPairing
              ? "Resume Relay Setup"
              : "Connect Relay"}
        </Button>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          Loading plugins...
        </div>
      ) : filteredPlugins.length === 0 &&
        filteredRelays.length === 0 &&
        filteredPairings.length === 0 ? (
        <div className="rounded-[28px] border border-dashed border-border px-6 py-14 text-center">
          <div className="text-base font-medium text-foreground">
            No plugins or relay devices found
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            Try a different search or connect a desktop relay.
          </div>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filteredPairings.map((pairing) => (
            <AppCard
              key={pairing.id}
              variant="interactive"
              size="sm"
              onClick={() => setActivePairing(pairing)}
            >
              <AppCardHeader className="gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-14 items-center justify-center rounded-[18px] border border-border/70 bg-muted/30">
                      <Monitor className="size-6 text-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <AppCardTitle className="truncate text-sm">
                          {pairing.requestedDisplayName || pairing.pairingCode}
                        </AppCardTitle>
                        <Badge variant="outline">Pairing</Badge>
                      </div>
                      <AppCardDescription className="mt-1 text-xs">
                        Code {pairing.pairingCode}
                      </AppCardDescription>
                    </div>
                  </div>

                  <Badge variant={pairingStatusVariant(pairing.status)}>
                    {pairing.status}
                  </Badge>
                </div>
              </AppCardHeader>

              <AppCardContent className="flex flex-col gap-3">
                <div className="text-xs leading-5 text-muted-foreground">
                  Expires {formatDateTime(pairing.expiresAt)}. Open to continue
                  the setup.
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">One-time code</Badge>
                  {pairing.deviceId ? (
                    <Badge variant="outline">Device claimed</Badge>
                  ) : null}
                </div>
              </AppCardContent>
            </AppCard>
          ))}

          {filteredRelays.map((relay) => (
            <AppCard
              key={relay.id}
              variant="interactive"
              size="sm"
              onClick={() =>
                router.push(`/dashboard/plugins/relays/${relay.id}`)
              }
            >
              <AppCardHeader className="gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-14 items-center justify-center rounded-[18px] border border-border/70 bg-muted/30">
                      <Radio className="size-6 text-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <AppCardTitle className="truncate text-sm">
                          {relay.title}
                        </AppCardTitle>
                        <Badge variant="outline">Relay</Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {relay.isConnected ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Wifi className="size-4 text-foreground" />
                            Connected
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <WifiOff className="size-4 text-muted-foreground" />
                            Offline
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <Button
                    type="button"
                    size="sm"
                    className="shrink-0"
                    onClick={(event) => {
                      event.stopPropagation()
                      router.push(`/dashboard/plugins/relays/${relay.id}`)
                    }}
                  >
                    <Settings data-icon="inline-start" />
                    Manage
                  </Button>
                </div>
              </AppCardHeader>

              <AppCardContent className="flex flex-col gap-3">
                <div className="text-xs leading-5 text-muted-foreground">
                  {relay.deviceType}
                  {relay.platform ? ` on ${relay.platform}` : ""}.{" "}
                  {relay.exposureCount} MCP exposure
                  {relay.exposureCount === 1 ? "" : "s"} and {relay.toolCount}{" "}
                  tool
                  {relay.toolCount === 1 ? "" : "s"}.
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={relayTrustVariant(relay.trustStatus)}>
                    {relay.trustStatus}
                  </Badge>
                  <Badge variant="secondary">
                    {relay.exposureCount} exposures
                  </Badge>
                  <Badge variant="outline">
                    Last seen{" "}
                    {relay.lastSeenAt
                      ? formatDateTime(relay.lastSeenAt)
                      : "Never"}
                  </Badge>
                </div>
              </AppCardContent>
            </AppCard>
          ))}

          {[...configuredPlugins, ...unconfiguredPlugins].map((plugin) => {
            const title =
              translate(
                plugin.display_name_i18n,
                locale,
                plugin.default_locale || "en"
              ) ||
              plugin.display_name ||
              "Untitled plugin"
            const summary =
              translate(
                plugin.summary_i18n || plugin.description_i18n,
                locale,
                plugin.default_locale || "en"
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
                        iconUrl={plugin.icon_url}
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
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                          {summary || "No description provided."}
                        </div>
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
                    {plugin.org_display_name ? (
                      <Badge variant="secondary">
                        {plugin.org_display_name}
                      </Badge>
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

          <AppCard
            variant="interactive-dashed"
            size="sm"
            onClick={() => void handleStartPairing()}
          >
            <AppCardHeader className="gap-3">
              <div className="flex items-start gap-3">
                <div className="flex size-14 items-center justify-center rounded-[18px] border border-dashed border-border/80 bg-background/80">
                  <Plus className="size-6 text-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <AppCardTitle className="truncate text-sm">
                    Connect Relay
                  </AppCardTitle>
                  <div className="mt-1 text-xs leading-5 text-muted-foreground">
                    Start the fastest relay setup path for a desktop app.
                  </div>
                </div>
              </div>
            </AppCardHeader>

            <AppCardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">Smart pairing</Badge>
                <Badge variant="outline">Falls back to QR or code</Badge>
              </div>
            </AppCardContent>
          </AppCard>
        </div>
      )}

      <Dialog
        open={activePairing !== null}
        onOpenChange={(open) => !open && dismissActivePairing()}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Connect Relay</DialogTitle>
            <DialogDescription>
              The web app will prefer the local desktop route first, then fall
              back to QR and manual pairing only when needed.
            </DialogDescription>
          </DialogHeader>

          {activePairing ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-[28px] border border-border/70 bg-muted/20 px-5 py-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-lg font-semibold text-foreground">
                      {pairingHero.title}
                    </div>
                    <div className="mt-2 text-sm leading-6 text-muted-foreground">
                      {pairingHero.description}
                    </div>
                  </div>
                  <Badge variant={pairingStatusVariant(activePairing.status)}>
                    {activePairing.status}
                  </Badge>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Badge variant="outline">
                    Expires {formatDateTime(activePairing.expiresAt)}
                  </Badge>
                  <Badge variant={localRelayDesktop ? "secondary" : "outline"}>
                    {localRelayDesktop
                      ? "Desktop app detected"
                      : probingLocalRelayDesktop
                        ? "Checking this computer"
                        : "No local app detected"}
                  </Badge>
                  {activePairingSentToDesktop ? (
                    <Badge variant="secondary">Sent to desktop</Badge>
                  ) : null}
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                  {activePairing.status === "consumed" ? (
                    activePairing.deviceId ? (
                      <Button
                        type="button"
                        onClick={() => {
                          const deviceId = activePairing.deviceId
                          dismissActivePairing()
                          router.push(`/dashboard/plugins/relays/${deviceId}`)
                        }}
                      >
                        <Settings data-icon="inline-start" />
                        View Relay
                      </Button>
                    ) : null
                  ) : localRelayDesktop ? (
                    <>
                      <Button
                        type="button"
                        onClick={() => void handleSendPairingToDesktop()}
                        disabled={sendingToDesktop}
                      >
                        <Send data-icon="inline-start" />
                        {sendingToDesktop
                          ? "Sending..."
                          : activePairingSentToDesktop
                            ? "Waiting For Confirmation"
                            : "Send To Desktop"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setPairingOptionsOpen(true)}
                      >
                        <Link2 data-icon="inline-start" />
                        Other Ways
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        type="button"
                        onClick={() => handleOpenDesktopApp()}
                      >
                        <MonitorUp data-icon="inline-start" />
                        Open Desktop App
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setPairingOptionsOpen(true)}
                      >
                        <Link2 data-icon="inline-start" />
                        Other Ways
                      </Button>
                    </>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-4">
                <div className="text-xs tracking-wide text-muted-foreground uppercase">
                  Local Desktop App
                </div>

                <div className="mt-3 text-sm font-medium text-foreground">
                  {localRelayDesktop
                    ? localRelayDesktop.title || "Desktop relay detected"
                    : probingLocalRelayDesktop
                      ? "Looking for a local relay app"
                      : "No local relay app detected"}
                </div>
                <div className="mt-2 text-sm leading-6 text-muted-foreground">
                  {localRelayDesktop
                    ? `Version ${localRelayDesktop.version}. Relay state: ${localRelayDesktop.relay || "unknown"}.`
                    : "The browser checks 127.0.0.1:21519 for the local desktop relay bridge."}
                </div>

                {localRelayDesktop ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge
                      variant={
                        localRelayDesktop.paired ? "secondary" : "outline"
                      }
                    >
                      {localRelayDesktop.paired ? "paired" : "unpaired"}
                    </Badge>
                    <Badge
                      variant={
                        localRelayDesktop.serverIdentityPinned
                          ? "secondary"
                          : "outline"
                      }
                    >
                      {localRelayDesktop.serverIdentityPinned
                        ? "server pinned"
                        : "server pin missing"}
                    </Badge>
                  </div>
                ) : null}

                {localRelayDesktop?.serverBaseUrl &&
                localRelayDesktop.serverBaseUrl !==
                  activePairing.serverBaseUrl ? (
                  <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                    This desktop app is currently pointed at a different Synapse
                    server. The app can still confirm this pairing, but the user
                    will be asked to review the server switch.
                  </div>
                ) : null}

                {localRelayDesktop?.authFailureMessage ? (
                  <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                    Relay auth failed
                    {localRelayDesktop.authFailurePermanent
                      ? " permanently"
                      : ""}
                    : {localRelayDesktop.authFailureMessage}
                  </div>
                ) : null}
              </div>

              <div className="rounded-2xl border border-border/70 bg-muted/10 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      Other Ways
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      QR, link, or code for another device.
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPairingOptionsOpen((current) => !current)}
                  >
                    {pairingOptionsOpen ? "Hide" : "Show"}
                    <ChevronDown
                      className={`size-4 transition-transform ${
                        pairingOptionsOpen ? "rotate-180" : ""
                      }`}
                    />
                  </Button>
                </div>

                {pairingOptionsOpen ? (
                  <div className="mt-4 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
                    <PairingQrCode
                      value={
                        activePairing.verificationUriComplete ||
                        activePairing.verificationUri
                      }
                    />
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline">Another device</Badge>
                        <Badge variant="outline">Manual code</Badge>
                      </div>
                      <div className="rounded-2xl border border-border/60 bg-background/80 px-4 py-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-xs tracking-wide text-muted-foreground uppercase">
                            Code
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void copyText(
                                activePairing.pairingCode,
                                "Pairing code"
                              )
                            }
                          >
                            <Copy data-icon="inline-start" />
                            Copy
                          </Button>
                        </div>
                        <div className="mt-3 font-mono text-3xl tracking-[0.08em] break-all text-foreground">
                          {activePairing.pairingCode}
                        </div>
                      </div>
                      <div className="rounded-2xl border border-border/60 bg-background/80 px-4 py-3 text-sm text-muted-foreground">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-xs tracking-wide uppercase">
                            Link
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void copyText(
                                activePairing.verificationUriComplete ||
                                  activePairing.verificationUri,
                                "Verification link"
                              )
                            }
                          >
                            <Link2 data-icon="inline-start" />
                            Copy
                          </Button>
                        </div>
                        <div className="mt-2 break-all text-foreground">
                          {activePairing.verificationUriComplete ||
                            activePairing.verificationUri}
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Manual: server address + code.
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <DialogFooter className="justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              {activePairing && activePairingIsPending ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleCancelPairing()}
                >
                  <XCircle data-icon="inline-start" />
                  Cancel Pairing
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => dismissActivePairing()}
              >
                {activePairing?.status === "consumed" ? "Close" : "Done"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
