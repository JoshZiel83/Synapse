"use client"

// Settings → Runtime Authorizations.
//
// Closes the active-page chat UX dead-end: when a browser tool returns
// "Manual grant required" (because its target is current_page / page_id /
// all_pages and origin can't be known server-side), the chat card directs
// the operator here. This page lets them pick a device capability, type
// the target origin/host/registrableDomain, choose the operation(s), and
// POST to `/api/v1/workspaces/:wsId/runtime-authorization-grants`.
//
// MVP scope: workspace-scope grants only (matches the API endpoint).

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { ArrowLeft, Loader2, Shield } from "lucide-react"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { DeviceDetailView, DeviceSummaryView } from "@/lib/device-views"

// Mirrors RUNTIME_AUTHORIZATION_BROWSER_OPERATIONS in @synapse/device-protocol
// — duplicated here intentionally so the settings page doesn't pull the
// whole protocol package into the web bundle.
const BROWSER_OPERATIONS = [
  "page.read",
  "page.navigate",
  "page.input",
  "screenshot.capture",
  "console.read",
  "network.list",
  "network.body.read",
  "script.evaluate",
  "performance.trace",
] as const

type ScopeType = "origin" | "host" | "domain"
type BrowserOp = (typeof BROWSER_OPERATIONS)[number]

interface CapabilityRow {
  deviceId: string
  deviceTitle: string
  capabilityId: string
  displayName: string
  builtinKind: string | null
  exposureMetadata: Record<string, unknown> | null
}

