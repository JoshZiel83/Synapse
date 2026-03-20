"use client"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

import {
  MobileActorPickerScreen,
  type MobileActorPickerScreenProps,
} from "@/components/mobile-actor-picker-screen"

type MobileActorPickerDialogProps = Omit<
  MobileActorPickerScreenProps,
  "onBack"
> & {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function MobileActorPickerDialog({
  open,
  onOpenChange,
  title,
  ...props
}: MobileActorPickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="inset-0 top-0 start-0 h-[100dvh] max-w-none translate-x-0 rtl:translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 ring-0"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <MobileActorPickerScreen
          title={title}
          onBack={() => onOpenChange(false)}
          {...props}
        />
      </DialogContent>
    </Dialog>
  )
}
