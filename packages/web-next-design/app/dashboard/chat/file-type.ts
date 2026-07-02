// Resolve a filename to a document-card presentation: a shape-appropriate
// lucide glyph + a type tint, following the near-universal file-type color
// language (PDF red, Word blue, Excel green, PPT orange, archive amber, code
// slate, JSON yellow). lucide has no per-brand file glyphs (no FilePdf/FileWord
// /FileExcel), so identity comes from glyph + tint + a visible EXT label — the
// tint is never the only type signal. Resolve by extension, then category, then
// a generic dog-eared page.
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  type LucideIcon,
} from "lucide-react"

export interface ResolvedFileType {
  Icon: LucideIcon
  /** glyph color class */
  tint: string
  /** faint tile background class */
  tile: string
  /** uppercase extension label, e.g. "PDF" — the non-color type signal */
  ext: string
}

interface Bucket {
  exts: string[]
  Icon: LucideIcon
  tint: string
  tile: string
}

// Order matters only for readability; extensions are unique across buckets.
const BUCKETS: Bucket[] = [
  {
    exts: ["pdf"],
    Icon: FileText,
    tint: "text-red-500",
    tile: "bg-red-500/10",
  },
  { exts: ["doc", "docx", "rtf", "odt"], Icon: FileText, tint: "text-blue-600", tile: "bg-blue-600/10" }, // prettier-ignore
  { exts: ["xls", "xlsx", "ods"], Icon: FileSpreadsheet, tint: "text-green-600", tile: "bg-green-600/10" }, // prettier-ignore
  { exts: ["csv", "tsv"], Icon: FileSpreadsheet, tint: "text-green-600", tile: "bg-green-600/10" }, // prettier-ignore
  { exts: ["ppt", "pptx", "odp", "key"], Icon: Presentation, tint: "text-orange-500", tile: "bg-orange-500/10" }, // prettier-ignore
  { exts: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"], Icon: FileArchive, tint: "text-amber-500", tile: "bg-amber-500/10" }, // prettier-ignore
  { exts: ["js", "ts", "tsx", "jsx", "py", "go", "rs", "java", "c", "cpp", "h", "rb", "php", "sh", "html", "css", "sql"], Icon: FileCode, tint: "text-slate-600", tile: "bg-slate-500/10" }, // prettier-ignore
  { exts: ["json", "jsonc", "yaml", "yml", "toml"], Icon: FileJson, tint: "text-yellow-500", tile: "bg-yellow-500/10" }, // prettier-ignore
  { exts: ["txt", "md", "markdown", "log"], Icon: FileText, tint: "text-slate-500", tile: "bg-slate-500/10" }, // prettier-ignore
]

// Category fallbacks: media that degraded to a card (no loadable preview).
const CATEGORY_FALLBACK: Record<string, Omit<Bucket, "exts">> = {
  image: { Icon: FileImage, tint: "text-violet-500", tile: "bg-violet-500/10" },
  audio: { Icon: FileAudio, tint: "text-pink-500", tile: "bg-pink-500/10" },
  video: { Icon: FileVideo, tint: "text-indigo-500", tile: "bg-indigo-500/10" },
}

const GENERIC: Omit<Bucket, "exts"> = {
  Icon: File,
  tint: "text-slate-400",
  tile: "bg-slate-400/10",
}

// Document types we can render an in-app preview for (PDF via pdf.js, DOCX via
// docx-preview, spreadsheets via SheetJS). Everything else stays download-only.
const PREVIEWABLE = new Set(["pdf", "docx", "xlsx", "xls", "csv", "tsv"])
export function isPreviewable(ext: string): boolean {
  return PREVIEWABLE.has(ext.toLowerCase())
}

export function resolveFileType(
  name: string,
  category?: string
): ResolvedFileType {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : ""
  const label = ext ? ext.toUpperCase() : "FILE"

  for (const b of BUCKETS) {
    if (b.exts.includes(ext)) {
      return { Icon: b.Icon, tint: b.tint, tile: b.tile, ext: label }
    }
  }
  const fallback = (category && CATEGORY_FALLBACK[category]) || GENERIC
  return {
    Icon: fallback.Icon,
    tint: fallback.tint,
    tile: fallback.tile,
    ext: label,
  }
}
