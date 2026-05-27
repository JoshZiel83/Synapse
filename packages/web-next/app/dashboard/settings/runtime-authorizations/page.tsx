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
import { ApiError, api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { DeviceDetailView, DeviceSummaryView } from "@/lib/device-views"

// Mirrors the maps in @synapse/device-protocol/browser-tools. Duplicated
// here intentionally so the settings page doesn't pull the whole protocol
// package into the web bundle.
//
// Keep in lockstep with:
//   - BROWSER_OPERATION_REQUIRED_ACTION in browser-tools.ts (derives the
//     minimum action needed for an op)
//   - BROWSER_EXPOSURE_TOOLS + BROWSER_TOOL_MAP (which ops each exposure
//     can ever ask for)
const ALL_BROWSER_OPERATIONS = [
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

type BrowserOp = (typeof ALL_BROWSER_OPERATIONS)[number]
type ScopeType = "origin" | "host" | "domain"

const WRITE_OPS: ReadonlySet<BrowserOp> = new Set([
  "page.navigate",
  "page.input",
  "script.evaluate",
])

/** Maps the exposure stable_key suffix → operations its tools can need. */
const OPERATIONS_BY_EXPOSURE: Record<string, readonly BrowserOp[]> = {
  navigation: ["page.read", "page.navigate"],
  read: ["page.read", "screenshot.capture", "console.read"],
  input: ["page.input"],
  network: ["network.list", "network.body.read"],
  performance: ["performance.trace"],
  script: ["script.evaluate"],
  // extensions / webmcp deliberately omitted — MVP-disabled exposures.
}

interface CapabilityRow {
  deviceId: string
  deviceTitle: string
  capabilityId: string
  displayName: string
  builtinKind: string | null
  exposureStableKey: string | null
  exposureMetadata: Record<string, unknown> | null
}

export default function RuntimeAuthorizationsSettingsPage() {
  const { workspaceId } = useWorkspace()
  const [devices, setDevices] = useState<DeviceSummaryView[] | null>(null)
  const [capabilities, setCapabilities] = useState<CapabilityRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<unknown>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submittedMsg, setSubmittedMsg] = useState<string | null>(null)

  // form state — action is derived from `selectedOps`, not stored.
  const [capabilityId, setCapabilityId] = useState<string>("")
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
                exposureStableKey: cap.exposure_stable_key ?? null,
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

  // Filter the operation chip list down to the operations the SELECTED
  // exposure can actually request — picking page.input under a "read"
  // exposure would just produce an "operations_not_allowed_for_exposure"
  // 400 from the API.
  const availableOps: readonly BrowserOp[] = useMemo(() => {
    if (!selectedCap) return ALL_BROWSER_OPERATIONS
    // Derive the suffix from `builtin/browser/<key>`. lite-provider
    // capabilities (`builtin/browser`) fall through to the full list.
    const stable = selectedCap.exposureStableKey ?? ""
    const m = stable.match(/^builtin\/browser\/(.+)$/)
    if (!m) return ALL_BROWSER_OPERATIONS
    return OPERATIONS_BY_EXPOSURE[m[1]] ?? ALL_BROWSER_OPERATIONS
  }, [selectedCap])

  // Drop ops that are no longer valid for the selected exposure whenever
  // the user switches capability (otherwise stale chips silently survive).
  useEffect(() => {
    setSelectedOps((prev) => {
      const next = new Set<BrowserOp>()
      const allow = new Set(availableOps)
      for (const op of prev) if (allow.has(op)) next.add(op)
      return next
    })
  }, [availableOps])

  // Derived action: write covers read. If any selected op is write-only
  // we must request `write`; otherwise `read` is enough.
  const derivedAction: "read" | "write" = useMemo(() => {
    for (const op of selectedOps) {
      if (WRITE_OPS.has(op)) return "write"
    }
    return "read"
  }, [selectedOps])

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
    setErrorDetails(null)
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
    if (selectedCap?.builtinKind !== "browser") {
      setError(
        "Manual grants for non-browser capabilities are not yet supported in this page."
      )
      return
    }
    const browser: Record<string, unknown> = {
      action: derivedAction,
      scopeType,
      operations: [...selectedOps],
    }
    if (scopeType === "origin") browser.origin = scopeValue.trim()
    else if (scopeType === "host") browser.host = scopeValue.trim()
    else if (scopeType === "domain")
      browser.registrableDomain = scopeValue.trim()
    const policy = { capability: "browser", browser }

    setSubmitting(true)
    try {
      await api.createManualRuntimeAuthorizationGrant(workspaceId, {
        device_capability_id: capabilityId,
        policy,
      })
      setSubmittedMsg(
        `Grant created (action=${derivedAction}). Retry the original tool call — it should now succeed.`
      )
      setScopeValue("")
      setSelectedOps(new Set())
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setErrorDetails(err.details)
      } else {
        setError((err as Error).message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const browserCaps =
    capabilities?.filter((c) => c.builtinKind === "browser") ?? []

  // Pull useful structured bits out of the API error for display. The
  // manual-grants endpoint returns `{code, message, allowed?, field?, ...}`.
  const errorDetailView = (() => {
    if (!errorDetails || typeof errorDetails !== "object") return null
    const d = errorDetails as Record<string, unknown>
    const code = typeof d.code === "string" ? d.code : null
    const field = typeof d.field === "string" ? d.field : null
    const allowed = Array.isArray(d.allowed) ? (d.allowed as string[]) : null
    if (!code && !field && !allowed) return null
    return { code, field, allowed }
  })()

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
        <div className="space-y-2 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <div>{error}</div>
          {errorDetailView ? (
            <div className="text-xs text-destructive/80">
              {errorDetailView.code ? (
                <div>
                  code: <code>{errorDetailView.code}</code>
                </div>
              ) : null}
              {errorDetailView.field ? (
                <div>
                  field: <code>{errorDetailView.field}</code>
                </div>
              ) : null}
              {errorDetailView.allowed ? (
                <div>
                  allowed: <code>{errorDetailView.allowed.join(", ")}</code>
                </div>
              ) : null}
            </div>
          ) : null}
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

          <div className="grid gap-3 sm:grid-cols-2">
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
              {availableOps.map((op) => {
                const checked = selectedOps.has(op)
                const isWriteOp = WRITE_OPS.has(op)
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
                    title={isWriteOp ? "write-only operation" : undefined}
                  >
                    {op}
                    {isWriteOp ? " ✎" : ""}
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Only operations the selected exposure can request are shown. Pick
              exactly what the chat-card denial text said it needed. Action
              level is derived from your selection: <code>{derivedAction}</code>
              {selectedOps.size > 0 && derivedAction === "write" ? (
                <> (because one of the selected operations is write-only).</>
              ) : null}
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
