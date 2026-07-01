"use client"

import type { TransportKind } from "@synapse/shared"
import { describeTransportKind } from "@synapse/shared"
import { cn } from "@/lib/utils"
import { useConnectorMetadata } from "@/lib/im-connector-metadata"
import { TRANSPORT_BRAND_ICONS } from "@/components/im-brand-icons"

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
  // are satisfied. Metadata is only consulted for the a11y label now;
  // the glyph comes from the static, exhaustive brand-icon map keyed by
  // the closed TransportKind union.
  const metadata = useConnectorMetadata()
  if (!kind) return null

  const cap = metadata?.get(kind)
  const label = cap?.displayName ?? describeTransportKind(kind)
  const BrandIcon = TRANSPORT_BRAND_ICONS[kind]

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full border border-background bg-white text-slate-700 shadow-sm",
        className
      )}
      aria-label={label}
      title={label}
    >
      <BrandIcon width={size} height={size} />
    </span>
  )
}
