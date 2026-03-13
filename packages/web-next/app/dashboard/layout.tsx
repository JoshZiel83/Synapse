'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/stores/auth-store';
import { WorkspaceProvider, useWorkspace } from './workspace-provider';
import { AppSidebar } from '@/components/app-sidebar';
import { SiteHeader } from '@/components/site-header';
import {
  ContactRound,
  LayoutDashboard,
  MessageSquare,
  Brain,
  FileText,
  ShieldCheck,
  Settings,
  Puzzle,
} from 'lucide-react';
import {
  SidebarInset,
  SidebarProvider,
} from '@/components/ui/sidebar';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/dashboard/chat', label: 'Chat', icon: MessageSquare },
  { href: '/dashboard/contacts', label: 'Contacts', icon: ContactRound },
  { href: '/dashboard/memories', label: 'Memories', icon: Brain },
  { href: '/dashboard/audit', label: 'Audit Log', icon: FileText },
  { href: '/dashboard/plugins', label: 'Plugins', icon: Puzzle },
  { href: '/dashboard/authorizations', label: 'Authorizations', icon: ShieldCheck },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
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
  const { user } = useAuthStore();
  const isFullPaneRoute =
    pathname.startsWith('/dashboard/chat') ||
    pathname.startsWith('/dashboard/contacts') ||
    pathname.startsWith('/dashboard/actors');
  const pageTitle = pathname.startsWith('/dashboard/actors')
    ? 'Actors'
    : navItems.find((item) => item.href === pathname)?.label || 'Dashboard';

  const handleLogout = () => {
    useAuthStore.getState().logout();
    router.push('/login');
  };

  return (
    <OnboardingGuard>
      <SidebarProvider className="h-svh overflow-hidden">
        <AppSidebar user={user} onLogout={handleLogout} />
        <SidebarInset className="min-h-0 bg-background">
          <SiteHeader title={pageTitle} />
          <div className="flex flex-1 min-h-0 flex-col">
            <div className="@container/main flex flex-1 min-h-0 flex-col">
              <div className="flex flex-1 min-h-0 flex-col gap-4 md:gap-6">
                <div
                  className={
                    isFullPaneRoute
                      ? 'flex-1 min-h-0 overflow-hidden'
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

export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const router = useRouter();
  const { user, loading, checkAuth } = useAuthStore();

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
          <div className="h-12 w-12 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          <p className="text-muted-foreground text-sm">Loading Synapse...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <WorkspaceProvider>
      <DashboardInner>{children}</DashboardInner>
    </WorkspaceProvider>
  );
}
