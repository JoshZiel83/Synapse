'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { buildLoginRedirect } from '@/lib/auth';
import { useAuthStore } from '@/stores/auth-store';
import { WorkspaceProvider, useWorkspace } from './workspace-provider';
import { AppSidebar } from '@/components/app-sidebar';
import { SiteHeader } from '@/components/site-header';
import {
  Bot,
  ContactRound,
  MessageSquare,
  Brain,
  FileText,
  ShieldCheck,
  Puzzle,
  Cpu,
  ScrollText,
} from 'lucide-react';
import {
  SidebarInset,
  SidebarProvider,
} from '@/components/ui/sidebar';

const navItems = [
  { href: '/dashboard/chat', label: 'Chat', icon: MessageSquare },
  { href: '/dashboard/contacts', label: 'Contacts', icon: ContactRound },
  { href: '/dashboard/memories', label: 'Memories', icon: Brain },
  { href: '/dashboard/skills', label: 'Skills', icon: ScrollText },
  { href: '/dashboard/audit', label: 'Audit Log', icon: FileText },
  { href: '/dashboard/plugins', label: 'Plugins', icon: Puzzle },
  { href: '/settings/models', label: 'Model Groups', icon: Cpu },
  { href: '/settings/models/actors', label: 'Actor Assignment', icon: Bot },
  { href: '/dashboard/access', label: 'Access', icon: ShieldCheck },
];

function OnboardingGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { needsOnboarding, loading } = useWorkspace();

  useEffect(() => {
    if (!loading && needsOnboarding) {
      router.replace('/welcome');
    }
  }, [loading, needsOnboarding, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          <p className="text-muted-foreground text-sm">Loading workspace...</p>
        </div>
      </div>
    );
  }

  if (needsOnboarding) return null;

  return <>{children}</>;
}

function DashboardInner({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const isFullPaneRoute =
    pathname.startsWith('/dashboard/chat') ||
    pathname.startsWith('/dashboard/contacts') ||
    pathname.startsWith('/dashboard/memories') ||
    pathname.startsWith('/dashboard/skills') ||
    pathname.startsWith('/dashboard/actors') ||
    pathname.startsWith('/dashboard/plugins/') ||
    pathname.startsWith('/settings/models');
  const matchedNavItem = navItems
    .filter((item) =>
      pathname === item.href || pathname.startsWith(`${item.href}/`),
    )
    .sort((left, right) => right.href.length - left.href.length)[0];
  const pageTitle = pathname.startsWith('/dashboard/actors')
    ? 'Actors'
    : matchedNavItem?.label || 'Chat';

  const handleLogout = () => {
    void logout().finally(() => {
      router.push('/login');
    });
  };

  return (
    <OnboardingGuard>
      <SidebarProvider className="h-svh overflow-hidden">
        <AppSidebar user={user} onLogout={handleLogout} />
        <SidebarInset className="min-h-0 bg-background">
          <SiteHeader title={pageTitle} />
          <div className="flex flex-1 min-h-0 flex-col">
            <div className="@container/main flex flex-1 min-h-0 flex-col">
              <div className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto md:gap-6">
                <div
                  className={
                    isFullPaneRoute
                      ? 'flex-1 min-h-0'
                      : 'flex-1 px-4 lg:px-6'
                  }
                >
                  {children}
                </div>
              </div>
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </OnboardingGuard>
  );
}

export default function DashboardLayoutClient({
  children,
}: {
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const user = useAuthStore((state) => state.user);

  useEffect(() => {
    if (!user) {
      const currentTarget = typeof window !== 'undefined'
        ? `${window.location.pathname}${window.location.search}`
        : pathname;
      router.replace(buildLoginRedirect(currentTarget));
    }
  }, [user, pathname, router]);

  if (!user) return null;

  return (
    <WorkspaceProvider>
      <DashboardInner>{children}</DashboardInner>
    </WorkspaceProvider>
  );
}
