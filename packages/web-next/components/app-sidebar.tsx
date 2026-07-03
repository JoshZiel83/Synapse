"use client"

import * as React from "react"
import Link from "next/link"
import Image from "next/image"
import { usePathname, useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import {
  Bell,
  Bot,
  Brain,
  ChevronsUpDown,
  Clock3,
  ContactRound,
  Cpu,
  House,
  ImagePlus,
  Loader2,
  Link2,
  LogOut,
  MessageSquare,
  Moon,
  Puzzle,
  ScrollText,
  SquareTerminal,
  ShieldCheck,
  Sun,
} from "lucide-react"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { useChatStore } from "@/stores/chat-store"
import { useAuthStore } from "@/stores/auth-store"
import { api } from "@/lib/api"
import { resolveFileUrl } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { SidebarWeixinBinding } from "@/components/sidebar-weixin-binding"
import { TeamSwitcher } from "@/components/team-switcher"
import { toast } from "sonner"

import { createLogger } from "@/lib/client-logger"

const clientLog = createLogger("web.components.app-sidebar")

const mainItems = [
  { href: "/dashboard", label: "Home", icon: House },
  { href: "/dashboard/chat", label: "Chat", icon: MessageSquare },
  { href: "/dashboard/contacts", label: "Contacts", icon: ContactRound },
  {
    href: "/dashboard/remote-agents",
    label: "Remote Agents",
    icon: SquareTerminal,
  },
]

const knowledgeItems = [
  { href: "/dashboard/memories", label: "Memories", icon: Brain },
  { href: "/dashboard/skills", label: "Skills", icon: ScrollText },
  { href: "/dashboard/plugins", label: "Plugins", icon: Puzzle },
]

const automationItems = [
  { href: "/dashboard/event-sources", label: "Event Sources", icon: Bell },
  { href: "/dashboard/triggers", label: "Triggers", icon: Clock3 },
]

const modelItems = [
  { href: "/settings/models", label: "Groups", icon: Cpu },
  { href: "/settings/models/actors", label: "Actors", icon: Bot },
]

const accessItems = [
  { href: "/dashboard/access", label: "Access", icon: ShieldCheck },
]

const emptyWorkspaceNavigation = {
  canViewWorkspace: false,
  canAccessWorkspaceModels: false,
  canAccessWorkspaceMemberModels: false,
  canAccessWorkspaceAccess: false,
}

const emptyPlatformNavigation = {
  canAccessPlatformModels: false,
  canAccessPlatformAccess: false,
  canAccessPlatformSkills: false,
}

function SynapseLogo({ className }: { className?: string }) {
  return (
    <Image
      src="/synapse.svg"
      alt=""
      width={16}
      height={16}
      className={[className, "brightness-0 invert"].filter(Boolean).join(" ")}
    />
  )
}

function isItemActive(pathname: string, href: string) {
  if (href === "/dashboard/contacts") {
    return (
      pathname.startsWith("/dashboard/contacts") ||
      pathname.startsWith("/dashboard/actors")
    )
  }

  if (href === "/dashboard/memories") {
    return pathname === href || pathname.startsWith("/dashboard/memories/")
  }

  if (href === "/dashboard/plugins") {
    return pathname === href || pathname.startsWith("/dashboard/plugins/")
  }

  if (href === "/dashboard/remote-agents") {
    return pathname === href || pathname.startsWith("/dashboard/remote-agents/")
  }

  if (href === "/dashboard/triggers") {
    return pathname === href || pathname.startsWith("/dashboard/triggers/")
  }

  if (href === "/dashboard/skills") {
    return pathname === href || pathname.startsWith("/dashboard/skills/")
  }

  return pathname === href
}

function NavSection({
  label,
  items,
  pathname,
  unreadCount = 0,
}: {
  label?: string
  items: Array<{
    href: string
    label: string
    icon: React.ComponentType<{ className?: string }>
  }>
  pathname: string
  unreadCount?: number
}) {
  if (items.length === 0) {
    return null
  }

  return (
    <SidebarGroup>
      {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const active =
              item.href === "/dashboard"
                ? pathname === item.href
                : isItemActive(pathname, item.href)
            const Icon = item.icon
            const badge = item.href === "/dashboard/chat" ? unreadCount : 0

            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton
                  asChild
                  isActive={active}
                  tooltip={item.label}
                >
                  <Link href={item.href}>
                    <Icon />
                    <span>{item.label}</span>
                    {badge > 0 ? (
                      <span className="ml-auto flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                        {badge > 99 ? "99+" : badge}
                      </span>
                    ) : null}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function NavUser({
  user,
  onLogout,
}: {
  user: { name?: string; email?: string; avatarUrl?: string } | null
  onLogout: () => void
}) {
  const { isMobile } = useSidebar()
  const { theme, setTheme } = useTheme()
  const { workspaceId } = useWorkspace()
  const setUser = useAuthStore((state) => state.setUser)
  const [mounted, setMounted] = React.useState(false)
  const [avatarUploading, setAvatarUploading] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((part) => part[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "U"
  const avatarSrc = resolveFileUrl(user?.avatarUrl)

  async function handleAvatarFile(file: File | null) {
    if (!file) return
    if (!workspaceId) {
      toast.error("Open a workspace before uploading an avatar")
      return
    }
    setAvatarUploading(true)
    try {
      const uploaded = await api.uploadFile(workspaceId, file)
      const updated = await api.updateMe({ avatarFileId: uploaded.id })
      setUser(updated?.user || updated)
      toast.success("Avatar updated")
    } catch (error) {
      clientLog.error("Failed to update user avatar:", error)
      toast.error(
        error instanceof Error ? error.message : "Avatar upload failed"
      )
    } finally {
      setAvatarUploading(false)
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0] || null
            void handleAvatarFile(file)
            event.target.value = ""
          }}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="size-8 rounded-lg">
                <AvatarImage
                  src={avatarSrc || undefined}
                  alt={user?.name || "User"}
                />
                <AvatarFallback className="rounded-lg bg-sidebar-primary text-xs text-sidebar-primary-foreground">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">
                  {user?.name || "User"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {user?.email || "No email"}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="size-8 rounded-lg">
                  <AvatarImage
                    src={avatarSrc || undefined}
                    alt={user?.name || "User"}
                  />
                  <AvatarFallback className="rounded-lg bg-sidebar-primary text-xs text-sidebar-primary-foreground">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">
                    {user?.name || "User"}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user?.email || "No email"}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link href="/dashboard/im">
                  <Link2 />
                  IM
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  setTheme(mounted && theme === "dark" ? "light" : "dark")
                }
              >
                {mounted && theme === "dark" ? <Sun /> : <Moon />}
                {mounted && theme === "dark" ? "Light mode" : "Dark mode"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  fileInputRef.current?.click()
                }}
                disabled={!workspaceId || avatarUploading}
              >
                {avatarUploading ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <ImagePlus />
                )}
                {avatarUploading ? "Uploading avatar..." : "Change avatar"}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onLogout}>
              <LogOut />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

export function AppSidebar({
  user,
  onLogout,
  ...props
}: {
  user: { name?: string; email?: string; avatarUrl?: string } | null
  onLogout: () => void
} & React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname()
  const router = useRouter()
  const unreadCount = useChatStore((state) => state.totalUnread)
  const { workspaceId, workspaces, setWorkspaceId } = useWorkspace()
  const [workspaceNavigation, setWorkspaceNavigation] = React.useState(
    emptyWorkspaceNavigation
  )
  const [platformNavigation, setPlatformNavigation] = React.useState(
    emptyPlatformNavigation
  )

  const teams = React.useMemo(
    () =>
      workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        logo: SynapseLogo,
        plan: "Synapse Workspace",
      })),
    [workspaces]
  )

  React.useEffect(() => {
    let cancelled = false

    const workspaceNavigationPromise = workspaceId
      ? api
          .getWorkspaceNavigation(workspaceId)
          .catch(() => emptyWorkspaceNavigation)
      : Promise.resolve(emptyWorkspaceNavigation)

    const platformNavigationPromise = api
      .getPlatformNavigation()
      .catch(() => emptyPlatformNavigation)

    Promise.all([workspaceNavigationPromise, platformNavigationPromise]).then(
      ([workspaceResponse, platformResponse]) => {
        if (cancelled) {
          return
        }

        setWorkspaceNavigation(workspaceResponse ?? emptyWorkspaceNavigation)
        setPlatformNavigation(platformResponse ?? emptyPlatformNavigation)
      }
    )

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const visibleModelItems = React.useMemo(() => {
    const items = []

    if (
      workspaceNavigation.canAccessWorkspaceModels ||
      workspaceNavigation.canAccessWorkspaceMemberModels ||
      platformNavigation.canAccessPlatformModels ||
      user
    ) {
      items.push(modelItems[0])
    }
    if (workspaceNavigation.canAccessWorkspaceModels) {
      items.push(modelItems[1])
    }

    return items
  }, [
    platformNavigation.canAccessPlatformModels,
    user,
    workspaceNavigation.canAccessWorkspaceModels,
    workspaceNavigation.canAccessWorkspaceMemberModels,
  ])

  const visibleAccessItems = React.useMemo(() => {
    if (
      !workspaceNavigation.canAccessWorkspaceAccess &&
      !platformNavigation.canAccessPlatformAccess
    ) {
      return []
    }

    return accessItems
  }, [
    platformNavigation.canAccessPlatformAccess,
    workspaceNavigation.canAccessWorkspaceAccess,
  ])

  const visibleAutomationItems = React.useMemo(() => {
    if (!workspaceNavigation.canViewWorkspace) {
      return []
    }

    return automationItems
  }, [workspaceNavigation.canViewWorkspace])

  return (
    <Sidebar collapsible="offcanvas" variant="inset" {...props}>
      <SidebarHeader>
        <TeamSwitcher
          teams={teams}
          activeTeamId={workspaceId ?? undefined}
          label="Workspaces"
          onTeamSelect={(team) => setWorkspaceId(team.id)}
          onAddTeam={() => router.push("/welcome")}
        />
      </SidebarHeader>

      <SidebarContent>
        <NavSection
          items={mainItems}
          pathname={pathname}
          unreadCount={unreadCount}
        />
        <NavSection
          label="Workspace"
          items={knowledgeItems}
          pathname={pathname}
        />
        <NavSection
          label="Automation"
          items={visibleAutomationItems}
          pathname={pathname}
        />
        <NavSection
          label="Models"
          items={visibleModelItems}
          pathname={pathname}
        />
        <NavSection
          label="Access"
          items={visibleAccessItems}
          pathname={pathname}
        />
      </SidebarContent>

      <SidebarFooter>
        <SidebarWeixinBinding />
        <NavUser user={user} onLogout={onLogout} />
      </SidebarFooter>
    </Sidebar>
  )
}
