import * as React from "react"

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"

type AppCardVariant = "panel" | "interactive" | "interactive-dashed"

function AppCard({
  className,
  variant = "panel",
  ...props
}: React.ComponentProps<typeof Card> & { variant?: AppCardVariant }) {
  return (
    <Card
      className={cn(
        variant === "panel" &&
          "gap-0 rounded-[28px] py-0 shadow-sm ring-border/70",
        variant === "interactive" &&
          "cursor-pointer rounded-[24px] ring-border/70 transition-all duration-150 hover:-translate-y-0.5 hover:bg-accent/30 hover:shadow-md hover:ring-foreground/15",
        variant === "interactive-dashed" &&
          "cursor-pointer rounded-[24px] border-dashed bg-muted/10 ring-border/80 transition-all duration-150 hover:-translate-y-0.5 hover:bg-accent/30 hover:shadow-md hover:ring-foreground/20",
        className
      )}
      {...props}
    />
  )
}

export {
  AppCard,
  CardAction as AppCardAction,
  CardContent as AppCardContent,
  CardDescription as AppCardDescription,
  CardFooter as AppCardFooter,
  CardHeader as AppCardHeader,
  CardTitle as AppCardTitle,
}
