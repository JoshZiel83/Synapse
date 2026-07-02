"use client"

// Full-screen image viewer with pinch/scroll zoom, arrow/swipe paging across
// all images in the message, a slide counter + thumbnail filmstrip (only when
// there's more than one), and fullscreen. Replaces the bare fixed-inset overlay
// so galleries page the way every IM does. Mounted client-only via
// next/dynamic(ssr:false); it brings its own portal + focus handling.
import Lightbox from "yet-another-react-lightbox"
import Captions from "yet-another-react-lightbox/plugins/captions"
import Counter from "yet-another-react-lightbox/plugins/counter"
import Fullscreen from "yet-another-react-lightbox/plugins/fullscreen"
import Thumbnails from "yet-another-react-lightbox/plugins/thumbnails"
import Zoom from "yet-another-react-lightbox/plugins/zoom"
import "yet-another-react-lightbox/styles.css"
import "yet-another-react-lightbox/plugins/captions.css"
import "yet-another-react-lightbox/plugins/counter.css"
import "yet-another-react-lightbox/plugins/thumbnails.css"

export interface LightboxSlide {
  src: string
  title?: string
}

export default function ImageLightbox({
  slides,
  index,
  onClose,
}: {
  slides: LightboxSlide[]
  index: number
  onClose: () => void
}) {
  const multiple = slides.length > 1
  const plugins = multiple
    ? [Zoom, Captions, Counter, Fullscreen, Thumbnails]
    : [Zoom, Captions, Fullscreen]

  return (
    <Lightbox
      open={index >= 0}
      close={onClose}
      index={Math.max(0, index)}
      slides={slides}
      plugins={plugins}
      controller={{ closeOnBackdropClick: true }}
      counter={{ container: { style: { top: "unset", bottom: 0 } } }}
      styles={{ container: { backgroundColor: "rgba(0,0,0,.85)" } }}
      thumbnails={{ width: 96, height: 64, borderRadius: 6, gap: 8 }}
    />
  )
}
