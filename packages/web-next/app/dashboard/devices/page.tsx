"use client"

import { useState } from "react"
import Link from "next/link"
import { Loader2, Plus, ServerCog } from "lucide-react"
import { useQuery, useMutation } from "@tanstack/react-query"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { api } from "@/lib/api"
import { qk } from "@/lib/query-keys"
import { Button } from "@/components/ui/button"
import type { DevicePairingTicketView } from "@/lib/device-views"

export default function DevicesIndexPage() {
  const { workspaceId } = useWorkspace()
  const [pairingTicket, setPairingTicket] =
    useState<DevicePairingTicketView | null>(null)

  const devicesQuery = useQuery({
    queryKey: workspaceId ? qk.devices(workspaceId) : ["devices", "disabled"],
    queryFn: () => api.listDevices(workspaceId!),
    enabled: !!workspaceId,
    select: (res) => res.devices,
  })
  const devices = devicesQuery.data ?? null

  const pairingMutation = useMutation({
    mutationFn: () =>
      api.startDevicePairingSession(workspaceId!, {
        mode: "local_qr",
        title: "Local Device",
      }),
    onSuccess: (ticket) => setPairingTicket(ticket),
  })

  function startPairing() {
    if (!workspaceId || pairingMutation.isPending) return
    pairingMutation.mutate()
  }

  const error =
    (devicesQuery.error as Error | null)?.message ??
    (pairingMutation.error as Error | null)?.message ??
    null
  const pairingInProgress = pairingMutation.isPending

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Devices</h1>
          <p className="text-sm text-muted-foreground">
            Local and cloud devices paired with this workspace. v3.0 skeleton —
            full UX lands across PR #7 / PR #11 / PR #12.
          </p>
        </div>
        <Button onClick={startPairing} disabled={pairingInProgress}>
          {pairingInProgress ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          <span>Pair new device</span>
        </Button>
      </header>

      {error ? (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {pairingTicket ? (
        <div className="rounded border p-4">
          <h2 className="font-semibold">Pairing ticket</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Already have the device runtime installed? Run:
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-sm">
            synapse-device pair --code={pairingTicket.pairing_code} --title=
            &quot;My Device&quot;
          </pre>
          {pairingTicket.one_click_commands ? (
            <div className="mt-4 space-y-2">
              <p className="text-sm text-muted-foreground">
                Or one-click install (bootstraps Node, no prerequisites) — Linux
                / macOS:
              </p>
              <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
                {pairingTicket.one_click_commands.unix}
              </pre>
              <p className="text-sm text-muted-foreground">Windows:</p>
              <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
                {pairingTicket.one_click_commands.windows}
              </pre>
            </div>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            Expires at {pairingTicket.expires_at}
          </p>
        </div>
      ) : null}

      {devices === null ? (
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading devices…
        </div>
      ) : devices.length === 0 ? (
        <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
          No devices paired yet. Click &quot;Pair new device&quot; to start.
        </div>
      ) : (
        <ul className="divide-y rounded border">
          {devices.map((device) => (
            <li key={device.id}>
              <Link
                href={`/dashboard/devices/${device.id}`}
                className="flex items-center justify-between gap-4 p-4 transition hover:bg-muted/40"
              >
                <div className="flex items-center gap-3">
                  <ServerCog className="size-5 text-muted-foreground" />
                  <div>
                    <div className="font-medium">{device.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {device.host_kind} · {device.device_type} ·{" "}
                      {device.platform ?? "unknown platform"}
                    </div>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">
                  {device.trust_status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
