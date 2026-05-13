import type {
  RelayLocalDesktopPairingResponse,
  RelayLocalDesktopStatusView,
  RelayPairingSessionView,
} from "@synapse/shared"

export const RELAY_LOCAL_DESKTOP_ORIGIN = "http://127.0.0.1:21519"

export async function probeLocalRelayDesktop(): Promise<RelayLocalDesktopStatusView | null> {
  try {
    const response = await fetch(`${RELAY_LOCAL_DESKTOP_ORIGIN}/status`, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
    })

    if (!response.ok) {
      return null
    }

    return (await response.json()) as RelayLocalDesktopStatusView
  } catch {
    return null
  }
}

export async function sendPairingToLocalRelayDesktop(input: {
  serverBaseUrl: string
  pairingCode: string
  title?: string
}): Promise<RelayLocalDesktopPairingResponse> {
  const response = await fetch(`${RELAY_LOCAL_DESKTOP_ORIGIN}/pairing`, {
    method: "POST",
    mode: "cors",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  })

  const payload = (await response.json()) as RelayLocalDesktopPairingResponse
  if (!response.ok || !payload.accepted) {
    throw new Error(
      payload.message || "Desktop relay client rejected the pairing request"
    )
  }

  return payload
}

export function buildRelayDesktopDeepLink(
  pairing: RelayPairingSessionView
): string {
  const url = new URL("synapse-relay://pair")
  url.searchParams.set("serverBaseUrl", pairing.serverBaseUrl)
  url.searchParams.set("code", pairing.pairingCode)
  if (pairing.requestedDisplayName) {
    url.searchParams.set("title", pairing.requestedDisplayName)
  }
  return url.toString()
}
