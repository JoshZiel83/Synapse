'use client';

import { useEffect, useState } from 'react';
import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  FileText,
  RefreshCw,
  Filter,
  ChevronLeft,
  ChevronRight,
  Clock,
  User,
  Bot,
  Activity,
  Globe,
  Hash,
  X,
  ChevronDown,
} from 'lucide-react';

interface AuditLog {
  id: string;
  action: string;
  userId?: string;
  userName?: string;
  actorId?: string;
  actorName?: string;
  resourceType?: string;
  resourceId?: string;
  details?: any;
  ipAddress?: string;
  createdAt?: string;
}

function getActionBadge(action: string) {
  const actionLower = action?.toLowerCase() || '';
  if (actionLower.includes('create') || actionLower.includes('add')) {
    return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
  }
  if (actionLower.includes('update') || actionLower.includes('edit') || actionLower.includes('modify')) {
    return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
  }
  if (actionLower.includes('delete') || actionLower.includes('remove')) {
    return 'bg-red-500/10 text-red-400 border-red-500/20';
  }
  if (actionLower.includes('login') || actionLower.includes('auth')) {
    return 'bg-violet-500/10 text-violet-400 border-violet-500/20';
  }
  if (actionLower.includes('think')) {
    return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
  }
  if (actionLower.includes('message') || actionLower.includes('chat')) {
    return 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20';
  }
  return 'bg-muted text-muted-foreground';
}

function formatTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatFullTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

