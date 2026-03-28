"use client"

import {
  useEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react"
import twemoji from "twemoji"

import { TWEMOJI_ASSET_BASE } from "@/lib/twemoji"
import { cn } from "@/lib/utils"

type TwemojiScopeProps = {
  as?: "div" | "span" | "p"
  className?: string
  children: ReactNode
} & Omit<
  HTMLAttributes<HTMLDivElement | HTMLSpanElement | HTMLParagraphElement>,
  "children" | "className"
>

export function TwemojiScope({
  as,
  className,
  children,
  ...props
}: TwemojiScopeProps) {
  const ref = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!ref.current) return

    twemoji.parse(ref.current, {
      base: TWEMOJI_ASSET_BASE,
      folder: "svg",
      ext: ".svg",
      className: "twemoji",
    })
  }, [children])

  if (as === "span") {
    return (
      <span
        {...props}
        ref={ref as RefObject<HTMLSpanElement>}
        className={cn(className)}
      >
        {children}
      </span>
    )
  }

  if (as === "p") {
    return (
      <p
        {...props}
        ref={ref as RefObject<HTMLParagraphElement>}
        className={cn(className)}
      >
        {children}
      </p>
    )
  }

  return (
    <div
      {...props}
      ref={ref as RefObject<HTMLDivElement>}
      className={cn(className)}
    >
      {children}
    </div>
  )
}
