"use client"

import Image from "next/image"
import type { TransportKind } from "@synapse/shared"
import { describeTransportKind } from "@synapse/shared"
import { cn } from "@/lib/utils"

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
  if (!kind) return null

  const label = describeTransportKind(kind)

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
        src={`/icon/${kind}.svg`}
        alt={label}
        width={size}
        height={size}
        className="rounded-full"
      />
    </span>
  )
}
