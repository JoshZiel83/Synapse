import { Badge } from "../components/ui/badge"
import type { LogEntry } from "../types"

function logTone(type: string) {
  if (type === "error" || type === "auth_failed") return "text-destructive"
  if (
    type === "connected" ||
    type === "servers_ready" ||
    type === "server_ready"
  )
    return "text-[color:var(--status-success-fg)]"
  if (type === "server_pending") return "text-primary"
  if (type === "tool_call" || type === "tool_result") return "text-primary"
  return "text-muted-foreground"
}

interface LogsPanelProps {
  logs: LogEntry[]
}

function formatLogData(data?: Record<string, unknown>) {
  if (!data || Object.keys(data).length === 0) {
    return ""
  }

  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

export function LogsPanel({ logs }: LogsPanelProps) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h1 className="text-[28px] leading-none font-semibold tracking-tight text-foreground">
          Logs
        </h1>
        <div className="mt-3 text-sm text-muted-foreground">
          Recent relay and pairing events.
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div />
        <Badge variant="secondary">{logs.length}</Badge>
      </div>

      {logs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
          No logs yet.
        </div>
      ) : (
        <div className="rounded-2xl border border-border/60 bg-muted/50 px-3 py-3 font-mono text-xs">
          <div className="flex flex-col gap-1">
            {logs.map((log, index) => (
              <div
                key={`${log.time}-${index}`}
                className="flex gap-3 rounded-xl px-2 py-1.5 hover:bg-background/30"
              >
                <span className="shrink-0 text-muted-foreground">
                  {log.time}
                </span>
                <span
                  className={`w-24 shrink-0 text-right ${logTone(log.type)}`}
                >
                  [{log.type}]
                </span>
                <div className="min-w-0 flex-1">
                  <div className="break-all text-foreground/90">
                    {log.message}
                  </div>
                  {formatLogData(log.data) ? (
                    <pre className="mt-1 overflow-x-auto rounded-lg bg-background/60 px-2 py-2 text-[11px] break-all whitespace-pre-wrap text-muted-foreground">
                      {formatLogData(log.data)}
                    </pre>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
