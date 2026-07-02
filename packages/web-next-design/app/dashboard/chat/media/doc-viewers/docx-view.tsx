"use client"

// DOCX preview via docx-preview (renders the OOXML to HTML — not pixel-perfect
// Word, but faithful enough for a chat preview). Its own chunk, loaded only when
// a .docx is previewed.
import { useEffect, useRef, useState } from "react"
import { renderAsync } from "docx-preview"
import { Loader2 } from "lucide-react"

export default function DocxView({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<"loading" | "done" | "error">("loading")

  useEffect(() => {
    let cancelled = false
    fetch(url)
      .then((r) => r.blob())
      .then((blob) => {
        if (cancelled || !ref.current) return
        return renderAsync(blob, ref.current, undefined, {
          className: "docx",
          inWrapper: true,
        })
      })
      .then(() => !cancelled && setState("done"))
      .catch(() => !cancelled && setState("error"))
    return () => {
      cancelled = true
    }
  }, [url])

  return (
    <div className="p-4">
      {state === "loading" && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {state === "error" && (
        <div className="py-16 text-center text-sm text-muted-foreground">
          无法预览此文档
        </div>
      )}
      <div
        ref={ref}
        className="[&_.docx-wrapper]:bg-transparent [&_.docx-wrapper]:p-0 [&_.docx-wrapper>section.docx]:mx-auto [&_.docx-wrapper>section.docx]:mb-4 [&_.docx-wrapper>section.docx]:shadow-sm"
      />
    </div>
  )
}
