"use client"

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type TransitionEvent,
} from "react"

const headlineSteps = [
  { lead: "像", tail: "一样思考" },
  { lead: "像", tail: "一样管理" },
  { lead: "像", tail: "一样记忆" },
  { lead: "与", tail: "一起协作" },
  { lead: "与", tail: "一起交互" },
] as const

const IDLE_MS = 2100
const TRANSITION_MS = 460
const FALLBACK_HEIGHT = "1.24em"
const rollingWordClass =
  "box-border flex items-center justify-center whitespace-nowrap py-[0.06em] leading-[1.12]"

function RollingWord({
  currentWord,
  nextWord,
  minWidthClass,
  isAnimating,
  onTransitionEnd,
}: {
  currentWord: string
  nextWord: string
  minWidthClass: string
  isAnimating: boolean
  onTransitionEnd?: (event: TransitionEvent<HTMLSpanElement>) => void
}) {
  const currentProbeRef = useRef<HTMLSpanElement | null>(null)
  const nextProbeRef = useRef<HTMLSpanElement | null>(null)
  const [itemHeight, setItemHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    const currentNode = currentProbeRef.current
    const nextNode = nextProbeRef.current
    if (!currentNode || !nextNode) return

    const updateHeight = () => {
      const nextHeight = Math.ceil(
        Math.max(
          currentNode.getBoundingClientRect().height,
          nextNode.getBoundingClientRect().height
        )
      )

      if (nextHeight > 0) {
        setItemHeight((previousHeight) =>
          previousHeight === nextHeight ? previousHeight : nextHeight
        )
      }
    }

    updateHeight()

    if (typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(updateHeight)
    observer.observe(currentNode)
    observer.observe(nextNode)
    return () => observer.disconnect()
  }, [currentWord, nextWord])

  const windowHeight = itemHeight ? `${itemHeight}px` : FALLBACK_HEIGHT
  const itemStyle = { height: windowHeight }
  const offset = isAnimating ? `-${windowHeight}` : "0px"

  return (
    <span className={`relative inline-flex align-middle ${minWidthClass}`}>
      <span
        className="relative overflow-hidden"
        style={{ height: windowHeight }}
      >
        <span
          className="flex flex-col will-change-transform"
          style={{
            transform: `translate3d(0, ${offset}, 0)`,
            transition: isAnimating
              ? `transform ${TRANSITION_MS}ms cubic-bezier(0.77, 0, 0.18, 1)`
              : "none",
          }}
          onTransitionEnd={onTransitionEnd}
        >
          <span className={rollingWordClass} style={itemStyle}>
            {currentWord}
          </span>
          <span className={rollingWordClass} style={itemStyle}>
            {nextWord}
          </span>
        </span>
      </span>

      <span
        ref={currentProbeRef}
        aria-hidden="true"
        className={`pointer-events-none absolute top-0 left-0 -z-10 opacity-0 ${rollingWordClass}`}
      >
        {currentWord}
      </span>
      <span
        ref={nextProbeRef}
        aria-hidden="true"
        className={`pointer-events-none absolute top-0 left-0 -z-10 opacity-0 ${rollingWordClass}`}
      >
        {nextWord}
      </span>
    </span>
  )
}

function HumanMark() {
  return (
    <span className="mx-0.5 inline-flex items-center justify-center rounded-[0.38em] bg-primary/12 px-[0.24em] py-[0.08em] text-primary shadow-[inset_0_0_0_1px_rgba(59,130,246,0.08)] sm:mx-1 sm:px-[0.3em]">
      人类
    </span>
  )
}

export function LandingHeroHeadline() {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [nextIndex, setNextIndex] = useState(headlineSteps.length > 1 ? 1 : 0)
  const [isAnimating, setIsAnimating] = useState(false)

  useEffect(() => {
    if (headlineSteps.length < 2 || isAnimating) return

    const timer = window.setTimeout(() => {
      setIsAnimating(true)
    }, IDLE_MS)

    return () => window.clearTimeout(timer)
  }, [currentIndex, isAnimating])

  const currentStep = headlineSteps[currentIndex]
  const nextStep = headlineSteps[nextIndex]

  const handleTransitionEnd = (event: TransitionEvent<HTMLSpanElement>) => {
    if (
      event.target !== event.currentTarget ||
      event.propertyName !== "transform" ||
      !isAnimating
    ) {
      return
    }

    setCurrentIndex(nextIndex)
    setNextIndex((nextIndex + 1) % headlineSteps.length)
    setIsAnimating(false)
  }

  return (
    <div className="font-display animate-fade-up mt-6 text-[clamp(2rem,7vw,5rem)] leading-[0.96] font-semibold tracking-tight text-slate-950">
      <div className="inline-flex max-w-full flex-nowrap items-center justify-center gap-x-1 leading-none whitespace-nowrap sm:gap-x-1.5">
        <span>让 AI</span>
        <span className="text-primary">
          <RollingWord
            currentWord={currentStep.lead}
            nextWord={nextStep.lead}
            minWidthClass="min-w-[1.15em]"
            isAnimating={isAnimating}
          />
        </span>
        <HumanMark />
        <span className="text-primary">
          <RollingWord
            currentWord={currentStep.tail}
            nextWord={nextStep.tail}
            minWidthClass="min-w-[4.25em] sm:min-w-[4.9em]"
            isAnimating={isAnimating}
            onTransitionEnd={handleTransitionEnd}
          />
        </span>
      </div>
    </div>
  )
}
