'use client';

import { useEffect, useState } from 'react';
import { useWorkspace } from './workspace-provider';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useRouter } from 'next/navigation';
import {
  Users,
  Network,
  Brain,
  MessageSquare,
  ArrowRight,
  Activity,
  TrendingUp,
  Zap,
} from 'lucide-react';

interface Stats {
  actors: number;
  activeWorkItems: number;
  memories: number;
}

export default function DashboardPage() {
  const { workspaceId, workspaceName, loading: wsLoading } = useWorkspace();
  const [stats, setStats] = useState<Stats>({ actors: 0, activeWorkItems: 0, memories: 0 });
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    if (!workspaceId) return;
    loadStats();
  }, [workspaceId]);

  async function loadStats() {
    setLoading(true);
    try {
      const [actors, workItems, memories] = await Promise.allSettled([
        api.getActors(workspaceId!),
        api.getWorkItems(workspaceId!, 'status=in_progress'),
        api.getMemories(workspaceId!),
      ]);

      setStats({
        actors: actors.status === 'fulfilled' ? (Array.isArray(actors.value) ? actors.value.length : 0) : 0,
        activeWorkItems: workItems.status === 'fulfilled' ? (Array.isArray(workItems.value) ? workItems.value.length : (workItems.value?.items?.length || 0)) : 0,
        memories: memories.status === 'fulfilled'
          ? (Array.isArray(memories.value) ? memories.value.length : (memories.value?.memories?.length || memories.value?.items?.length || 0))
          : 0,
      });
    } catch (err) {
      console.error('Failed to load stats:', err);
    } finally {
      setLoading(false);
    }
  }

  const statCards = [
    {
      title: 'Digital Employees',
      value: stats.actors,
      icon: Users,
      color: 'from-blue-500 to-cyan-500',
      shadow: 'shadow-blue-500/10',
      href: '/dashboard/organization',
    },
    {
      title: 'Active Work Items',
      value: stats.activeWorkItems,
      icon: Network,
      color: 'from-violet-500 to-purple-500',
      shadow: 'shadow-violet-500/10',
      href: '/dashboard/overview',
    },
    {
      title: 'Memories Stored',
      value: stats.memories,
      icon: Brain,
      color: 'from-emerald-500 to-teal-500',
      shadow: 'shadow-emerald-500/10',
      href: '/dashboard/memories',
    },
  ];

  const quickActions = [
    {
      title: 'Talk to Secretary',
      description: 'Chat with your AI secretary to delegate tasks and manage your workforce',
      icon: MessageSquare,
      color: 'from-blue-500 to-violet-500',
      href: '/dashboard/secretary',
    },
    {
      title: 'View Organization',
      description: 'Explore your digital employee hierarchy and capabilities',
      icon: Users,
      color: 'from-violet-500 to-purple-500',
      href: '/dashboard/organization',
    },
    {
      title: 'Organization Overview',
      description: 'View your digital employee hierarchy, status, and capabilities',
      icon: Network,
      color: 'from-emerald-500 to-teal-500',
      href: '/dashboard/overview',
    },
  ];

  if (wsLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold text-foreground">{workspaceName || 'Workspace'}</h1>
          <Badge variant="secondary" className="border-indigo-200 bg-indigo-50 text-indigo-600 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-400">
            <Zap className="mr-1 h-3 w-3" />
            Active
          </Badge>
        </div>
        <p className="text-muted-foreground">Your digital workforce command center overview</p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {statCards.map((stat) => (
          <Card
            key={stat.title}
            className="group cursor-pointer bg-white shadow-sm ring-1 ring-gray-200 transition-all duration-300 hover:ring-gray-300 dark:bg-gray-900 dark:ring-white/10 dark:hover:ring-white/20"
            onClick={() => router.push(stat.href)}
          >
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="mb-1 text-sm text-muted-foreground">{stat.title}</p>
                  <p className="text-4xl font-bold text-foreground">
                    {loading ? (
                      <span className="inline-block h-10 w-16 animate-pulse rounded bg-gray-200 dark:bg-muted/50" />
                    ) : (
                      stat.value
                    )}
                  </p>
                </div>
                <div className={`flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br ${stat.color} ${stat.shadow} shadow-lg transition-transform duration-300 group-hover:scale-110`}>
                  <stat.icon className="h-7 w-7 text-white" />
                </div>
              </div>
              <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <TrendingUp className="h-3 w-3 text-emerald-400" />
                <span>Click to view details</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div>
        <h2 className="mb-4 text-xl font-semibold text-foreground">Quick Actions</h2>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {quickActions.map((action) => (
            <Card
              key={action.title}
              className="group relative cursor-pointer overflow-hidden bg-white shadow-sm ring-1 ring-gray-200 transition-all duration-300 dark:bg-gray-900 dark:ring-white/10"
              onClick={() => router.push(action.href)}
            >
              <div className={`absolute inset-0 bg-gradient-to-br ${action.color} opacity-0 transition-opacity duration-300 group-hover:opacity-5`} />
              <CardHeader className="pb-2">
                <div className={`mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br ${action.color} shadow-lg transition-transform duration-300 group-hover:scale-110`}>
                  <action.icon className="h-6 w-6 text-white" />
                </div>
                <CardTitle className="text-lg text-foreground transition-colors group-hover:text-indigo-600 dark:group-hover:text-indigo-400">
                  {action.title}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription className="mb-4 text-muted-foreground">{action.description}</CardDescription>
                <div className="flex items-center gap-2 text-sm text-indigo-600 opacity-0 transition-opacity duration-300 group-hover:opacity-100 dark:text-indigo-400">
                  <span>Go to {action.title.toLowerCase()}</span>
                  <ArrowRight className="h-4 w-4" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <Card className="bg-white shadow-sm ring-1 ring-gray-200 dark:bg-gray-900 dark:ring-white/10">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg text-foreground">
            <Activity className="h-5 w-5 text-blue-400" />
            System Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex items-center gap-3 rounded-xl bg-gray-50 p-3 dark:bg-background/30">
              <div className="pulse-glow h-3 w-3 rounded-full bg-emerald-400" />
              <div>
                <p className="text-sm font-medium text-foreground">API Server</p>
                <p className="text-xs text-muted-foreground">Connected</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl bg-gray-50 p-3 dark:bg-background/30">
              <div className="pulse-glow h-3 w-3 rounded-full bg-emerald-400" />
              <div>
                <p className="text-sm font-medium text-foreground">WebSocket</p>
                <p className="text-xs text-muted-foreground">Real-time active</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl bg-gray-50 p-3 dark:bg-background/30">
              <div className="pulse-glow h-3 w-3 rounded-full bg-emerald-400" />
              <div>
                <p className="text-sm font-medium text-foreground">AI Engine</p>
                <p className="text-xs text-muted-foreground">Operational</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
