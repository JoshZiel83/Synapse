"use client"

// In-dialog document preview. The heavy renderers (pdf.js / docx-preview /
// SheetJS) are each their own dynamic(ssr:false) chunk, loaded only when a file
// of that type is actually opened — the message timeline never pays for them.
// Non-previewable types (pptx, doc, …) never reach here; the card stays a plain
// download launcher for those.
import dynamic from "next/dynamic"
import { Download, Loader2 } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

const Spinner = () => (
  <div className="flex h-full items-center justify-center">
    <Loader2 className="size-5 animate-spin text-muted-foreground" />
  </div>
)

const DocxView = dynamic(() => import("./doc-viewers/docx-view"), {
  ssr: false,
  loading: Spinner,
})
const SheetView = dynamic(() => import("./doc-viewers/sheet-view"), {
  ssr: false,
  loading: Spinner,
})

export default function DocumentPreview({
  url,
  name,
  ext,
  open,
  onClose,
}: {
  url?: string
  name: string
  ext: string
  open: boolean
  onClose: () => void
}) {
  const e = ext.toLowerCase()
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton
        className="flex h-[85vh] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
      >
        <DialogTitle className="flex items-center gap-2 border-b px-4 py-3 pr-12 text-sm font-medium">
          <span className="truncate">{name}</span>
          {url && (
            <a
              href={url}
              download={name}
              className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Download className="size-3.5" />
              下载
            </a>
          )}
        </DialogTitle>
        <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
          {open && url ? (
            e === "pdf" ? (
              // The browser's native PDF viewer — robust, zero-dependency, and
              // no pdf.js worker to wire up. Same-origin content URL.
              <iframe
                src={url}
                title={name}
                className="h-full w-full border-0 bg-white"
              />
            ) : e === "docx" ? (
              <DocxView url={url} />
            ) : (
              <SheetView url={url} />
            )
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
