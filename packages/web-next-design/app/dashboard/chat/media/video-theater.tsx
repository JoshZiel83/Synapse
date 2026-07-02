"use client"

// Theater view for a video attachment: native HTML5 controls inside a Radix
// Dialog. The browser's own control bar is clean, never overflows its frame, and
// carries play/scrub/volume/fullscreen/PiP/speed for free — which is exactly the
// "clean, in-bounds controls" the chat bubble couldn't give at 360px. Loaded
// client-only via next/dynamic(ssr:false) from the poster thumbnail.
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

export default function VideoTheater({
  url,
  title,
  onClose,
}: {
  url: string
  title: string
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton
        className="overflow-hidden border-0 bg-black p-0 sm:max-w-3xl"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          src={url}
          controls
          autoPlay
          playsInline
          className="max-h-[80vh] w-full bg-black"
        />
      </DialogContent>
    </Dialog>
  )
}
