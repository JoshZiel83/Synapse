"use client"

import * as React from "react"
import Link from "next/link"
import Image from "next/image"
import { usePathname, useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import {
  Brain,
  ChevronsUpDown,
  ContactRound,
  FileText,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Moon,
  Plus,
  Puzzle,
  Settings,
  ShieldCheck,
  Sun,
} from "lucide-react"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { useChatStore } from "@/stores/chat-store"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/chat", label: "Chat", icon: MessageSquare },
  { href: "/dashboard/contacts", label: "Contacts", icon: ContactRound },
]

const knowledgeItems = [
  { href: "/dashboard/memories", label: "Memories", icon: Brain },
  { href: "/dashboard/plugins", label: "Plugins", icon: Puzzle },
  { href: "/dashboard/authorizations", label: "Authorizations", icon: ShieldCheck },
  { href: "/dashboard/audit", label: "Audit Log", icon: FileText },
]

const secondaryItems = [{ href: "/dashboard/settings", label: "Settings", icon: Settings }]

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
  return (
    <SidebarGroup>
      {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const active = item.href === "/dashboard" ? pathname === item.href : pathname.startsWith(item.href)
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
  user: { name?: string; email?: string } | null
  onLogout: () => void
}) {
  const { isMobile } = useSidebar()
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

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
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="size-8 rounded-lg">
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
  user: { name?: string; email?: string } | null
  onLogout: () => void
} & React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname()
  const router = useRouter()
  const unreadCount = useChatStore((state) => state.totalUnread)
  const { workspaceId, workspaces, setWorkspaceId } = useWorkspace()

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
        <NavSection label="Preferences" items={secondaryItems} pathname={pathname} />
      </SidebarContent>

      <SidebarFooter>
        <NavUser user={user} onLogout={onLogout} />
      </SidebarFooter>
    </Sidebar>
  )
}
