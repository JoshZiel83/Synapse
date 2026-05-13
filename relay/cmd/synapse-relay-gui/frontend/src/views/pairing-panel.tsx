import { ShieldCheck } from "lucide-react"
import { useState } from "react"

import { Button } from "../components/ui/button"
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
} from "../components/ui/field"
import { Input } from "../components/ui/input"

type ParsedPairingInput = {
  serverBaseUrl: string
  pairingCode: string
}

function parsePairingInput(source: string): ParsedPairingInput {
  const trimmedSource = source.trim()
  if (!trimmedSource) {
    return { serverBaseUrl: "", pairingCode: "" }
  }

  try {
    const parsed = new URL(trimmedSource)
    if (parsed.protocol === "synapse-relay:") {
      return {
        serverBaseUrl: (parsed.searchParams.get("serverBaseUrl") || "").trim(),
        pairingCode: (parsed.searchParams.get("code") || "").trim(),
      }
    }

    return {
      serverBaseUrl: parsed.origin,
      pairingCode: (parsed.searchParams.get("code") || "").trim(),
    }
  } catch {
    return { serverBaseUrl: "", pairingCode: "" }
  }
}

interface PairingPanelProps {
  onClaimPairing: (
    serverBaseUrl: string,
    pairingCode: string
  ) => Promise<string>
}

export function PairingPanel({ onClaimPairing }: PairingPanelProps) {
  const [pairingLink, setPairingLink] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")

  const parsedInput = parsePairingInput(pairingLink)

  async function handleSubmit() {
    if (!parsedInput.serverBaseUrl || !parsedInput.pairingCode) {
      setError("Paste the full pairing link.")
      return
    }

    setSubmitting(true)
    setMessage("")
    setError("")
    try {
      const result = await onClaimPairing(
        parsedInput.serverBaseUrl,
        parsedInput.pairingCode
      )
      setMessage(result)
      setPairingLink("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h1 className="text-[28px] leading-none font-semibold tracking-tight text-foreground">
          Pair
        </h1>
        <div className="mt-3 text-sm text-muted-foreground">
          Paste the link from the Web console.
        </div>
      </div>
      <div className="flex flex-col gap-5">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="pairing-link">Link</FieldLabel>
            <FieldContent>
              <Input
                id="pairing-link"
                value={pairingLink}
                onChange={(event) => setPairingLink(event.target.value)}
                placeholder="https://synapse.example.com/dashboard/plugins?...&code=..."
              />
            </FieldContent>
          </Field>
        </FieldGroup>

        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleSubmit}
            disabled={submitting || !pairingLink.trim()}
          >
            <ShieldCheck data-icon="inline-start" />
            {submitting ? "Pairing..." : "Bind Device"}
          </Button>
        </div>

        {message ? (
          <div className="rounded-2xl border border-[color:var(--status-success-border)] bg-[color:var(--status-success-bg)] px-4 py-3 text-sm text-[color:var(--status-success-fg)]">
            {message}
          </div>
        ) : null}
        {error ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
      </div>
    </section>
  )
}
