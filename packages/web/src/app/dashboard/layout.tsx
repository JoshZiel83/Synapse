'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { useAuthStore } from '@/stores/auth-store';
import { WorkspaceProvider } from './workspace-provider';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import {
  LayoutDashboard,
  MessageSquare,
  Users,
  Kanban,
  Brain,
  FileText,
  LogOut,
  Menu,
  Settings,
  Puzzle,
} from 'lucide-react';
import { useChatStore } from '@/stores/chat-store';
import { ThemeToggle } from '@/components/theme-toggle';

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

function SidebarContent({ pathname, user, onLogout }: { pathname: string; user: any; onLogout: () => void }) {
  const totalUnread = useChatStore((s) => s.totalUnread);
  const initials = user?.name
    ? user.name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)
    : 'U';

  return (
    <div className="relative flex grow flex-col gap-y-5 overflow-y-auto bg-white px-6 pb-4 dark:bg-gray-900">
      {/* Logo */}
      <div className="flex h-16 shrink-0 items-center gap-3">
        <Image src="/synapse.svg" alt="Synapse" width={32} height={32} className="dark:invert" />
        <span className="text-lg font-bold text-gray-900 dark:text-white">Synapse</span>
      </div>

      {/* Navigation */}
      <nav className="flex flex-1 flex-col">
        <ul role="list" className="flex flex-1 flex-col gap-y-7">
          <li>
            <ul role="list" className="-mx-2 space-y-1">
              {navItems.map((item) => {
                const active = item.href === '/dashboard'
                  ? pathname === item.href
                  : pathname.startsWith(item.href);
                const Icon = item.icon;
                const badge = item.href === '/dashboard/chat' ? totalUnread : 0;

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`
                        group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold
                        ${active
                          ? 'bg-gray-50 text-indigo-600 dark:bg-white/5 dark:text-white'
                          : 'text-gray-700 hover:bg-gray-50 hover:text-indigo-600 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white'
                        }
                      `}
                    >
                      <Icon
                        className={`size-6 shrink-0 ${
                          active
                            ? 'text-indigo-600 dark:text-white'
                            : 'text-gray-400 group-hover:text-indigo-600 dark:text-gray-500 dark:group-hover:text-white'
                        }`}
                      />
                      {item.label}
                      {badge > 0 && (
                        <span className="ml-auto flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-indigo-600 text-white text-[10px] font-bold">
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>

          {/* Bottom: theme toggle + user profile */}
          <li className="-mx-6 mt-auto">
            <div className="flex items-center justify-between px-6 py-2">
              <span className="text-xs font-semibold text-gray-400 dark:text-gray-500">Theme</span>
              <ThemeToggle />
            </div>
            <div className="flex items-center gap-x-4 px-6 py-3 text-sm/6 font-semibold text-gray-900 dark:text-white">
              <Avatar className="size-8 bg-gray-50 dark:bg-gray-800">
                <AvatarFallback className="bg-indigo-600 text-white text-xs">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <span className="block truncate">{user?.name}</span>
                <span className="block truncate text-xs font-normal text-gray-500 dark:text-gray-400">{user?.email}</span>
              </div>
              <button
                onClick={onLogout}
                className="p-1.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400 rounded-md hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
                title="Sign out"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          </li>
        </ul>
      </nav>
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
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
          <p className="text-gray-500 dark:text-gray-400 text-sm">Loading Synapse...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  return (
    <WorkspaceProvider>
      <div>
        {/* Mobile Sidebar */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" onClose={() => setMobileOpen(false)} className="w-72 p-0 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-white/10">
            <SidebarContent pathname={pathname} user={user} onLogout={handleLogout} />
          </SheetContent>
        </Sheet>

        {/* Desktop Sidebar */}
        <div className="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-72 lg:flex-col">
          <div className="relative flex grow flex-col border-r border-gray-200 dark:border-white/10">
            <SidebarContent pathname={pathname} user={user} onLogout={handleLogout} />
          </div>
        </div>

        {/* Top bar (mobile only shows hamburger + title) */}
        <div className="sticky top-0 z-40 flex items-center gap-x-6 bg-white px-4 py-4 shadow-xs sm:px-6 lg:hidden dark:bg-gray-900 dark:shadow-none border-b border-gray-200 dark:border-white/10">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="-m-2.5 p-2.5 text-gray-700 dark:text-gray-400"
          >
            <Menu className="size-6" />
          </button>
          <div className="flex-1 text-sm/6 font-semibold text-gray-900 dark:text-white">
            {navItems.find(i => i.href === pathname)?.label || 'Dashboard'}
          </div>
        </div>

        {/* Main Content */}
        <main className="lg:pl-72 flex flex-col min-h-screen lg:h-screen lg:max-h-screen">
          <div className="flex-1 flex flex-col p-4 lg:p-8 min-h-0 overflow-auto">
            {children}
          </div>
        </main>
      </div>
    </WorkspaceProvider>
  );
}
