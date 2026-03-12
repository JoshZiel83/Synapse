'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/stores/auth-store';
import { WorkspaceProvider, useWorkspace } from './workspace-provider';
import { AppSidebar } from '@/components/app-sidebar';
import { SiteHeader } from '@/components/site-header';
import {
  LayoutDashboard,
  MessageSquare,
  Users,
  Network,
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
  { href: '/dashboard/organization', label: 'Organization', icon: Users },
  { href: '/dashboard/overview', label: 'Overview', icon: Network },
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
          <div className="h-12 w-12 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
          <p className="text-gray-500 dark:text-gray-400 text-sm">Loading workspace...</p>
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

  const handleLogout = () => {
    useAuthStore.getState().logout();
    router.push('/login');
  };

  return (
    <OnboardingGuard>
      <SidebarProvider className="min-h-svh bg-gray-50 dark:bg-gray-900">
        <AppSidebar user={user} onLogout={handleLogout} />
        <SidebarInset className="min-h-svh bg-background">
          <SiteHeader title={navItems.find((item) => item.href === pathname)?.label || 'Dashboard'} />
          <div className="flex flex-1 flex-col">
            <div className="@container/main flex flex-1 flex-col gap-2">
              <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
                <div className="px-4 lg:px-6">
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
          <div className="h-12 w-12 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
          <p className="text-gray-500 dark:text-gray-400 text-sm">Loading Synapse...</p>
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
