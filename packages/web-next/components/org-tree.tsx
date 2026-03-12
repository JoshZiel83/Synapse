'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronDown, ChevronRight, Plus, User, Bot, Crown, Users, MessageSquare } from 'lucide-react';
import Link from 'next/link';

interface Actor {
  id: string;
  name: string;
  role: string;
  title?: string;
  type?: string;
  capabilities?: string[];
  status?: string;
  children?: Actor[];
}
interface OrgTreeNodeProps {
  actor: Actor;
  depth?: number;
  onAddChild?: (parentId: string) => void;
}

function getRoleColor(role: string) {
  switch (role?.toLowerCase()) {
    case 'ceo':
    case 'director':
      return 'from-amber-500 to-orange-500';
    case 'manager':
      return 'from-violet-500 to-purple-500';
    case 'secretary':
      return 'from-blue-500 to-cyan-500';
    case 'engineer':
    case 'developer':
      return 'from-emerald-500 to-teal-500';
    case 'analyst':
      return 'from-pink-500 to-rose-500';
    default:
      return 'from-blue-500 to-violet-500';
  }
}

function getRoleBadgeClass(role: string) {
  switch (role?.toLowerCase()) {
    case 'ceo':
    case 'director':
      return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    case 'manager':
      return 'bg-violet-500/10 text-violet-400 border-violet-500/20';
    case 'secretary':
      return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
    case 'engineer':
    case 'developer':
      return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
    default:
      return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
  }
}

function OrgTreeNode({ actor, depth = 0, onAddChild }: OrgTreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = actor.children && actor.children.length > 0;
  const roleColor = getRoleColor(actor.role);

  return (
    <div className="relative">
      {/* Connector lines */}
      {depth > 0 && (
        <div className="absolute left-0 top-0 w-6 h-6 border-l-2 border-b-2 border-blue-500/15 rounded-bl-xl -translate-x-4" />
      )}

      <Card className="bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-white/10 border-gray-200 dark:border-white/10 hover:border-blue-500/15 transition-all duration-300 group mb-3">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            {/* Avatar */}
            <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${roleColor} shadow-lg flex items-center justify-center shrink-0`}>
              {actor.role?.toLowerCase() === 'ceo' || actor.role?.toLowerCase() === 'director'
                ? <Crown className="w-5 h-5 text-white" />
                : actor.type === 'ai'
                  ? <Bot className="w-5 h-5 text-white" />
                  : <User className="w-5 h-5 text-white" />
              }
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold text-foreground">{actor.name}</h3>
                <Badge variant="outline" className={`text-xs ${getRoleBadgeClass(actor.role)}`}>
                  {actor.role}
                </Badge>
                {actor.status && (
                  <div className="flex items-center gap-1">
                    <div className={`w-1.5 h-1.5 rounded-full ${actor.status === 'active' ? 'bg-emerald-400' : 'bg-muted-foreground'}`} />
                    <span className="text-xs text-muted-foreground">{actor.status}</span>
                  </div>
                )}
              </div>
              {actor.title && (
                <p className="text-xs text-muted-foreground mt-0.5">{actor.title}</p>
              )}
              {actor.capabilities && actor.capabilities.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {actor.capabilities.map((cap, i) => (
                    <Badge key={i} variant="outline" className="text-[10px] px-1.5 py-0 bg-background/30 text-muted-foreground border-gray-200 dark:border-gray-700">
                      {cap}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 shrink-0">
              <Link href={`/dashboard/chat?actor=${actor.id}`}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-emerald-400"
                  title="Chat with this actor"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                </Button>
              </Link>
              {onAddChild && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-indigo-600 dark:hover:text-indigo-400"
                  onClick={() => onAddChild(actor.id)}
                >
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              )}
              {hasChildren && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={() => setExpanded(!expanded)}
                >
                  {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Children */}
      {hasChildren && expanded && (
        <div className="ml-8 pl-4 border-l-2 border-gray-200 dark:border-white/10 space-y-0">
          {actor.children!.map((child) => (
            <OrgTreeNode key={child.id} actor={child} depth={depth + 1} onAddChild={onAddChild} />
          ))}
        </div>
      )}
    </div>
  );
}

interface OrgTreeProps {
  actors: Actor[];
  onAddChild?: (parentId: string) => void;
}

export default function OrgTree({ actors, onAddChild }: OrgTreeProps) {
  if (!actors || actors.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-blue-500/10 to-violet-500/10 flex items-center justify-center mb-4">
          <Users className="w-10 h-10 text-muted-foreground/50" />
        </div>
        <h3 className="text-lg font-semibold text-foreground mb-2">No Actors Yet</h3>
        <p className="text-sm text-muted-foreground">Your digital workforce will appear here once created.</p>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {actors.map((actor) => (
        <OrgTreeNode key={actor.id} actor={actor} onAddChild={onAddChild} />
      ))}
    </div>
  );
}
