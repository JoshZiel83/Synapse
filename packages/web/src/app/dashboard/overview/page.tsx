'use client';

import { useEffect, useState } from 'react';
import { useWorkspace } from '../workspace-provider';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import {
  BrainCircuit,
  Layers,
  Terminal,
  ShieldCheck,
  Archive,
  Users,
  Bot,
  User,
  Activity,
  BookOpen,
  Lock,
  Cpu,
  X,
  RefreshCw,
  MessageSquare,
  Network,
  Puzzle,
  Plus,
  Globe,
  Code,
  Wrench,
  Settings,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import PluginConfigDialog from '../plugins/plugin-config-dialog';

// ─── Types ───

interface TreeNode {
  id: string;
  name: string;
  role: string;
  title: string;
  charter: string;
  capabilities: string[];
  config: Record<string, unknown>;
  isActive: boolean;
  parentId?: string;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
  children: TreeNode[];
}

// ─── Helpers ───

function buildTree(flatActors: any[]): TreeNode[] {
  const nodeMap = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  for (const actor of flatActors) {
    nodeMap.set(actor.id, {
      id: actor.id,
      name: actor.name,
      role: actor.role,
      title: actor.title || '',
      charter: actor.charter || '',
      capabilities: actor.capabilities || [],
      config: actor.config || {},
      isActive: actor.isActive ?? true,
      parentId: actor.parentId,
      systemPrompt: actor.systemPrompt || '',
      createdAt: actor.createdAt || '',
      updatedAt: actor.updatedAt || '',
      children: [],
    });
  }

  for (const actor of flatActors) {
    const node = nodeMap.get(actor.id)!;
    if (actor.parentId && nodeMap.has(actor.parentId)) {
      nodeMap.get(actor.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

function getRoleIcon(role: string) {
  switch (role) {
    case 'secretary': return BrainCircuit;
    case 'manager': return Layers;
    case 'specialist': return Terminal;
    case 'reviewer': return ShieldCheck;
    case 'archivist': return Archive;
    case 'receptionist': return Users;
    case 'assistant': return Bot;
    default: return User;
  }
}

function getRoleGradient(role: string) {
  switch (role) {
    case 'secretary': return 'from-blue-500 to-cyan-500';
    case 'manager': return 'from-violet-500 to-purple-500';
    case 'specialist': return 'from-emerald-500 to-teal-500';
    case 'reviewer': return 'from-amber-500 to-orange-500';
    case 'archivist': return 'from-pink-500 to-rose-500';
    case 'receptionist': return 'from-sky-500 to-blue-500';
    case 'assistant': return 'from-indigo-500 to-blue-500';
    default: return 'from-gray-500 to-gray-600';
  }
}

function getRoleLabel(role: string) {
  switch (role) {
    case 'secretary': return '秘书';
    case 'manager': return '主管';
    case 'specialist': return '专员';
    case 'reviewer': return '审查员';
    case 'archivist': return '档案官';
    case 'receptionist': return '接待员';
    case 'assistant': return '助理';
    default: return role;
  }
}

function countDescendants(node: TreeNode): number {
  let count = 0;
  for (const child of node.children) {
    count += 1 + countDescendants(child);
  }
  return count;
}

// ─── Tree Node Card ───

function TreeNodeCard({
  node,
  selectedId,
  onSelect,
}: {
  node: TreeNode;
  selectedId: string | null;
  onSelect: (node: TreeNode) => void;
}) {
  const isSelected = selectedId === node.id;
  const Icon = getRoleIcon(node.role);
  const gradient = getRoleGradient(node.role);

  return (
    <li className="relative p-3 md:p-5 text-center">
      <div className="flex justify-center">
        <div
          onClick={() => onSelect(node)}
          className={`
            relative z-10 w-44 rounded-xl border p-4 cursor-pointer transition-all duration-300
            hover:-translate-y-1 hover:shadow-lg
            bg-white dark:bg-gray-900
            ${isSelected
              ? 'ring-2 ring-indigo-600 dark:ring-indigo-400 ring-offset-2 ring-offset-gray-50 dark:ring-offset-gray-950 border-indigo-300 dark:border-indigo-500/50'
              : node.isActive
                ? 'border-gray-200 dark:border-white/10 hover:border-indigo-200 dark:hover:border-indigo-500/30'
                : 'border-gray-200 dark:border-white/10 opacity-60'
            }
          `}
        >
          {/* Status indicator */}
          <div className="absolute top-2.5 right-2.5 flex items-center gap-1">
            <span className="text-[10px] text-gray-400 dark:text-gray-500">
              {node.isActive ? '在线' : '离线'}
            </span>
            <span className={`w-2 h-2 rounded-full ${
              node.isActive ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50' : 'bg-gray-300 dark:bg-gray-600'
            }`} />
          </div>

          <div className="flex flex-col items-center gap-2 mt-2">
            <div className={`p-3 rounded-full bg-gradient-to-br ${gradient} shadow-lg`}>
              <Icon size={22} className="text-white stroke-[1.5]" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-gray-900 dark:text-white">{node.name}</h3>
              <p className="text-[11px] mt-1 font-medium text-gray-500 dark:text-gray-400">
                {node.title || getRoleLabel(node.role)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Children */}
      {node.children.length > 0 && (
        <ul className="flex justify-center pt-6 md:pt-8 relative">
          {node.children.map(child => (
            <TreeNodeCard
              key={child.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ─── Detail Panel ───

function DetailPanel({ node, onClose, workspaceId }: { node: TreeNode; onClose: () => void; workspaceId: string }) {
  const Icon = getRoleIcon(node.role);
  const gradient = getRoleGradient(node.role);
  const router = useRouter();
  const [plugins, setPlugins] = useState<any[]>([]);
  const [loadingPlugins, setLoadingPlugins] = useState(false);
  const [detailPlugin, setDetailPlugin] = useState<any>(null);
  const [configPlugin, setConfigPlugin] = useState<any>(null);

  function loadPlugins() {
    if (!workspaceId || !node.id) return;
    setLoadingPlugins(true);
    Promise.all([
      api.getInstallations(workspaceId, `scopeType=actor&scopeId=${node.id}`).catch(() => []),
      api.getInstallations(workspaceId, `scopeType=workspace&scopeId=${workspaceId}`).catch(() => []),
    ]).then(([actorPlugins, wsPlugins]) => {
      const actorList = Array.isArray(actorPlugins) ? actorPlugins : (actorPlugins?.installations || []);
      const wsList = Array.isArray(wsPlugins) ? wsPlugins : (wsPlugins?.installations || []);
      const seen = new Set<string>();
      const combined: any[] = [];
      for (const p of actorList) {
        seen.add(p.plugin_id);
        combined.push({ ...p, _scope: 'actor' });
      }
      for (const p of wsList) {
        if (!seen.has(p.plugin_id)) {
          combined.push({ ...p, _scope: 'workspace' });
        }
      }
      setPlugins(combined);
    }).finally(() => setLoadingPlugins(false));
  }

  useEffect(() => { loadPlugins(); }, [workspaceId, node.id]);

  return (
    <aside className="w-96 border-l border-gray-200 dark:border-white/10 bg-white dark:bg-gray-900 flex flex-col shrink-0 animate-in slide-in-from-right-4 duration-200">
      {/* Header */}
      <div className="p-6 border-b border-gray-200 dark:border-white/10 relative">
        <button
          onClick={onClose}
          className="absolute top-6 right-6 p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:text-gray-500 dark:hover:text-white dark:hover:bg-white/10 transition-colors"
        >
          <X size={18} />
        </button>
        <div className="flex items-center gap-4">
          <div className={`p-4 rounded-xl bg-gradient-to-br ${gradient} shadow-lg`}>
            <Icon size={28} className="text-white" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">{node.name}</h2>
            <p className="text-gray-500 dark:text-gray-400 text-sm">{node.title || getRoleLabel(node.role)}</p>
          </div>
        </div>

        {/* Tags */}
        <div className="flex gap-2 mt-4 flex-wrap">
          <span className="px-2 py-1 bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded text-xs text-gray-600 dark:text-gray-300 font-mono">
            {node.role.toUpperCase()}
          </span>
          <span className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${
            node.isActive
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-700 dark:bg-emerald-500/10 dark:border-emerald-500/30 dark:text-emerald-400'
              : 'bg-gray-100 border border-gray-200 text-gray-500 dark:bg-white/5 dark:border-white/10 dark:text-gray-400'
          }`}>
            <Activity size={12} />
            {node.isActive ? '在线' : '离线'}
          </span>
        </div>

        {/* Quick actions */}
        <div className="flex gap-2 mt-4">
          <button
            onClick={() => router.push(`/dashboard/chat?actor=${node.id}`)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-400 dark:hover:bg-indigo-500/20 text-xs font-medium transition-colors"
          >
            <MessageSquare size={14} />
            发起对话
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-6 overflow-y-auto flex-1 space-y-6">
        {/* Charter */}
        {node.charter && (
          <section>
            <h3 className="flex items-center text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
              <BookOpen size={14} className="mr-2" /> 岗位章程 (Charter)
            </h3>
            <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-4 border border-gray-200 dark:border-white/10 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
              {node.charter}
            </div>
          </section>
        )}

        {/* Capabilities */}
        {node.capabilities.length > 0 && (
          <section>
            <h3 className="flex items-center text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
              <Terminal size={14} className="mr-2" /> 授权能力 (Capabilities)
            </h3>
            <div className="flex flex-wrap gap-2">
              {node.capabilities.map((cap, idx) => (
                <span key={idx} className="px-3 py-1.5 bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-md text-xs text-gray-600 dark:text-gray-300 flex items-center">
                  <Lock size={10} className="mr-1.5 opacity-50" />
                  {cap}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Plugins */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="flex items-center text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              <Puzzle size={14} className="mr-2" /> 可用插件 (Plugins)
            </h3>
            <button
              onClick={() => router.push(`/dashboard/plugins?actorId=${node.id}`)}
              className="flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300 font-medium transition-colors"
            >
              <Plus size={12} />
              添加插件
            </button>
          </div>
          {loadingPlugins ? (
            <div className="flex items-center justify-center py-4">
              <div className="h-5 w-5 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
            </div>
          ) : plugins.length === 0 ? (
            <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-4 border border-gray-200 dark:border-white/10 text-center">
              <p className="text-xs text-gray-400 dark:text-gray-500">暂无已安装插件</p>
              <button
                onClick={() => router.push(`/dashboard/plugins?actorId=${node.id}`)}
                className="mt-2 text-xs text-indigo-600 dark:text-indigo-400 hover:underline font-medium"
              >
                前往插件市场安装
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {plugins.map((p: any) => (
                <button
                  key={p.id}
                  onClick={() => setDetailPlugin(p)}
                  className="w-full flex items-center gap-3 p-3 bg-gray-50 dark:bg-white/5 rounded-lg border border-gray-200 dark:border-white/10 hover:border-indigo-200 dark:hover:border-indigo-500/30 transition-colors text-left group"
                >
                  <div className="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center shrink-0">
                    {p.transport === 'http' ? <Globe size={16} className="text-indigo-600 dark:text-indigo-400" /> :
                     p.transport === 'builtin' ? <Code size={16} className="text-indigo-600 dark:text-indigo-400" /> :
                     <Puzzle size={16} className="text-indigo-600 dark:text-indigo-400" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                      {p.plugin_display_name || p.display_name || p.plugin_slug || p.plugin_id}
                    </p>
                    <p className="text-[11px] text-gray-400 dark:text-gray-500">
                      {p.org_display_name}{p.plugin_version ? ` · v${p.plugin_version}` : ''}
                      {p._scope === 'workspace' ? ' · 工作区' : ' · 专属'}
                    </p>
                  </div>
                  <div className={`w-2 h-2 rounded-full shrink-0 ${p.is_enabled !== false ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
                </button>
              ))}
            </div>
          )}
        </section>

        {/* System Prompt */}
        {node.systemPrompt && (
          <section>
            <h3 className="flex items-center text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
              <Cpu size={14} className="mr-2" /> 系统指令 (System Prompt)
            </h3>
            <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-4 border border-gray-200 dark:border-white/10 text-xs text-gray-600 dark:text-gray-400 font-mono leading-relaxed max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
              {node.systemPrompt.length > 300 ? node.systemPrompt.substring(0, 300) + '...' : node.systemPrompt}
            </div>
          </section>
        )}

        {/* Metadata */}
        <section>
          <h3 className="flex items-center text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
            <Activity size={14} className="mr-2" /> 基本信息
          </h3>
          <div className="space-y-0 text-sm">
            <div className="flex justify-between py-2.5 border-b border-gray-100 dark:border-white/5">
              <span className="text-gray-500 dark:text-gray-400">角色类型</span>
              <span className="text-gray-900 dark:text-white font-medium">{getRoleLabel(node.role)}</span>
            </div>
            {node.children.length > 0 && (
              <div className="flex justify-between py-2.5 border-b border-gray-100 dark:border-white/5">
                <span className="text-gray-500 dark:text-gray-400">直属下级</span>
                <span className="text-gray-900 dark:text-white font-medium">{node.children.length} 名</span>
              </div>
            )}
            {countDescendants(node) > node.children.length && (
              <div className="flex justify-between py-2.5 border-b border-gray-100 dark:border-white/5">
                <span className="text-gray-500 dark:text-gray-400">团队总人数</span>
                <span className="text-gray-900 dark:text-white font-medium">{countDescendants(node)} 名</span>
              </div>
            )}
            <div className="flex justify-between py-2.5 border-b border-gray-100 dark:border-white/5">
              <span className="text-gray-500 dark:text-gray-400">创建时间</span>
              <span className="text-gray-900 dark:text-white font-medium">
                {new Date(node.createdAt).toLocaleDateString('zh-CN')}
              </span>
            </div>
            <div className="flex justify-between py-2.5">
              <span className="text-gray-500 dark:text-gray-400">最后更新</span>
              <span className="text-gray-900 dark:text-white font-medium">
                {new Date(node.updatedAt).toLocaleDateString('zh-CN')}
              </span>
            </div>
          </div>
        </section>
      </div>

      {/* Plugin Detail Dialog */}
      {detailPlugin && (
        <Dialog open onOpenChange={() => setDetailPlugin(null)}>
          <DialogContent className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10 max-w-lg max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-lg bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center">
                  {detailPlugin.transport === 'http' ? <Globe className="w-6 h-6 text-indigo-600 dark:text-indigo-400" /> :
                   detailPlugin.transport === 'builtin' ? <Code className="w-6 h-6 text-indigo-600 dark:text-indigo-400" /> :
                   <Puzzle className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />}
                </div>
                <div>
                  <DialogTitle>{detailPlugin.plugin_display_name}</DialogTitle>
                  <p className="text-sm text-muted-foreground">
                    {detailPlugin.org_display_name}
                    {detailPlugin.plugin_version ? ` · v${detailPlugin.plugin_version}` : ''}
                  </p>
                </div>
              </div>
            </DialogHeader>

            <div className="space-y-4 mt-2">
              <p className="text-sm text-muted-foreground">{detailPlugin.plugin_description}</p>

              <div className="flex gap-2 flex-wrap">
                <Badge variant="outline" className="border-gray-200 dark:border-white/10">
                  {detailPlugin.transport === 'http' ? 'Remote MCP (HTTP)' :
                   detailPlugin.transport === 'builtin' ? 'Built-in' : detailPlugin.transport}
                </Badge>
                <Badge variant="outline" className={`text-xs ${
                  detailPlugin._scope === 'actor'
                    ? 'border-green-500/30 text-green-600 dark:text-green-400'
                    : 'border-blue-500/30 text-blue-600 dark:text-blue-400'
                }`}>
                  {detailPlugin._scope === 'workspace' ? '工作区级别' : '专属配置'}
                </Badge>
                <Badge variant="outline" className="border-gray-200 dark:border-white/10 text-muted-foreground">
                  Lifecycle: {detailPlugin.lifecycle_scope}
                </Badge>
                {detailPlugin.is_enabled === false && (
                  <Badge variant="outline" className="border-amber-500/30 text-amber-600 dark:text-amber-400">已禁用</Badge>
                )}
              </div>

              {/* Tools */}
              {(detailPlugin.tools_manifest || []).length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2 text-foreground">
                    <Wrench className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                    Tools ({detailPlugin.tools_manifest.length})
                  </h4>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {detailPlugin.tools_manifest.map((tool: any) => (
                      <div key={tool.name} className="p-2 rounded bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10">
                        <p className="text-sm font-mono font-medium text-indigo-600 dark:text-indigo-400">{tool.name}</p>
                        {tool.description && <p className="text-xs text-muted-foreground mt-1">{tool.description}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button
                  className="flex-1"
                  onClick={() => { setDetailPlugin(null); setConfigPlugin(detailPlugin); }}
                >
                  <Settings className="w-4 h-4 mr-2" />
                  去配置
                </Button>
                <Button variant="outline" onClick={() => setDetailPlugin(null)}>关闭</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Plugin Config Dialog */}
      {configPlugin && (
        <PluginConfigDialog
          installation={configPlugin}
          onClose={() => { setConfigPlugin(null); loadPlugins(); }}
        />
      )}
    </aside>
  );
}

// ─── Main Page ───

export default function OverviewPage() {
  const { workspaceId } = useWorkspace();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId) return;
    loadTree();
  }, [workspaceId]);

  async function loadTree() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      let data;
      try {
        data = await api.getOrgTree(workspaceId);
      } catch {
        data = await api.getActors(workspaceId);
      }
      const flat = Array.isArray(data) ? data : (data?.actors || data?.tree || []);
      const built = buildTree(flat);
      setTree(built);
    } catch (err) {
      console.error('Failed to load org tree:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleSelect(node: TreeNode) {
    setSelectedId(prev => prev === node.id ? null : node.id);
  }

  const selectedNode = selectedId ? findNode(tree, selectedId) : null;

  return (
    <div className="flex-1 -m-4 lg:-m-8 flex overflow-hidden min-h-0">
      {/* Left: Header + Chart */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Top bar */}
        <div className="shrink-0 flex items-center justify-between px-4 lg:px-8 py-4 border-b border-gray-200 dark:border-white/10 bg-white dark:bg-gray-900">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 shadow-lg shadow-indigo-500/20 flex items-center justify-center">
              <Network className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-900 dark:text-white">组织概览</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">团队成员结构与状态监控</p>
            </div>
          </div>
          <button
            onClick={loadTree}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-white/10 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 text-sm transition-colors"
          >
            <RefreshCw size={14} />
            刷新
          </button>
        </div>

        {/* Org chart area */}
        <div className="flex-1 overflow-auto bg-gray-50/50 dark:bg-gray-950/50 org-chart">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <div className="h-10 w-10 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
            </div>
          ) : tree.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-20 h-20 rounded-3xl bg-gray-100 dark:bg-white/5 flex items-center justify-center mb-4">
                <Users className="w-10 h-10 text-gray-400 dark:text-gray-500" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">暂无团队成员</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">前往组织管理页面添加数字员工</p>
            </div>
          ) : (
            <div className="flex justify-center items-start p-6 lg:p-8 min-w-fit">
              <ul className="m-0 p-0">
                {tree.map(node => (
                  <TreeNodeCard
                    key={node.id}
                    node={node}
                    selectedId={selectedId}
                    onSelect={handleSelect}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Right: Detail Panel */}
      {selectedNode && (
        <DetailPanel node={selectedNode} onClose={() => setSelectedId(null)} workspaceId={workspaceId!} />
      )}
    </div>
  );
}