export default function AuditPage() {
  const { workspaceId } = useWorkspace();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [actionFilter, setActionFilter] = useState('all');
  const [selected, setSelected] = useState<AuditLog | null>(null);
  const pageSize = 20;

  useEffect(() => {
    if (!workspaceId) return;
    loadLogs();
  }, [workspaceId, page]);

  async function loadLogs() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const params = `page=${page}&pageSize=${pageSize}${actionFilter !== 'all' ? `&action=${actionFilter}` : ''}`;
      const data = await api.getAuditLogs(workspaceId, params);
      const items = Array.isArray(data) ? data : (data?.items || data?.data || []);
      setLogs(items);
      if (data?.total) {
        setTotalPages(Math.ceil(data.total / pageSize));
      } else if (data?.totalPages) {
        setTotalPages(data.totalPages);
      }
    } catch (err) {
      console.error('Failed to load audit logs:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleFilterChange(action: string) {
    setActionFilter(action);
    setPage(1);
    setTimeout(() => loadLogs(), 0);
  }

  const actionTypes = ['all', 'create', 'update', 'delete', 'login', 'think'];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 shadow-lg shadow-cyan-500/20 flex items-center justify-center">
            <FileText className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Audit Log</h1>
            <p className="text-sm text-muted-foreground">Track all actions and changes in your workspace</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={loadLogs}
          className="border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-white/5 text-muted-foreground"
        >
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Action Type Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground mr-2">Action:</span>
        {actionTypes.map((action) => (
          <Button
            key={action}
            variant={actionFilter === action ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleFilterChange(action)}
            className={
              actionFilter === action
                ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/20 hover:bg-cyan-500/30'
                : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-white/5 text-muted-foreground'
            }
          >
            {action.charAt(0).toUpperCase() + action.slice(1)}
          </Button>
        ))}
      </div>

      {/* Audit Log Table */}
      <Card className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-8 w-8 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin" />
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-cyan-500/10 to-blue-500/10 flex items-center justify-center mb-4">
              <Activity className="w-10 h-10 text-muted-foreground/50" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">No Audit Logs</h3>
            <p className="text-sm text-muted-foreground">Activity logs will appear here as actions are performed.</p>
          </div>
        ) : (
          <>
            {/* Table Header */}
            <div className="hidden md:grid grid-cols-12 gap-4 px-6 py-3 border-b border-border/30 bg-gray-50 dark:bg-background/30">
              <div className="col-span-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Timestamp</div>
              <div className="col-span-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Action</div>
              <div className="col-span-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Actor / User</div>
              <div className="col-span-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Resource</div>
            </div>

            {/* Table Rows */}
            <div className="divide-y divide-border/20">
              {logs.map((log) => (
                <div
                  key={log.id}
                  onClick={() => setSelected(log)}
                  className="grid grid-cols-1 md:grid-cols-12 gap-2 md:gap-4 px-6 py-4 hover:bg-white/[0.03] transition-colors cursor-pointer group"
                >
                  {/* Timestamp */}
                  <div className="col-span-3 flex items-center gap-2">
                    <Clock className="w-3.5 h-3.5 text-muted-foreground/50 hidden md:block shrink-0" />
                    <span className="text-xs text-muted-foreground">
                      {log.createdAt ? formatTime(log.createdAt) : '-'}
                    </span>
                  </div>

                  {/* Action */}
                  <div className="col-span-3 flex items-center">
                    <Badge variant="outline" className={`text-xs ${getActionBadge(log.action)}`}>
                      {log.action}
                    </Badge>
                  </div>

                  {/* Actor/User */}
                  <div className="col-span-3 flex items-center gap-2">
                    {log.actorName ? (
                      <>
                        <Bot className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                        <span className="text-sm text-foreground truncate">{log.actorName}</span>
                      </>
                    ) : log.userName ? (
                      <>
                        <User className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                        <span className="text-sm text-foreground truncate">{log.userName}</span>
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground">System</span>
                    )}
                  </div>

                  {/* Resource */}
                  <div className="col-span-3 flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      {log.resourceType ? (
                        <span>
                          <span className="text-foreground">{log.resourceType}</span>
                          {log.resourceId && (
                            <span className="text-muted-foreground/50 ml-1 text-xs">
                              #{log.resourceId.slice(0, 8)}
                            </span>
                          )}
                        </span>
                      ) : (
                        '-'
                      )}
                    </span>
                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/30 -rotate-90 opacity-0 group-hover:opacity-100 transition-opacity hidden md:block" />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-white/5 text-muted-foreground"
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(Math.min(totalPages, page + 1))}
            disabled={page === totalPages}
            className="border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-white/5 text-muted-foreground"
          >
            Next
            <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      )}

      {/* Detail Dialog */}
      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="sm:max-w-lg border-gray-200 dark:border-white/10 bg-white dark:bg-gray-900">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              <span>Audit Detail</span>
              {selected && (
                <Badge variant="outline" className={`text-xs ${getActionBadge(selected.action)}`}>
                  {selected.action}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="sr-only">Audit log entry details</DialogDescription>
          </DialogHeader>

          {selected && (
            <div className="space-y-4 pt-2">
              {/* Time */}
              <DetailRow label="Timestamp">
                <div className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-muted-foreground/60" />
                  {selected.createdAt ? formatFullTime(selected.createdAt) : '-'}
                </div>
              </DetailRow>

              {/* Actor / User */}
              <DetailRow label="Operator">
                {selected.actorName ? (
                  <div className="flex items-center gap-2">
                    <Bot className="w-4 h-4 text-violet-400" />
                    <span>{selected.actorName}</span>
                    {selected.actorId && (
                      <span className="text-xs text-muted-foreground/50 font-mono">{selected.actorId.slice(0, 8)}</span>
                    )}
                  </div>
                ) : selected.userName ? (
                  <div className="flex items-center gap-2">
                    <User className="w-4 h-4 text-blue-400" />
                    <span>{selected.userName}</span>
                    {selected.userId && (
                      <span className="text-xs text-muted-foreground/50 font-mono">{selected.userId.slice(0, 8)}</span>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground">System</span>
                )}
              </DetailRow>

              {/* Resource */}
              {selected.resourceType && (
                <DetailRow label="Resource">
                  <div className="flex items-center gap-2">
                    <Hash className="w-3.5 h-3.5 text-muted-foreground/60" />
                    <span className="font-medium">{selected.resourceType}</span>
                    {selected.resourceId && (
                      <span className="text-xs font-mono text-muted-foreground bg-muted/30 px-1.5 py-0.5 rounded">
                        {selected.resourceId}
                      </span>
                    )}
                  </div>
                </DetailRow>
              )}

              {/* IP */}
              {selected.ipAddress && (
                <DetailRow label="IP Address">
                  <div className="flex items-center gap-2">
                    <Globe className="w-3.5 h-3.5 text-muted-foreground/60" />
                    <span className="font-mono text-xs">{selected.ipAddress}</span>
                  </div>
                </DetailRow>
              )}

              {/* ID */}
              <DetailRow label="Log ID">
                <span className="font-mono text-xs text-muted-foreground">{selected.id}</span>
              </DetailRow>

              {/* Details JSON */}
              {selected.details && (
                <DetailRow label="Details">
                  <pre className="text-xs font-mono bg-muted/20 border border-border/30 rounded-lg p-3 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">
                    {typeof selected.details === 'string'
                      ? selected.details
                      : JSON.stringify(selected.details, null, 2)}
                  </pre>
                </DetailRow>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
