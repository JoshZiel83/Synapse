"use client"

import * as React from "react"
import Link from "next/link"
import Image from "next/image"
import { usePathname, useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import {
  Bot,
  Brain,
  ChevronsUpDown,
  ContactRound,
  Cpu,
  FileText,
  ImagePlus,
  Loader2,
  LogOut,
  MessageSquare,
  Moon,
  Puzzle,
  ShieldCheck,
  Sun,
  UsersRound,
} from "lucide-react"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { useChatStore } from "@/stores/chat-store"
import { useAuthStore } from "@/stores/auth-store"
import { api } from "@/lib/api"
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
import { TeamSwitcher } from "@/components/team-switcher"

const mainItems = [
  { href: "/dashboard/chat", label: "Chat", icon: MessageSquare },
  { href: "/dashboard/contacts", label: "Contacts", icon: ContactRound },
]

const knowledgeItems = [
  { href: "/dashboard/memories", label: "Memories", icon: Brain },
  { href: "/dashboard/plugins", label: "Plugins", icon: Puzzle },
  { href: "/dashboard/audit", label: "Audit Log", icon: FileText },
]

const modelItems = [
  { href: "/settings/models", label: "Groups", icon: Cpu },
  { href: "/settings/models/actors", label: "Actors", icon: Bot },
]

const roleItems = [
  { href: "/roles/workspace", label: "Workspace", icon: UsersRound },
  { href: "/roles/platform", label: "Platform", icon: ShieldCheck },
]

const emptyWorkspaceNavigation = {
  canViewWorkspace: false,
  canAccessWorkspaceModels: false,
  canAccessWorkspaceUserModels: false,
  canAccessWorkspaceRoles: false,
}

const emptyPlatformNavigation = {
  canAccessPlatformModels: false,
  canAccessPlatformRoles: false,
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
    return pathname.startsWith("/dashboard/contacts") || pathname.startsWith("/dashboard/actors")
  }

  if (href === "/dashboard/memories") {
    return pathname === href || pathname.startsWith("/dashboard/memories/")
  }

  if (href === "/dashboard/plugins") {
    return pathname === href || pathname.startsWith("/dashboard/plugins/")
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
  items: Array<{ href: string; label: string; icon: React.ComponentType<{ className?: string }> }>
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
                <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
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

  async function handleAvatarFile(file: File | null) {
    if (!file || !workspaceId) return
    setAvatarUploading(true)
    try {
      const uploaded = await api.uploadFile(workspaceId, file)
      const updated = await api.updateMe({ avatarUrl: uploaded.url || uploaded.fullUrl || null })
      useAuthStore.getState().setUser(updated?.user || updated)
    } catch (error) {
      console.error("Failed to update user avatar:", error)
    } finally {
      setAvatarUploading(false)
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="size-8 rounded-lg">
                <AvatarImage src={user?.avatarUrl || undefined} alt={user?.name || "User"} />
                <AvatarFallback className="rounded-lg bg-sidebar-primary text-xs text-sidebar-primary-foreground">{initials}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{user?.name || "User"}</span>
                <span className="truncate text-xs text-muted-foreground">{user?.email || "No email"}</span>
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
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="size-8 rounded-lg">
                  <AvatarImage src={user?.avatarUrl || undefined} alt={user?.name || "User"} />
                  <AvatarFallback className="rounded-lg bg-sidebar-primary text-xs text-sidebar-primary-foreground">{initials}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user?.name || "User"}</span>
                  <span className="truncate text-xs text-muted-foreground">{user?.email || "No email"}</span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => setTheme(mounted && theme === "dark" ? "light" : "dark")}>
                {mounted && theme === "dark" ? <Sun /> : <Moon />}
                {mounted && theme === "dark" ? "Light mode" : "Dark mode"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => fileInputRef.current?.click()} disabled={!workspaceId || avatarUploading}>
                {avatarUploading ? <Loader2 className="animate-spin" /> : <ImagePlus />}
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
  const [workspaceNavigation, setWorkspaceNavigation] = React.useState(emptyWorkspaceNavigation)
  const [platformNavigation, setPlatformNavigation] = React.useState(emptyPlatformNavigation)

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
      ? api.getWorkspaceNavigation(workspaceId).catch(() => ({ data: emptyWorkspaceNavigation }))
      : Promise.resolve({ data: emptyWorkspaceNavigation })

    const platformNavigationPromise = api
      .getPlatformNavigation()
      .catch(() => ({ data: emptyPlatformNavigation }))

    Promise.all([workspaceNavigationPromise, platformNavigationPromise]).then(
      ([workspaceResponse, platformResponse]) => {
        if (cancelled) {
          return
        }

        setWorkspaceNavigation(workspaceResponse?.data ?? emptyWorkspaceNavigation)
        setPlatformNavigation(platformResponse?.data ?? emptyPlatformNavigation)
      }
    )

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const visibleModelItems = React.useMemo(() => {
    const items = []

    if (workspaceNavigation.canAccessWorkspaceModels || workspaceNavigation.canAccessWorkspaceUserModels || platformNavigation.canAccessPlatformModels || user) {
      items.push(modelItems[0])
    }
    if (workspaceNavigation.canAccessWorkspaceModels) {
      items.push(modelItems[1])
    }

    return items
  }, [platformNavigation.canAccessPlatformModels, user, workspaceNavigation.canAccessWorkspaceModels, workspaceNavigation.canAccessWorkspaceUserModels])

  const visibleRoleItems = React.useMemo(() => {
    const items = []

    if (workspaceNavigation.canAccessWorkspaceRoles) {
      items.push(roleItems[0])
    }
    if (platformNavigation.canAccessPlatformRoles) {
      items.push(roleItems[1])
    }

    return items
  }, [platformNavigation.canAccessPlatformRoles, workspaceNavigation.canAccessWorkspaceRoles])

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
        <NavSection items={mainItems} pathname={pathname} unreadCount={unreadCount} />
        <NavSection label="Workspace" items={knowledgeItems} pathname={pathname} />
        <NavSection label="Models" items={visibleModelItems} pathname={pathname} />
        <NavSection label="Roles" items={visibleRoleItems} pathname={pathname} />
      </SidebarContent>

      <SidebarFooter>
        <NavUser user={user} onLogout={onLogout} />
      </SidebarFooter>
    </Sidebar>
  )
}
