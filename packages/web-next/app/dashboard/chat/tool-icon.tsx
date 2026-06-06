"use client"

// Maps a tool descriptor's semantic icon name → a lucide icon component.
// Single source of truth shared by the activity bubble and the server-tool
// display, so adding a new descriptor icon is one entry here (with a Wrench
// default for anything unmapped). Keeps the FE free of per-tool branching.

import {
  AlarmClock,
  AppWindow,
  BookOpen,
  Brain,
  Camera,
  Clock,
  Code,
  Database,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  Focus,
  Folder,
  Gauge,
  GitCompare,
  Globe,
  History,
  Hourglass,
  Image,
  Keyboard,
  Link,
  List,
  ListChecks,
  MessageCircleQuestion,
  Monitor,
  MousePointerClick,
  Network,
  Pencil,
  Plug,
  Puzzle,
  RotateCcw,
  Rss,
  ScrollText,
  Search,
  Send,
  Terminal,
  Trash,
  Upload,
  UserPlus,
  Workflow,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react"

const ICONS: Record<string, LucideIcon> = {
  "alarm-clock": AlarmClock,
  "app-window": AppWindow,
  "book-open": BookOpen,
  brain: Brain,
  camera: Camera,
  clock: Clock,
  code: Code,
  database: Database,
  "file-pen": FilePen,
  "file-plus": FilePlus,
  "file-search": FileSearch,
  "file-text": FileText,
  focus: Focus,
  folder: Folder,
  gauge: Gauge,
  "git-compare": GitCompare,
  globe: Globe,
  history: History,
  hourglass: Hourglass,
  image: Image,
  keyboard: Keyboard,
  link: Link,
  list: List,
  "list-checks": ListChecks,
  "message-circle-question": MessageCircleQuestion,
  monitor: Monitor,
  "mouse-pointer-click": MousePointerClick,
  network: Network,
  pencil: Pencil,
  plug: Plug,
  puzzle: Puzzle,
  "rotate-ccw": RotateCcw,
  rss: Rss,
  "scroll-text": ScrollText,
  search: Search,
  send: Send,
  terminal: Terminal,
  trash: Trash,
  upload: Upload,
  "user-plus": UserPlus,
  workflow: Workflow,
  wrench: Wrench,
  "x-circle": XCircle,
}

export function getToolIcon(name: string | undefined): LucideIcon {
  return (name && ICONS[name]) || Wrench
}

export function ToolIcon({
  name,
  className,
}: {
  name: string | undefined
  className?: string
}) {
  const Icon = getToolIcon(name)
  return <Icon className={className} />
}
