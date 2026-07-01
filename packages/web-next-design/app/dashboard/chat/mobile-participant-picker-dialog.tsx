"use client"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

import {
  MobileParticipantPickerScreen,
  type MobileParticipantPickerScreenProps,
} from "./mobile-participant-picker-screen"

type MobileParticipantPickerDialogProps = Omit<
  MobileParticipantPickerScreenProps,
  "onBack"
> & {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function MobileParticipantPickerDialog({
  open,
  onOpenChange,
  title,
  ...props
}: MobileParticipantPickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="inset-0 start-0 top-0 h-[100dvh] max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 ring-0 rtl:translate-x-0"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <MobileParticipantPickerScreen
          title={title}
          onBack={() => onOpenChange(false)}
          {...props}
        />
      </DialogContent>
    </Dialog>
  )
}
