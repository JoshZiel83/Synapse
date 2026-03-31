"use client"

import { Search } from "lucide-react"
import type { ReactNode } from "react"

import { MobilePlusMenu } from "@/components/mobile-plus-menu"
import { Button } from "@/components/ui/button"

export function MobileHeaderActions({
  onSearch,
  onStartGroup,
  onAddFriend,
  onScan,
  extraAction,
}: {
  onSearch: () => void
  onStartGroup: () => void
  onAddFriend: () => void
  onScan: () => void
  extraAction?: ReactNode
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 rounded-none px-0 text-foreground hover:bg-transparent"
        aria-label="搜索"
        onClick={onSearch}
      >
        <Search className="size-[18px]" />
      </Button>
      {extraAction}
      <MobilePlusMenu
        onStartGroup={onStartGroup}
        onAddFriend={onAddFriend}
        onScan={onScan}
      />
    </div>
  )
}
