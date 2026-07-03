"use client"

// A light searchable combobox (Popover + filtered list) — no cmdk dependency.
// Used for the timezone, event-source, and conversation pickers.
import { useMemo, useState } from "react"
import { Check, ChevronsUpDown, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export interface ComboOption {
  value: string
  label: string
  hint?: string
  group?: string
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = "选择…",
  searchPlaceholder = "搜索…",
  emptyText = "无匹配项",
  className,
  renderOption,
}: {
  options: ComboOption[]
  value?: string
  onChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  className?: string
  renderOption?: (o: ComboOption) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const selected = options.find((o) => o.value === value)

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return options
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(needle) ||
        o.value.toLowerCase().includes(needle) ||
        o.hint?.toLowerCase().includes(needle)
    )
  }, [options, q])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-full justify-between font-normal", className)}
        >
          <span
            className={cn("truncate", !selected && "text-muted-foreground")}
          >
            {selected ? selected.label : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 opacity-50" />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-9 border-0 px-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {emptyText}
            </div>
          ) : (
            filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                  setQ("")
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent",
                  o.value === value && "bg-accent/50"
                )}
              >
                <Check
                  className={cn(
                    "size-4 shrink-0",
                    o.value === value ? "opacity-100" : "opacity-0"
                  )}
                />
                {renderOption ? (
                  renderOption(o)
                ) : (
                  <span className="min-w-0 flex-1">
                    <span className="truncate">{o.label}</span>
                    {o.hint && (
                      <span className="ml-2 truncate text-xs text-muted-foreground">
                        {o.hint}
                      </span>
                    )}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
