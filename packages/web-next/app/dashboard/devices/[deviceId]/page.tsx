"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { ArrowLeft, Loader2, Plug, Trash2 } from "lucide-react"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import type { DeviceDetailView } from "@synapse/shared"

export default function DeviceDetailPage() {
  const { workspaceId } = useWorkspace()
  const router = useRouter()
  const { deviceId } = useParams() as { deviceId: string }
  const [device, setDevice] = useState<DeviceDetailView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId || !deviceId) return
    let cancelled = false
    api
      .getDevice(workspaceId, deviceId)
      .then((d) => {
        if (!cancelled) setDevice(d)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, deviceId])

  async function deleteDevice() {
    if (!workspaceId || !deviceId) return
    if (!confirm("Delete this device and all associated services?")) return
    try {
      await api.deleteDevice(workspaceId, deviceId)
      router.push("/dashboard/devices")
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (error) {
    return (
      <div className="p-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/dashboard/devices")}
        >
          <ArrowLeft className="size-4" /> Back
        </Button>
        <div className="mt-4 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      </div>
    )
  }
  if (!device) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading device…
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/dashboard/devices")}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{device.title}</h1>
            <p className="text-sm text-muted-foreground">
              {device.deviceType} · {device.platform ?? "unknown platform"}
            </p>
          </div>
        </div>
        <Button variant="destructive" onClick={deleteDevice}>
          <Trash2 className="size-4" /> Delete
        </Button>
      </header>

      <section>
        <h2 className="text-sm font-semibold">Services</h2>
        <ul className="mt-2 divide-y rounded border">
          {device.services.map((service) => (
            <li
              key={service.id}
              className="flex items-center justify-between gap-4 p-3 text-sm"
            >
              <div className="flex items-center gap-3">
                <Plug className="size-4 text-muted-foreground" />
                <div>
                  <div className="font-medium">{service.serviceKind}</div>
                  <div className="text-xs text-muted-foreground">
                    {service.status} · {service.version ?? "no version"}
                  </div>
                </div>
              </div>
              <span className="text-xs text-muted-foreground">
                {service.lastSeenAt ?? "never"}
              </span>
            </li>
          ))}
          {device.services.length === 0 ? (
            <li className="p-3 text-xs text-muted-foreground">
              No services attached yet.
            </li>
          ) : null}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold">Capabilities</h2>
        <ul className="mt-2 divide-y rounded border">
          {device.capabilities.map((cap) => {
            const meta = cap.metadata as
              | {
                  enabled?: boolean
                  disabledReason?: string
                }
              | null
              | undefined
            const isDisabled = meta?.enabled === false
            return (
              <li
                key={cap.id}
                className={`flex items-center justify-between gap-4 p-3 text-sm ${
                  isDisabled ? "opacity-60" : ""
                }`}
              >
                <div>
                  <div className="font-medium">
                    {cap.displayName}
                    {isDisabled ? (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 uppercase dark:bg-amber-900/50 dark:text-amber-300">
                        Coming soon
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {cap.transport}
                    {cap.builtinKind ? ` · ${cap.builtinKind}` : ""}
                    {isDisabled && meta?.disabledReason
                      ? ` · ${meta.disabledReason}`
                      : ""}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">
                  {cap.runtimeStatus}
                </span>
              </li>
            )
          })}
          {device.capabilities.length === 0 ? (
            <li className="p-3 text-xs text-muted-foreground">
              No active capabilities. The runtime has not pushed a catalog yet.
            </li>
          ) : null}
        </ul>
      </section>
    </div>
  )
}
