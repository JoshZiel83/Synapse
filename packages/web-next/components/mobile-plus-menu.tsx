"use client"

import { Plus, QrCode, UserRoundPlus, UsersRound } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function MobilePlusMenu({
  onStartGroup,
  onAddFriend,
  onScan,
}: {
  onStartGroup: () => void
  onAddFriend: () => void
  onScan: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 rounded-none px-0 text-foreground hover:bg-transparent"
          aria-label="Open quick actions"
        >
          <Plus className="size-[18px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-48 rounded-2xl border-border/70 bg-background/98 p-1"
      >
        <DropdownMenuItem
          className="rounded-xl"
          onSelect={() => onStartGroup()}
        >
          <UsersRound className="mr-2 size-4" />
          发起群聊
        </DropdownMenuItem>
        <DropdownMenuItem
          className="rounded-xl"
          onSelect={() => onAddFriend()}
        >
          <UserRoundPlus className="mr-2 size-4" />
          添加好友
        </DropdownMenuItem>
        <DropdownMenuItem className="rounded-xl" onSelect={() => onScan()}>
          <QrCode className="mr-2 size-4" />
          扫一扫
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
