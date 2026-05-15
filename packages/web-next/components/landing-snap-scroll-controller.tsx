"use client"

import { useEffect, useRef } from "react"

const WHEEL_THRESHOLD = 64
const RELEASE_DELAY_MS = 820
const EDGE_TOLERANCE_PX = 28

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false

  return (
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  )
}

function getClosestSectionIndex(sections: HTMLElement[], scrollY: number) {
  const probeY = scrollY + window.innerHeight * 0.18

  return sections.reduce((closestIndex, section, index) => {
    const closestDistance = Math.abs(sections[closestIndex].offsetTop - probeY)
    const currentDistance = Math.abs(section.offsetTop - probeY)

    return currentDistance < closestDistance ? index : closestIndex
  }, 0)
}

export function LandingSnapScrollController() {
  const lockedRef = useRef(false)
  const accumulatedDeltaRef = useRef(0)
  const releaseTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const isEnabled = () =>
      window.matchMedia(
        "(min-width: 1024px) and (pointer: fine) and (min-height: 1000px)"
      ).matches &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches

    const getScrollTargets = () => {
      const sections = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-landing-snap-section='true']"
        )
      )
      const tail = document.querySelector<HTMLElement>(
        "[data-landing-tail='true']"
      )

      if (sections.length === 0) return null

      return {
        sections,
        tailTop: tail?.offsetTop ?? Number.POSITIVE_INFINITY,
      }
    }

    const clearReleaseTimer = () => {
      if (releaseTimerRef.current === null) return

      window.clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }

    const scheduleUnlock = () => {
      clearReleaseTimer()
      releaseTimerRef.current = window.setTimeout(() => {
        lockedRef.current = false
        accumulatedDeltaRef.current = 0
        releaseTimerRef.current = null
      }, RELEASE_DELAY_MS)
    }

    const scrollToSection = (top: number) => {
      lockedRef.current = true
      window.scrollTo({ top, behavior: "smooth" })
      scheduleUnlock()
    }

    const handleDirectionalSnap = (direction: 1 | -1) => {
      const targets = getScrollTargets()

      if (!targets) return false

      const { sections, tailTop } = targets
      const lastSectionIndex = sections.length - 1
      const firstTop = sections[0].offsetTop
      const lastTop = sections[lastSectionIndex].offsetTop
      const scrollY = window.scrollY

      if (scrollY >= tailTop - EDGE_TOLERANCE_PX) {
        if (
          direction < 0 &&
          scrollY <= tailTop + EDGE_TOLERANCE_PX &&
          !lockedRef.current
        ) {
          scrollToSection(lastTop)
          return true
        }
        return false
      }

      if (lockedRef.current) return true

      const currentIndex = getClosestSectionIndex(sections, scrollY)

      if (direction > 0) {
        if (currentIndex < lastSectionIndex) {
          scrollToSection(sections[currentIndex + 1].offsetTop)
          return true
        }
        return false
      }

      if (currentIndex === 0 && scrollY <= firstTop + EDGE_TOLERANCE_PX)
        return false

      scrollToSection(sections[Math.max(0, currentIndex - 1)].offsetTop)
      return true
    }

    const onWheel = (event: WheelEvent) => {
      if (!isEnabled()) return

      const targets = getScrollTargets()
      if (!targets) return

      const { sections, tailTop } = targets
      const lastSectionIndex = sections.length - 1
      const firstTop = sections[0].offsetTop
      const lastTop = sections[lastSectionIndex].offsetTop
      const scrollY = window.scrollY

      if (scrollY >= tailTop - EDGE_TOLERANCE_PX) {
        if (
          event.deltaY < 0 &&
          scrollY <= tailTop + EDGE_TOLERANCE_PX &&
          !lockedRef.current
        ) {
          event.preventDefault()
          scrollToSection(lastTop)
        }
        return
      }

      if (lockedRef.current) {
        event.preventDefault()
        return
      }

      accumulatedDeltaRef.current += event.deltaY

      if (Math.abs(accumulatedDeltaRef.current) < WHEEL_THRESHOLD) {
        event.preventDefault()
        return
      }

      const direction = accumulatedDeltaRef.current > 0 ? 1 : -1
      const currentIndex = getClosestSectionIndex(sections, scrollY)
      accumulatedDeltaRef.current = 0

      if (direction > 0) {
        if (currentIndex < lastSectionIndex) {
          event.preventDefault()
          scrollToSection(sections[currentIndex + 1].offsetTop)
        }
        return
      }

      if (currentIndex === 0 && scrollY <= firstTop + EDGE_TOLERANCE_PX) return

      event.preventDefault()
      scrollToSection(sections[Math.max(0, currentIndex - 1)].offsetTop)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isEnabled()) return
      if (event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return

      const direction =
        event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : null

      if (direction === null) return

      if (handleDirectionalSnap(direction)) {
        event.preventDefault()
      }
    }

    const onScroll = () => {
      if (!lockedRef.current) {
        accumulatedDeltaRef.current = 0
      }
    }

    window.addEventListener("wheel", onWheel, { passive: false })
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("scroll", onScroll, { passive: true })

    return () => {
      clearReleaseTimer()
      window.removeEventListener("wheel", onWheel)
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("scroll", onScroll)
    }
  }, [])

  return null
}
