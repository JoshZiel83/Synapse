"use client"

import { startTransition, useState } from "react"
import { Monitor, Moon, Sun } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { MobilePageHeader } from "@/components/mobile-page-header"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import { resolveFileUrl } from "@/lib/utils"
import { useAuthStore } from "@/stores/auth-store"
import { useEffect } from "react"
import type { RelationshipProfileView } from "@/lib/api"

export default function MobileSettingsPage() {
  const router = useRouter()
  const user = useAuthStore((state) => state.user)
  const logout = useAuthStore((state) => state.logout)
  const { workspaces, workspaceId, setWorkspaceId } = useWorkspace()
  const { theme, setTheme } = useTheme()

  const [loggingOut, setLoggingOut] = useState(false)
  const [friendIdProfile, setFriendIdProfile] =
    useState<RelationshipProfileView | null>(null)
  const [friendIdDraft, setFriendIdDraft] = useState("")
  const [friendIdSaving, setFriendIdSaving] = useState(false)
  const [friendIdMessage, setFriendIdMessage] = useState<string | null>(null)

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

  useEffect(() => {
    if (!workspaceId) {
      setFriendIdProfile(null)
      setFriendIdDraft("")
      return
    }

    let active = true
    void api
      .getMyRelationshipProfile(workspaceId)
      .then((profile) => {
        if (!active) return
        setFriendIdProfile(profile)
        setFriendIdDraft(profile.identityId)
      })
      .catch(() => {
        if (!active) return
        setFriendIdProfile(null)
      })

    return () => {
      active = false
    }
  }, [workspaceId])

  async function handleSaveFriendId() {
    if (!workspaceId) return
    setFriendIdSaving(true)
    setFriendIdMessage(null)
    try {
      const nextProfile = await api.updateMyRelationshipProfile(workspaceId, {
        approvalMode: friendIdProfile?.approvalMode || "auto",
        identityId: friendIdDraft,
        identitySearchEnabled: friendIdProfile?.identitySearchEnabled,
      })
      setFriendIdProfile(nextProfile)
      setFriendIdDraft(nextProfile.identityId)
      setFriendIdMessage(`Identity ID 已更新为 ${nextProfile.identityId}`)
    } catch (error) {
      setFriendIdMessage(error instanceof Error ? error.message : "保存 Identity ID 失败。")
    } finally {
      setFriendIdSaving(false)
    }
  }

  async function handleToggleFriendIdSearch() {
    if (!workspaceId || !friendIdProfile) return
    setFriendIdSaving(true)
    setFriendIdMessage(null)
    try {
      const nextProfile = await api.updateMyRelationshipProfile(workspaceId, {
        approvalMode: friendIdProfile.approvalMode,
        identityId: friendIdProfile.identityId,
        identitySearchEnabled: !friendIdProfile.identitySearchEnabled,
      })
      setFriendIdProfile(nextProfile)
      setFriendIdDraft(nextProfile.identityId)
      setFriendIdMessage(
        nextProfile.identitySearchEnabled
          ? "已开启通过 Identity ID 搜索。"
          : "已关闭通过 Identity ID 搜索。"
      )
    } catch (error) {
      setFriendIdMessage(error instanceof Error ? error.message : "更新搜索开关失败。")
    } finally {
      setFriendIdSaving(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <MobilePageHeader title="Settings" />
      <div className="flex-1 overflow-y-auto px-4 pt-3 pb-[calc(var(--mobile-tab-bar-clearance,0px)+1.5rem)]">
        <div className="space-y-4">
          <section className="-mx-4 border-y border-border/70 bg-background px-4 py-4">
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

          <section className="-mx-4 border-y border-border/70 bg-background px-4 py-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-foreground">
                Workspace
              </h2>
              <p className="text-sm text-muted-foreground">
                Switch the active workspace for this device.
              </p>
            </div>
            <Select
              value={workspaceId || undefined}
              onValueChange={(value) => setWorkspaceId(value)}
            >
              <SelectTrigger className="h-11 rounded-2xl border-border/70 bg-muted/25">
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

          <section className="-mx-4 border-y border-border/70 bg-background px-4 py-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-foreground">
                Appearance
              </h2>
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

          <section className="-mx-4 border-y border-border/70 bg-background px-4 py-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-foreground">Identity ID</h2>
              <p className="text-sm text-muted-foreground">
                Identity ID 是 workspace 身份级别的唯一标识，默认关闭被搜索。
              </p>
            </div>
            <div className="space-y-3">
              <Input
                value={friendIdDraft}
                onChange={(event) => setFriendIdDraft(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="输入你的 Identity ID"
                className="rounded-2xl"
              />
              {friendIdMessage ? (
                <p className="text-sm text-muted-foreground">{friendIdMessage}</p>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full"
                  onClick={() => void handleSaveFriendId()}
                  disabled={friendIdSaving || !friendIdDraft.trim()}
                >
                  {friendIdSaving ? "保存中..." : "保存 ID"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full"
                  onClick={() => void handleToggleFriendIdSearch()}
                  disabled={friendIdSaving || !friendIdProfile}
                >
                  {friendIdProfile?.identitySearchEnabled ? "关闭搜索" : "开启搜索"}
                </Button>
              </div>
            </div>
          </section>

          <section className="-mx-4 border-y border-border/70 bg-background px-4 py-4">
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
    </div>
  )
}
