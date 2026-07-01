"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

const headlineSteps = [
  { lead: "像", tail: "一样思考" },
  { lead: "像", tail: "一样管理" },
  { lead: "像", tail: "一样记忆" },
  { lead: "与", tail: "一起协作" },
  { lead: "与", tail: "一起交互" },
] as const

const IDLE_MS = 2100
const TRANSITION_MS = 480
const TRANSITION_EASING = "cubic-bezier(0.77, 0, 0.18, 1)"
const CHAR_HEIGHT = "1.12em"

function HumanMark() {
  return (
    <span className="mx-0.5 inline-flex items-center justify-center rounded-[0.38em] bg-primary/12 px-[0.24em] py-[0.08em] text-primary shadow-[inset_0_0_0_1px_rgba(59,130,246,0.08)] sm:mx-1 sm:px-[0.3em]">
      人类
    </span>
  )
}

function StaticChar({
  char,
  widthPx,
}: {
  char: string
  widthPx: number | null
}) {
  return (
    <span
      className="inline-flex items-center justify-center"
      style={{
        height: CHAR_HEIGHT,
        lineHeight: CHAR_HEIGHT,
        width: widthPx ? `${widthPx}px` : undefined,
      }}
    >
      {char}
    </span>
  )
}

function RollingChar({
  currentChar,
  nextChar,
  isAnimating,
  widthPx,
}: {
  currentChar: string
  nextChar: string
  isAnimating: boolean
  widthPx: number | null
}) {
  const offset = isAnimating ? `-${CHAR_HEIGHT}` : "0px"

  return (
    <span
      className="relative inline-block overflow-hidden align-baseline"
      style={{
        height: CHAR_HEIGHT,
        lineHeight: CHAR_HEIGHT,
        width: widthPx ? `${widthPx}px` : "1em",
      }}
    >
      <span
        className="flex flex-col will-change-transform"
        style={{
          transform: `translate3d(0, ${offset}, 0)`,
          transition: isAnimating
            ? `transform ${TRANSITION_MS}ms ${TRANSITION_EASING}`
            : "none",
        }}
      >
        <span
          className="flex items-center justify-center"
          style={{ height: CHAR_HEIGHT, lineHeight: CHAR_HEIGHT }}
        >
          {currentChar}
        </span>
        <span
          className="flex items-center justify-center"
          style={{ height: CHAR_HEIGHT, lineHeight: CHAR_HEIGHT }}
        >
          {nextChar}
        </span>
      </span>
    </span>
  )
}

function HeadlineChar({
  currentChar,
  nextChar,
  isAnimating,
  widthPx,
}: {
  currentChar: string
  nextChar: string
  isAnimating: boolean
  widthPx: number | null
}) {
  if (currentChar === nextChar) {
    return <StaticChar char={currentChar} widthPx={widthPx} />
  }
  return (
    <RollingChar
      currentChar={currentChar}
      nextChar={nextChar}
      isAnimating={isAnimating}
      widthPx={widthPx}
    />
  )
}

function getStepChars(stepIndex: number) {
  const step = headlineSteps[stepIndex]
  return [step.lead, ...Array.from(step.tail)]
}

const positionCharSets: string[][] = (() => {
  const length = getStepChars(0).length
  const sets: string[][] = []
  for (let position = 0; position < length; position++) {
    const seen = new Set<string>()
    for (let stepIndex = 0; stepIndex < headlineSteps.length; stepIndex++) {
      seen.add(getStepChars(stepIndex)[position])
    }
    sets.push(Array.from(seen))
  }
  return sets
})()

/**
 * Measures the widest glyph at each position in the current font, so each
 * rolling slot can be pinned to that width and won't shift as we cycle.
 */
function usePositionWidths() {
  const probeRef = useRef<HTMLDivElement | null>(null)
  const [widths, setWidths] = useState<number[] | null>(null)

  useLayoutEffect(() => {
    const node = probeRef.current
    if (!node) return

    const measure = () => {
      const next: number[] = []
      const groups = node.querySelectorAll<HTMLElement>("[data-position]")
      groups.forEach((group) => {
        let max = 0
        group.querySelectorAll<HTMLElement>("[data-glyph]").forEach((glyph) => {
          const rect = glyph.getBoundingClientRect()
          if (rect.width > max) max = rect.width
        })
        next.push(Math.ceil(max + 0.5))
      })
      setWidths((prev) => {
        if (
          prev &&
          prev.length === next.length &&
          prev.every((value, idx) => value === next[idx])
        ) {
          return prev
        }
        return next
      })
    }

    measure()
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure)
      return () => window.removeEventListener("resize", measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(measure).catch(() => undefined)
    }
    return () => observer.disconnect()
  }, [])

  return { probeRef, widths }
}

export function LandingHeroHeadline() {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [nextIndex, setNextIndex] = useState(headlineSteps.length > 1 ? 1 : 0)
  const [isAnimating, setIsAnimating] = useState(false)
  const { probeRef, widths } = usePositionWidths()

  useEffect(() => {
    if (headlineSteps.length < 2 || isAnimating) return
    const timer = window.setTimeout(() => setIsAnimating(true), IDLE_MS)
    return () => window.clearTimeout(timer)
  }, [currentIndex, isAnimating])

  useEffect(() => {
    if (!isAnimating) return
    const timer = window.setTimeout(() => {
      setCurrentIndex(nextIndex)
      setNextIndex((nextIndex + 1) % headlineSteps.length)
      setIsAnimating(false)
    }, TRANSITION_MS + 40)
    return () => window.clearTimeout(timer)
  }, [isAnimating, nextIndex])

  const currentChars = useMemo(() => getStepChars(currentIndex), [currentIndex])
  const nextChars = useMemo(() => getStepChars(nextIndex), [nextIndex])

  const renderChar = useCallback(
    (i: number) => (
      <HeadlineChar
        key={`${i}-${currentChars[i]}-${nextChars[i]}`}
        currentChar={currentChars[i]}
        nextChar={nextChars[i]}
        isAnimating={isAnimating}
        widthPx={widths ? widths[i] : null}
      />
    ),
    [currentChars, nextChars, isAnimating, widths]
  )

  return (
    <div className="font-display animate-fade-up relative mt-6 text-[clamp(2rem,7vw,5rem)] leading-[0.96] font-semibold tracking-tight text-slate-950">
      <ProbeStrip ref={probeRef} />

      <div className="inline-flex max-w-full flex-nowrap items-center justify-center gap-x-1 leading-none whitespace-nowrap sm:gap-x-1.5">
        <span>让 AI</span>
        <span className="inline-flex items-center text-primary">
          {renderChar(0)}
        </span>
        <HumanMark />
        <span className="inline-flex items-center text-primary">
          {currentChars.slice(1).map((_, idx) => renderChar(idx + 1))}
        </span>
      </div>
    </div>
  )
}

const ProbeStrip = function ProbeStrip({
  ref,
}: {
  ref: React.Ref<HTMLDivElement>
}) {
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none invisible absolute -top-[9999px] left-0 inline-flex font-semibold"
      style={{ font: "inherit" }}
    >
      {positionCharSets.map((chars, position) => (
        <span key={position} data-position={position} className="inline-flex">
          {chars.map((char) => (
            <span
              key={char}
              data-glyph={char}
              className="inline-flex items-center justify-center"
              style={{ height: CHAR_HEIGHT, lineHeight: CHAR_HEIGHT }}
            >
              {char}
            </span>
          ))}
        </span>
      ))}
    </div>
  )
}
