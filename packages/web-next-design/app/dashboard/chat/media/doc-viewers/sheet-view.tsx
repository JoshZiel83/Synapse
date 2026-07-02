"use client"

// Spreadsheet preview (xlsx/xls/csv) via SheetJS: parse → first sheet → HTML
// table, styled with Tailwind. Its own chunk, loaded only when a sheet is
// previewed.
import { useEffect, useRef, useState } from "react"
import { read, utils } from "xlsx"
import { Loader2 } from "lucide-react"

export default function SheetView({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<"loading" | "done" | "error">("loading")
  const [sheets, setSheets] = useState<string[]>([])
  const [active, setActive] = useState(0)
  const wbRef = useRef<ReturnType<typeof read> | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (cancelled) return
        const wb = read(buf)
        wbRef.current = wb
        setSheets(wb.SheetNames)
        setState("done")
      })
      .catch(() => !cancelled && setState("error"))
    return () => {
      cancelled = true
    }
  }, [url])

  useEffect(() => {
    const wb = wbRef.current
    if (state !== "done" || !wb || !ref.current) return
    const ws = wb.Sheets[wb.SheetNames[active]]
    ref.current.innerHTML = ws ? utils.sheet_to_html(ws) : ""
  }, [state, active, sheets])

  if (state === "loading")
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  if (state === "error")
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        无法预览此表格
      </div>
    )

  return (
    <div className="flex h-full flex-col">
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 border-b bg-background px-3 py-2">
          {sheets.map((s, i) => (
            <button
              key={s}
              type="button"
              onClick={() => setActive(i)}
              className={
                i === active
                  ? "rounded bg-primary/10 px-2 py-1 text-xs font-medium text-primary"
                  : "rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              }
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <div
        ref={ref}
        className="min-h-0 flex-1 overflow-auto bg-white p-3 text-sm text-black [&_table]:border-collapse [&_td]:border [&_td]:border-gray-200 [&_td]:px-2 [&_td]:py-1 [&_td]:whitespace-nowrap"
      />
    </div>
  )
}