export default function RuntimeAuthorizationsSettingsPage() {
  const { workspaceId } = useWorkspace()
  const [devices, setDevices] = useState<DeviceSummaryView[] | null>(null)
  const [capabilities, setCapabilities] = useState<CapabilityRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submittedMsg, setSubmittedMsg] = useState<string | null>(null)

  // form state
  const [capabilityId, setCapabilityId] = useState<string>("")
  const [action, setAction] = useState<"read" | "write">("read")
  const [scopeType, setScopeType] = useState<ScopeType>("origin")
  const [scopeValue, setScopeValue] = useState("")
  const [selectedOps, setSelectedOps] = useState<Set<BrowserOp>>(new Set())

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    api
      .listDevices(workspaceId)
      .then(async ({ devices: deviceList }) => {
        if (cancelled) return
        setDevices(deviceList)
        // Load each device's capabilities so the operator can pick.
        const all: CapabilityRow[] = []
        for (const device of deviceList) {
          try {
            const detail: DeviceDetailView = await api.getDevice(
              workspaceId,
              device.id
            )
            for (const cap of detail.capabilities) {
              all.push({
                deviceId: device.id,
                deviceTitle: device.title,
                capabilityId: cap.id,
                displayName: cap.display_name,
                builtinKind: cap.builtin_kind ?? null,
                exposureMetadata: cap.metadata ?? null,
              })
            }
          } catch {
            /* skip — best effort */
          }
        }
        if (!cancelled) setCapabilities(all)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const selectedCap = useMemo(
    () => capabilities?.find((c) => c.capabilityId === capabilityId) ?? null,
    [capabilities, capabilityId]
  )

  function toggleOp(op: BrowserOp) {
    setSelectedOps((prev) => {
      const next = new Set(prev)
      if (next.has(op)) next.delete(op)
      else next.add(op)
      return next
    })
  }

  async function submit() {
    if (!workspaceId) return
    setError(null)
    setSubmittedMsg(null)
    if (!capabilityId) {
      setError("Pick a device capability")
      return
    }
    if (!scopeValue.trim()) {
      setError("Enter the target origin / host / domain")
      return
    }
    if (selectedOps.size === 0) {
      setError("Pick at least one operation")
      return
    }
    const policy: Record<string, unknown> = {
      capability: selectedCap?.builtinKind ?? "browser",
    }
    if (selectedCap?.builtinKind === "browser") {
      const browser: Record<string, unknown> = {
        action,
        scopeType,
        operations: [...selectedOps],
      }
      if (scopeType === "origin") browser.origin = scopeValue.trim()
      else if (scopeType === "host") browser.host = scopeValue.trim()
      else if (scopeType === "domain")
        browser.registrableDomain = scopeValue.trim()
      policy.browser = browser
    } else {
      setError(
        "Manual grants for non-browser capabilities are not yet supported in this page."
      )
      return
    }

    setSubmitting(true)
    try {
      await api.createManualRuntimeAuthorizationGrant(workspaceId, {
        device_capability_id: capabilityId,
        policy,
      })
      setSubmittedMsg(
        `Grant created. Retry the original tool call — it should now succeed.`
      )
      setScopeValue("")
      setSelectedOps(new Set())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const browserCaps =
    capabilities?.filter((c) => c.builtinKind === "browser") ?? []

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-center gap-3">
        <Link href="/dashboard">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="size-4" /> Back
          </Button>
        </Link>
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Shield className="size-5" /> Runtime Authorizations
          </h1>
          <p className="text-sm text-muted-foreground">
            Manually grant a workspace-scope authorization for a device
            capability. Use this when the chat card shows{" "}
            <strong>Manual grant required</strong> — the chat-side approval flow
            can&apos;t fill in a target origin for tools that act on the
            browser&apos;s currently selected page.
          </p>
        </div>
      </header>

      {error ? (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {submittedMsg ? (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
          {submittedMsg}
        </div>
      ) : null}

      {devices === null || capabilities === null ? (
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading device
          capabilities…
        </div>
      ) : browserCaps.length === 0 ? (
        <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
          No browser capabilities found in this workspace. Pair a device with
          the chrome-devtools-mcp provider enabled first.
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Device capability</label>
            <select
              value={capabilityId}
              onChange={(e) => setCapabilityId(e.target.value)}
              className="mt-1 w-full rounded border bg-background p-2 text-sm"
            >
              <option value="">— pick a capability —</option>
              {browserCaps.map((c) => {
                const disabled =
                  c.exposureMetadata &&
                  typeof c.exposureMetadata === "object" &&
                  (c.exposureMetadata as { enabled?: unknown }).enabled ===
                    false
                return (
                  <option
                    key={c.capabilityId}
                    value={c.capabilityId}
                    disabled={Boolean(disabled)}
                  >
                    {c.deviceTitle} — {c.displayName}
                    {disabled ? " (disabled)" : ""}
                  </option>
                )
              })}
            </select>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="text-sm font-medium">Action</label>
              <select
                value={action}
                onChange={(e) => setAction(e.target.value as "read" | "write")}
                className="mt-1 w-full rounded border bg-background p-2 text-sm"
              >
                <option value="read">read</option>
                <option value="write">write</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Scope type</label>
              <select
                value={scopeType}
                onChange={(e) => setScopeType(e.target.value as ScopeType)}
                className="mt-1 w-full rounded border bg-background p-2 text-sm"
              >
                <option value="origin">origin (https://host[:port])</option>
                <option value="host">host (lowercased)</option>
                <option value="domain">domain (registrable, via PSL)</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Value</label>
              <Input
                value={scopeValue}
                onChange={(e) => setScopeValue(e.target.value)}
                placeholder={
                  scopeType === "origin"
                    ? "https://example.com"
                    : scopeType === "host"
                      ? "example.com"
                      : "example.com"
                }
                className="mt-1"
              />
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">Operations</label>
            <div className="mt-1 flex flex-wrap gap-2">
              {BROWSER_OPERATIONS.map((op) => {
                const checked = selectedOps.has(op)
                return (
                  <button
                    type="button"
                    key={op}
                    onClick={() => toggleOp(op)}
                    className={`rounded border px-3 py-1 text-xs ${
                      checked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border"
                    }`}
                  >
                    {op}
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              The runtime fails closed if a tool needs an operation that
              isn&apos;t in this list. Pick exactly what the chat-card denial
              text said it needed.
            </p>
          </div>

          <Button onClick={submit} disabled={submitting}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Shield className="size-4" />
            )}
            <span>Create workspace-scope grant</span>
          </Button>
        </div>
      )}
    </div>
  )
}
