'use client';

import { useEffect, useState } from 'react';
import { useWorkspace } from './workspace-provider';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useRouter } from 'next/navigation';
import {
  Users,
  Kanban,
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
        memories: memories.status === 'fulfilled' ? (Array.isArray(memories.value) ? memories.value.length : (memories.value?.items?.length || 0)) : 0,
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
      icon: Kanban,
      color: 'from-violet-500 to-purple-500',
      shadow: 'shadow-violet-500/10',
      href: '/dashboard/work-items',
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
      title: 'Monitor Work',
      description: 'Track progress on active tasks and work items across your organization',
      icon: Activity,
      color: 'from-emerald-500 to-teal-500',
      href: '/dashboard/work-items',
    },
  ];

  if (wsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-8 w-8 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold text-foreground">
            {workspaceName || 'Workspace'}
          </h1>
          <Badge variant="secondary" className="bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-400 dark:border-indigo-500/20">
            <Zap className="w-3 h-3 mr-1" />
            Active
          </Badge>
        </div>
        <p className="text-muted-foreground">
          Your digital workforce command center overview
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {statCards.map((stat) => (
          <Card
            key={stat.title}
            className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 hover:ring-gray-300 dark:hover:ring-white/20 shadow-sm transition-all duration-300 cursor-pointer group"
            onClick={() => router.push(stat.href)}
          >
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground mb-1">{stat.title}</p>
                  <p className="text-4xl font-bold text-foreground">
                    {loading ? (
                      <span className="inline-block h-10 w-16 bg-gray-200 dark:bg-muted/50 rounded animate-pulse" />
                    ) : (
                      stat.value
                    )}
                  </p>
                </div>
                <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${stat.color} ${stat.shadow} shadow-lg flex items-center justify-center group-hover:scale-110 transition-transform duration-300`}>
                  <stat.icon className="w-7 h-7 text-white" />
                </div>
              </div>
              <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <TrendingUp className="w-3 h-3 text-emerald-400" />
                <span>Click to view details</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {quickActions.map((action) => (
            <Card
              key={action.title}
              className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 shadow-sm transition-all duration-300 cursor-pointer group overflow-hidden relative"
              onClick={() => router.push(action.href)}
            >
              {/* Gradient overlay */}
              <div className={`absolute inset-0 bg-gradient-to-br ${action.color} opacity-0 group-hover:opacity-5 transition-opacity duration-300`} />

              <CardHeader className="pb-2">
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${action.color} shadow-lg flex items-center justify-center mb-3 group-hover:scale-110 transition-transform duration-300`}>
                  <action.icon className="w-6 h-6 text-white" />
                </div>
                <CardTitle className="text-lg text-foreground group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                  {action.title}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription className="text-muted-foreground mb-4">
                  {action.description}
                </CardDescription>
                <div className="flex items-center gap-2 text-sm text-indigo-600 dark:text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                  <span>Go to {action.title.toLowerCase()}</span>
                  <ArrowRight className="w-4 h-4" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* System Status */}
      <Card className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-foreground flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-400" />
            System Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 dark:bg-background/30">
              <div className="w-3 h-3 rounded-full bg-emerald-400 pulse-glow" />
              <div>
                <p className="text-sm font-medium text-foreground">API Server</p>
                <p className="text-xs text-muted-foreground">Connected</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 dark:bg-background/30">
              <div className="w-3 h-3 rounded-full bg-emerald-400 pulse-glow" />
              <div>
                <p className="text-sm font-medium text-foreground">WebSocket</p>
                <p className="text-xs text-muted-foreground">Real-time active</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 dark:bg-background/30">
              <div className="w-3 h-3 rounded-full bg-emerald-400 pulse-glow" />
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
