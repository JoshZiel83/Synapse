"use client"

import Image from "next/image"
import type { TransportKind } from "@synapse/shared"
import { describeTransportKind } from "@synapse/shared"
import { cn } from "@/lib/utils"
import { useConnectorMetadata } from "@/lib/im-connector-metadata"

interface TransportKindIconProps {
  kind?: TransportKind
  className?: string
  size?: number
}

export default function TransportKindIcon({
  kind,
  className,
  size = 16,
}: TransportKindIconProps) {
  // Pull metadata before any early-return so React's rules-of-hooks
  // are satisfied. The hook returns undefined when the provider
  // hasn't loaded yet; fall back to static helpers in that window.
  const metadata = useConnectorMetadata()
  if (!kind) return null

  const cap = metadata?.get(kind)
  const label = cap?.displayName ?? describeTransportKind(kind)
  // `/icon/${kind}.svg` was the historical convention; new connectors
  // are encouraged to set `iconAssetPath` explicitly on the
  // capability, so the path lives in one place. Fall back to the
  // convention only when metadata isn't loaded yet (or a connector
  // hasn't set the field, which the contract test would catch).
  const iconPath = cap?.iconAssetPath ?? `/icon/${kind}.svg`

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full border border-background bg-white shadow-sm",
        className
      )}
      aria-label={label}
      title={label}
    >
      <Image
        src={iconPath}
        alt={label}
        width={size}
        height={size}
        className="rounded-full"
      />
    </span>
  )
}
