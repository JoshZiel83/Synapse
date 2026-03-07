'use client';

import { useEffect, useState } from 'react';
import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Kanban,
  Clock,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  PlusCircle,
  Filter,
  RefreshCw,
  User,
} from 'lucide-react';

interface WorkItem {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  assignedTo?: string;
  assignedActorName?: string;
  createdAt?: string;
  updatedAt?: string;
}

const STATUS_COLUMNS = [
  { key: 'created', label: 'Created', icon: PlusCircle, color: 'text-blue-400', bgColor: 'bg-blue-500/10', borderColor: 'border-blue-500/20' },
  { key: 'in_progress', label: 'In Progress', icon: CircleDot, color: 'text-amber-400', bgColor: 'bg-amber-500/10', borderColor: 'border-amber-500/20' },
  { key: 'review', label: 'Review', icon: Clock, color: 'text-violet-400', bgColor: 'bg-violet-500/10', borderColor: 'border-violet-500/20' },
  { key: 'completed', label: 'Completed', icon: CheckCircle2, color: 'text-emerald-400', bgColor: 'bg-emerald-500/10', borderColor: 'border-emerald-500/20' },
];

function getPriorityBadge(priority: string) {
  switch (priority?.toLowerCase()) {
    case 'critical':
    case 'urgent':
      return { className: 'bg-red-500/10 text-red-400 border-red-500/20', label: priority };
    case 'high':
      return { className: 'bg-orange-500/10 text-orange-400 border-orange-500/20', label: priority };
    case 'medium':
    case 'normal':
      return { className: 'bg-blue-500/10 text-blue-400 border-blue-500/20', label: priority };
    case 'low':
      return { className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', label: priority };
    default:
      return { className: 'bg-muted text-muted-foreground', label: priority || 'normal' };
  }
}

export default function WorkItemsPage() {
  const { workspaceId } = useWorkspace();
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    if (!workspaceId) return;
    loadWorkItems();
  }, [workspaceId]);

  async function loadWorkItems() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const data = await api.getWorkItems(workspaceId);
      const items = Array.isArray(data) ? data : (data?.items || data?.workItems || []);
      setWorkItems(items);
    } catch (err) {
      console.error('Failed to load work items:', err);
    } finally {
      setLoading(false);
    }
  }

  function getItemsByStatus(status: string) {
    let items = workItems.filter(
      (item) => item.status === status || item.status?.replace(/[_-]/g, '') === status.replace(/[_-]/g, '')
    );
    if (filter !== 'all') {
      items = items.filter((item) => item.priority?.toLowerCase() === filter);
    }
    return items;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 shadow-lg shadow-amber-500/20 flex items-center justify-center">
            <Kanban className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Work Items</h1>
            <p className="text-sm text-muted-foreground">Track and manage tasks across your organization</p>
          </div>
          <Badge variant="secondary" className="bg-amber-500/10 text-amber-400 border-amber-500/20">
            {workItems.length} items
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadWorkItems}
            className="border-border/50 hover:bg-white/5 text-muted-foreground"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Priority Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground mr-2">Priority:</span>
        {['all', 'critical', 'high', 'medium', 'low'].map((p) => (
          <Button
            key={p}
            variant={filter === p ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(p)}
            className={
              filter === p
                ? 'bg-blue-500/20 text-blue-400 border-blue-500/20 hover:bg-blue-500/30'
                : 'border-border/50 hover:bg-white/5 text-muted-foreground'
            }
          >
            {p.charAt(0).toUpperCase() + p.slice(1)}
          </Button>
        ))}
      </div>

      {/* Kanban Board */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 rounded-full border-2 border-amber-500 border-t-transparent animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {STATUS_COLUMNS.map((col) => {
            const items = getItemsByStatus(col.key);
            return (
              <div key={col.key} className="space-y-3">
                {/* Column Header */}
                <div className={`flex items-center justify-between p-3 rounded-xl ${col.bgColor} border ${col.borderColor}`}>
                  <div className="flex items-center gap-2">
                    <col.icon className={`w-4 h-4 ${col.color}`} />
                    <span className={`text-sm font-medium ${col.color}`}>{col.label}</span>
                  </div>
                  <Badge variant="outline" className={`${col.bgColor} ${col.color} border-transparent text-xs`}>
                    {items.length}
                  </Badge>
                </div>

                {/* Column Cards */}
                <div className="space-y-3 min-h-[200px]">
                  {items.length === 0 ? (
                    <div className="flex items-center justify-center py-12 text-muted-foreground/50 text-sm">
                      No items
                    </div>
                  ) : (
                    items.map((item) => {
                      const priority = getPriorityBadge(item.priority);
                      return (
                        <Card key={item.id} className="glass-card border-blue-500/5 hover:border-blue-500/15 transition-all duration-300 cursor-pointer group">
                          <CardContent className="p-4 space-y-3">
                            <div className="flex items-start justify-between gap-2">
                              <h3 className="text-sm font-medium text-foreground leading-tight group-hover:text-blue-400 transition-colors">
                                {item.title}
                              </h3>
                              <Badge variant="outline" className={`text-[10px] shrink-0 ${priority.className}`}>
                                {priority.label}
                              </Badge>
                            </div>

                            {item.description && (
                              <p className="text-xs text-muted-foreground line-clamp-2">
                                {item.description}
                              </p>
                            )}

                            <div className="flex items-center justify-between">
                              {item.assignedActorName || item.assignedTo ? (
                                <div className="flex items-center gap-1.5">
                                  <div className="w-5 h-5 rounded-full bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center">
                                    <User className="w-3 h-3 text-white" />
                                  </div>
                                  <span className="text-xs text-muted-foreground">
                                    {item.assignedActorName || 'Assigned'}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground/50">Unassigned</span>
                              )}

                              {item.updatedAt && (
                                <span className="text-[10px] text-muted-foreground/50">
                                  {new Date(item.updatedAt).toLocaleDateString()}
                                </span>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
