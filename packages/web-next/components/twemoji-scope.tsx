"use client"

import {
  useMemo,
  type HTMLAttributes,
  type ReactNode,
} from "react"
import twemoji from "twemoji"

import { TWEMOJI_ASSET_BASE } from "@/lib/twemoji"
import { cn } from "@/lib/utils"

type SupportedTag = "div" | "span" | "p"

type TwemojiScopeProps = {
  as?: SupportedTag
  className?: string
  children: ReactNode
} & Omit<
  HTMLAttributes<HTMLDivElement | HTMLSpanElement | HTMLParagraphElement>,
  "children" | "className"
>

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function isPlainTextChild(
  children: ReactNode
): children is string | number | bigint {
  return (
    typeof children === "string" ||
    typeof children === "number" ||
    typeof children === "bigint"
  )
}

function renderWithTag(
  tag: SupportedTag,
  props: HTMLAttributes<
    HTMLDivElement | HTMLSpanElement | HTMLParagraphElement
  > & {
    children?: ReactNode
    dangerouslySetInnerHTML?: { __html: string | TrustedHTML }
  }
) {
  if (tag === "span") {
    return <span {...props} />
  }

  if (tag === "p") {
    return <p {...props} />
  }

  return <div {...props} />
}

export function TwemojiScope({
  as = "div",
  className,
  children,
  ...props
}: TwemojiScopeProps) {
  const parsedHtml = useMemo(() => {
    if (!isPlainTextChild(children)) {
      return null
    }

    return twemoji.parse(escapeHtml(String(children)), {
      base: TWEMOJI_ASSET_BASE,
      folder: "svg",
      ext: ".svg",
      className: "twemoji",
    })
  }, [children])

  if (parsedHtml !== null) {
    return renderWithTag(as, {
      ...props,
      className: cn(className),
      dangerouslySetInnerHTML: { __html: parsedHtml },
    })
  }

  return renderWithTag(as, {
    ...props,
    className: cn(className),
    children,
  })
}
