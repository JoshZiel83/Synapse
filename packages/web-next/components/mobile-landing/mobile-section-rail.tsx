"use client"

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { AnimatePresence, m } from "framer-motion"

import { cn } from "@/lib/utils"

type RailSection = { id: string; title: string }

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1]

export function MobileSectionRail({ sections }: { sections: RailSection[] }) {
  const [active, setActive] = useState<string>(sections[0]?.id ?? "")
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const [tooltipTop, setTooltipTop] = useState<number>(0)
  const railRef = useRef<HTMLDivElement | null>(null)
  const dotsRef = useRef<(HTMLDivElement | null)[]>([])
  const targetIndexRef = useRef<number | null>(null)
  const scrollTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const targets = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => Boolean(el))
    if (!targets.length) return

    const ratios = new Map<string, number>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          ratios.set(entry.target.id, entry.intersectionRatio)
        }
        let bestId: string | null = null
        let bestRatio = 0
        for (const [id, ratio] of ratios) {
          if (ratio > bestRatio) {
            bestId = id
            bestRatio = ratio
          }
        }
        if (bestId && bestRatio > 0) setActive(bestId)
      },
      {
        threshold: [0.1, 0.25, 0.5, 0.75],
        rootMargin: "-15% 0px -35% 0px",
      }
    )
    targets.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [sections])

  const findIndexAtY = useCallback((clientY: number) => {
    const dots = dotsRef.current
    if (!dots.length) return null

    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < dots.length; i++) {
      const el = dots[i]
      if (!el) continue
      const rect = el.getBoundingClientRect()
      const center = rect.top + rect.height / 2
      const dist = Math.abs(center - clientY)
      if (dist < bestDist) {
        bestDist = dist
        bestIdx = i
      }
    }
    return bestIdx
  }, [])

  const scrollToSection = useCallback(
    (idx: number) => {
      const section = sections[idx]
      if (!section) return
      const el = document.getElementById(section.id)
      if (!el) return
      const rect = el.getBoundingClientRect()
      const top = rect.top + window.scrollY - 8
      window.scrollTo({ top, behavior: "smooth" })
    },
    [sections]
  )

  const focusedIndex =
    draggingIndex ?? sections.findIndex((s) => s.id === active)

  useLayoutEffect(() => {
    if (focusedIndex < 0) return
    const dot = dotsRef.current[focusedIndex]
    const rail = railRef.current
    if (!dot || !rail) return
    const dotRect = dot.getBoundingClientRect()
    const railRect = rail.getBoundingClientRect()
    setTooltipTop(dotRect.top - railRect.top + dotRect.height / 2)
  }, [focusedIndex, draggingIndex])

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      const idx = findIndexAtY(event.clientY)
      if (idx != null) {
        setDraggingIndex(idx)
        targetIndexRef.current = idx
        if (scrollTimerRef.current) {
          window.clearTimeout(scrollTimerRef.current)
        }
        scrollTimerRef.current = window.setTimeout(() => {
          if (targetIndexRef.current != null) {
            scrollToSection(targetIndexRef.current)
          }
        }, 80)
      }
    },
    [findIndexAtY, scrollToSection]
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (draggingIndex === null) return
      const idx = findIndexAtY(event.clientY)
      if (idx == null || idx === draggingIndex) return
      setDraggingIndex(idx)
      targetIndexRef.current = idx
      if (scrollTimerRef.current) {
        window.clearTimeout(scrollTimerRef.current)
      }
      scrollTimerRef.current = window.setTimeout(() => {
        if (targetIndexRef.current != null) {
          scrollToSection(targetIndexRef.current)
        }
      }, 110)
    },
    [draggingIndex, findIndexAtY, scrollToSection]
  )

  const endDrag = useCallback(() => {
    if (scrollTimerRef.current) {
      window.clearTimeout(scrollTimerRef.current)
      scrollTimerRef.current = null
    }
    if (targetIndexRef.current != null) {
      scrollToSection(targetIndexRef.current)
    }
    targetIndexRef.current = null
    window.setTimeout(() => setDraggingIndex(null), 320)
  }, [scrollToSection])

  useEffect(
    () => () => {
      if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current)
    },
    []
  )

  if (!sections.length) return null

  const focusedSection = sections[focusedIndex] ?? sections[0]

  return (
    <div
      ref={railRef}
      className="fixed top-1/2 right-1.5 z-30 -translate-y-1/2 touch-none select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      role="navigation"
      aria-label="章节导航"
    >
      <div
        className={cn(
          "flex flex-col items-center gap-2.5 rounded-full border px-1.5 py-2.5 backdrop-blur-md transition-colors duration-200",
          draggingIndex !== null
            ? "border-slate-300 bg-white/95 shadow-[0_18px_36px_-22px_rgba(15,23,42,0.42)]"
            : "border-white/60 bg-white/45 shadow-[0_10px_24px_-18px_rgba(15,23,42,0.28)]"
        )}
      >
        {sections.map((section, idx) => {
          const isActive = section.id === active
          const isFocused = focusedIndex === idx && draggingIndex !== null
          return (
            <div
              key={section.id}
              ref={(node) => {
                dotsRef.current[idx] = node
              }}
              className="flex h-3 w-3 items-center justify-center"
            >
              <div
                className={cn(
                  "rounded-full transition-all duration-200",
                  isFocused
                    ? "size-2 bg-slate-950"
                    : isActive
                      ? "size-2 bg-slate-900"
                      : "size-1.5 bg-slate-400/70"
                )}
              />
            </div>
          )
        })}
      </div>

      <AnimatePresence>
        {draggingIndex !== null ? (
          <m.div
            key="rail-tooltip"
            initial={{ opacity: 0, x: 6, scale: 0.94 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 6, scale: 0.96 }}
            transition={{ duration: 0.16, ease }}
            className="pointer-events-none absolute right-full mr-2 rounded-full bg-slate-950/95 px-3 py-1.5 text-[12px] leading-none font-medium whitespace-nowrap text-white shadow-[0_18px_36px_-18px_rgba(15,23,42,0.6)]"
            style={{ top: tooltipTop, transform: "translateY(-50%)" }}
          >
            {focusedSection.title}
          </m.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
