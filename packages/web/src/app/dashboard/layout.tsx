'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth-store';
import { WorkspaceProvider } from './workspace-provider';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  LayoutDashboard,
  MessageSquare,
  Users,
  Kanban,
  Brain,
  FileText,
  LogOut,
  Menu,
  Zap,
  ChevronRight,
  Settings,
  Puzzle,
} from 'lucide-react';
import { useChatStore } from '@/stores/chat-store';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/dashboard/chat', label: 'Chat', icon: MessageSquare },
  { href: '/dashboard/organization', label: 'Organization', icon: Users },
  { href: '/dashboard/work-items', label: 'Work Items', icon: Kanban },
  { href: '/dashboard/memories', label: 'Memories', icon: Brain },
  { href: '/dashboard/audit', label: 'Audit Log', icon: FileText },
  { href: '/dashboard/plugins', label: 'Plugins', icon: Puzzle },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
];

function NavLink({ href, label, icon: Icon, active, badge }: { href: string; label: string; icon: any; active: boolean; badge?: number }) {
  return (
    <Link
      href={href}
      className={`
        flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200
        ${active
          ? 'bg-gradient-to-r from-blue-500/20 to-violet-500/20 text-blue-400 border border-blue-500/20 shadow-lg shadow-blue-500/5'
          : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
        }
      `}
    >
      <Icon className={`w-5 h-5 ${active ? 'text-blue-400' : ''}`} />
      <span>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-[10px] font-bold">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {active && !badge && <ChevronRight className="w-4 h-4 ml-auto text-blue-400/50" />}
    </Link>
  );
}

function Sidebar({ pathname }: { pathname: string }) {
  const totalUnread = useChatStore((s) => s.totalUnread);

  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="flex items-center gap-3 px-6 py-6">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 shadow-lg shadow-blue-500/20">
          <Zap className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-bold bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-transparent">
            Synapse
          </h1>
          <p className="text-xs text-muted-foreground">Command Center</p>
        </div>
      </div>

      <Separator className="bg-border/50 mx-4" />

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.icon}
            active={item.href === '/dashboard' ? pathname === item.href : pathname.startsWith(item.href)}
            badge={item.href === '/dashboard/chat' ? totalUnread : undefined}
          />
        ))}
      </nav>

      {/* Bottom section */}
      <div className="p-4">
        <div className="glass-card rounded-xl p-4 text-center">
          <div className="w-8 h-8 rounded-full bg-gradient-to-r from-blue-500 to-violet-500 mx-auto mb-2 flex items-center justify-center">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <p className="text-xs text-muted-foreground">Digital Employee Runtime</p>
          <p className="text-xs text-muted-foreground/60 mt-1">v0.1.0</p>
        </div>
      </div>
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading, checkAuth, logout } = useAuthStore();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center gradient-bg">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          <p className="text-muted-foreground text-sm">Loading Synapse...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  const initials = user.name
    ? user.name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)
    : 'U';

  return (
    <WorkspaceProvider>
      <div className="min-h-screen flex gradient-bg">
        {/* Desktop Sidebar */}
        <aside className="hidden lg:flex lg:w-72 lg:flex-col glass border-r border-blue-500/10 fixed inset-y-0 left-0 z-40">
          <Sidebar pathname={pathname} />
        </aside>

        {/* Mobile Sidebar */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" onClose={() => setMobileOpen(false)} className="w-72 p-0 glass border-r border-blue-500/10">
            <Sidebar pathname={pathname} />
          </SheetContent>
        </Sheet>

        {/* Main Content */}
        <div className="flex-1 lg:ml-72 flex flex-col min-h-screen">
          {/* Top Bar */}
          <header className="sticky top-0 z-30 glass border-b border-blue-500/10">
            <div className="flex items-center justify-between h-16 px-4 lg:px-8">
              <div className="flex items-center gap-4">
                <Button
                  variant="ghost"
                  size="icon"
                  className="lg:hidden text-muted-foreground hover:text-foreground"
                  onClick={() => setMobileOpen(true)}
                >
                  <Menu className="w-5 h-5" />
                </Button>
                <div className="hidden sm:block">
                  <h2 className="text-sm font-medium text-foreground">
                    {navItems.find(i => i.href === pathname)?.label || 'Dashboard'}
                  </h2>
                </div>
              </div>

              <div className="flex items-center gap-4">
                {/* Connection Status */}
                <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full glass-card">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 pulse-glow" />
                  <span className="text-xs text-muted-foreground">Online</span>
                </div>

                {/* User Menu */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="flex items-center gap-3 hover:bg-white/5 rounded-xl px-3">
                      <Avatar className="h-8 w-8 border border-blue-500/20">
                        <AvatarFallback className="bg-gradient-to-br from-blue-500 to-violet-600 text-white text-xs">
                          {initials}
                        </AvatarFallback>
                      </Avatar>
                      <div className="hidden sm:block text-left">
                        <p className="text-sm font-medium text-foreground">{user.name}</p>
                        <p className="text-xs text-muted-foreground">{user.email}</p>
                      </div>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56 glass-card border-blue-500/10">
                    <DropdownMenuLabel className="text-muted-foreground">My Account</DropdownMenuLabel>
                    <DropdownMenuSeparator className="bg-border/50" />
                    <DropdownMenuItem
                      onClick={() => { logout(); router.push('/login'); }}
                      className="text-red-400 focus:text-red-400 focus:bg-red-500/10 cursor-pointer"
                    >
                      <LogOut className="w-4 h-4 mr-2" />
                      Sign Out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </header>

          {/* Page Content */}
          <main className="flex-1 p-4 lg:p-8">
            {children}
          </main>
        </div>
      </div>
    </WorkspaceProvider>
  );
}
