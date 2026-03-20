"use client"

import type { CSSProperties, ReactNode } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  Lock,
  X,
} from "lucide-react"

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

type PreviewOrientation = "portrait" | "landscape"

export type TablePreviewContent = {
  className?: string
  children?: ReactNode
}

interface TablePreviewOverlayProps {
  table: TablePreviewContent
  onClose: () => void
}

export function TablePreviewOverlay({
  table,
  onClose,
}: TablePreviewOverlayProps) {
  const [viewportOrientation, setViewportOrientation] =
    useState<PreviewOrientation>("portrait")
  const [lockedOrientation, setLockedOrientation] =
    useState<PreviewOrientation | null>(null)
  const previewViewportRef = useRef<HTMLDivElement | null>(null)
  const scrollViewportRef = useRef<HTMLDivElement | null>(null)
  const [previewViewportSize, setPreviewViewportSize] = useState({
    width: 0,
    height: 0,
  })

  useEffect(() => {
    function resolveViewportOrientation(): PreviewOrientation {
      const screenOrientation = window.screen?.orientation?.type
      if (screenOrientation?.startsWith("landscape")) return "landscape"
      if (screenOrientation?.startsWith("portrait")) return "portrait"

      const legacyOrientation =
        typeof window.orientation === "number"
          ? Math.abs(window.orientation)
          : null
      if (legacyOrientation === 90) return "landscape"
      if (legacyOrientation === 0 || legacyOrientation === 180) {
        return "portrait"
      }

      return "portrait"
    }

    function updateViewportOrientation() {
      setViewportOrientation(resolveViewportOrientation())
    }

    updateViewportOrientation()

    const screenOrientation = window.screen?.orientation
    screenOrientation?.addEventListener?.("change", updateViewportOrientation)
    window.addEventListener("orientationchange", updateViewportOrientation)

    return () => {
      screenOrientation?.removeEventListener?.("change", updateViewportOrientation)
      window.removeEventListener("orientationchange", updateViewportOrientation)
    }
  }, [])

  useEffect(() => {
    const htmlOverflow = document.documentElement.style.overflow
    const bodyOverflow = document.body.style.overflow

    document.documentElement.style.overflow = "hidden"
    document.body.style.overflow = "hidden"

    return () => {
      document.documentElement.style.overflow = htmlOverflow
      document.body.style.overflow = bodyOverflow
    }
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  useEffect(() => {
    const viewport = previewViewportRef.current
    if (!viewport) return
    const element = viewport

    function updateViewportSize() {
      setPreviewViewportSize({
        width: element.clientWidth,
        height: element.clientHeight,
      })
    }

    updateViewportSize()

    const observer = new ResizeObserver(updateViewportSize)
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  const effectiveOrientation = lockedOrientation || viewportOrientation
  const shouldRotateStage = effectiveOrientation !== viewportOrientation

  const previewStageStyle = useMemo<CSSProperties>(() => {
    if (
      shouldRotateStage &&
      previewViewportSize.width > 0 &&
      previewViewportSize.height > 0
    ) {
      return {
        width: `${previewViewportSize.height}px`,
        height: `${previewViewportSize.width}px`,
        transform: `translateX(${previewViewportSize.width}px) rotate(90deg)`,
        transformOrigin: "top left",
      }
    }

    return {
      width: "100%",
      height: "100%",
      transform: "none",
      transformOrigin: "top left",
    }
  }, [previewViewportSize.height, previewViewportSize.width, shouldRotateStage])

  function toggleOrientation(target: PreviewOrientation) {
    setLockedOrientation((current) => (current === target ? null : target))
  }

  useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTop = 0
      viewport.scrollLeft = 0
    })

    return () => window.cancelAnimationFrame(frame)
  }, [shouldRotateStage, table])

  if (typeof document === "undefined") return null

  return createPortal(
    <div className="fixed inset-0 z-[70] bg-background text-foreground">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Table preview"
        className="grid h-[100dvh] min-h-0 grid-rows-[auto_minmax(0,1fr)]"
      >
        <div className="border-b border-border bg-background/95 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur">
          <div className="flex min-h-9 items-center justify-between gap-3">
            <div className="min-w-0 text-base font-medium text-foreground">
              Preview
            </div>
            <div className="flex items-center gap-2">
              <Tabs value={effectiveOrientation} className="items-center gap-0">
                <TabsList className="bg-muted/70">
                  <TabsTrigger
                    value="portrait"
                    className="min-w-[6rem]"
                    onClick={() => toggleOrientation("portrait")}
                  >
                    Portrait
                    {lockedOrientation === "portrait" ? (
                      <Lock className="size-3.5" />
                    ) : null}
                  </TabsTrigger>
                  <TabsTrigger
                    value="landscape"
                    className="min-w-[6rem]"
                    onClick={() => toggleOrientation("landscape")}
                  >
                    Landscape
                    {lockedOrientation === "landscape" ? (
                      <Lock className="size-3.5" />
                    ) : null}
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              <button
                type="button"
                className="inline-flex h-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                onClick={onClose}
              >
                <X className="size-5" />
                <span className="sr-only">Close table preview</span>
              </button>
            </div>
          </div>
        </div>

        <div
          ref={previewViewportRef}
          className="relative min-h-0 overflow-hidden bg-background pb-[env(safe-area-inset-bottom)]"
        >
          <div
            className="absolute left-0 top-0 overflow-visible bg-background transition-transform duration-200"
            style={previewStageStyle}
          >
            <div
              ref={scrollViewportRef}
              className="size-full min-h-0 min-w-0 overflow-auto overscroll-contain"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              <table
                className={cn(
                  "w-max min-w-full border-collapse text-sm",
                  table.className
                )}
              >
                {table.children}
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
