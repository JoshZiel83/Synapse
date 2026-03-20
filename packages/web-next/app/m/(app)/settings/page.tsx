"use client"

import { startTransition, useState } from "react"
import { Monitor, Moon, Sun } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { resolveFileUrl } from "@/lib/utils"
import { useAuthStore } from "@/stores/auth-store"

export default function MobileSettingsPage() {
  const router = useRouter()
  const user = useAuthStore((state) => state.user)
  const logout = useAuthStore((state) => state.logout)
  const { workspaces, workspaceId, setWorkspaceId } = useWorkspace()
  const { theme, setTheme } = useTheme()

  const [loggingOut, setLoggingOut] = useState(false)

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((part) => part[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "U"

  async function handleLogout() {
    setLoggingOut(true)
    try {
      await logout()
      startTransition(() => {
        router.push("/login")
      })
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-4 pb-[calc(var(--mobile-tab-bar-clearance,0px)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Settings
          </h1>
        </div>

        <section className="-mx-4 border-y border-border/70 bg-background/80 px-4 py-4">
          <div className="flex items-center gap-3">
            <Avatar className="size-14 rounded-2xl">
              <AvatarImage
                src={resolveFileUrl(user?.avatarUrl) || undefined}
                alt={user?.name || "User"}
              />
              <AvatarFallback className="rounded-2xl text-sm">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-semibold text-foreground">
                {user?.name || "User"}
              </div>
              <div className="truncate text-sm text-muted-foreground">
                {user?.email || "No email available"}
              </div>
            </div>
          </div>
        </section>

        <section className="-mx-4 border-y border-border/70 bg-background/80 px-4 py-4">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-foreground">Workspace</h2>
            <p className="text-sm text-muted-foreground">
              Switch the active workspace for this device.
            </p>
          </div>
          <Select
            value={workspaceId || undefined}
            onValueChange={(value) => setWorkspaceId(value)}
          >
            <SelectTrigger className="h-11 rounded-full border-border/70 bg-background">
              <SelectValue placeholder="Select workspace" />
            </SelectTrigger>
            <SelectContent>
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>

        <section className="-mx-4 border-y border-border/70 bg-background/80 px-4 py-4">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-foreground">Appearance</h2>
            <p className="text-sm text-muted-foreground">
              Choose the theme used in the mobile shell.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Button
              type="button"
              variant={theme === "light" ? "default" : "outline"}
              className="rounded-full"
              onClick={() => setTheme("light")}
            >
              <Sun className="mr-2 size-4" />
              Light
            </Button>
            <Button
              type="button"
              variant={theme === "dark" ? "default" : "outline"}
              className="rounded-full"
              onClick={() => setTheme("dark")}
            >
              <Moon className="mr-2 size-4" />
              Dark
            </Button>
            <Button
              type="button"
              variant={theme === "system" ? "default" : "outline"}
              className="rounded-full"
              onClick={() => setTheme("system")}
            >
              <Monitor className="mr-2 size-4" />
              Auto
            </Button>
          </div>
        </section>

        <section className="-mx-4 border-y border-border/70 bg-background/80 px-4 py-4">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-foreground">Session</h2>
            <p className="text-sm text-muted-foreground">
              Sign out from the current mobile session.
            </p>
          </div>
          <Button
            type="button"
            variant="destructive"
            className="w-full rounded-full"
            onClick={() => void handleLogout()}
            disabled={loggingOut}
          >
            {loggingOut ? "Signing out..." : "Sign out"}
          </Button>
        </section>
      </div>
    </div>
  )
}
