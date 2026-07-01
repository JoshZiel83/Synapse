"use client"

// Root error boundary — catches render errors in the root layout (which
// per-segment error.tsx cannot) and reports them to Sentry. Must render its own
// <html>/<body>.
import * as Sentry from "@sentry/nextjs"
import { useEffect } from "react"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html>
      <body>
        <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
          <h2>出错了 / Something went wrong</h2>
          <p>请重试，或刷新页面。/ Please try again or reload.</p>
          <button onClick={() => reset()}>重试 / Try again</button>
        </div>
      </body>
    </html>
  )
}
