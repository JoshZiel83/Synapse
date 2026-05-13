"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  ChevronDown,
  ChevronRight,
  Plus,
  User,
  Bot,
  Crown,
  Users,
  MessageSquare,
} from "lucide-react"
import Link from "next/link"

interface Actor {
  id: string
  name: string
  role: string
  title?: string
  type?: string
  specialties?: string[]
  status?: string
  children?: Actor[]
}
interface OrgTreeNodeProps {
  actor: Actor
  depth?: number
  onAddChild?: (parentId: string) => void
}

function getRoleColor(role: string) {
  switch (role?.toLowerCase()) {
    case "ceo":
    case "director":
      return "from-amber-500 to-orange-500"
    case "manager":
      return "from-violet-500 to-purple-500"
    case "secretary":
      return "from-blue-500 to-cyan-500"
    case "engineer":
    case "developer":
      return "from-emerald-500 to-teal-500"
    case "analyst":
      return "from-pink-500 to-rose-500"
    default:
      return "from-blue-500 to-violet-500"
  }
}

function getRoleBadgeClass(role: string) {
  switch (role?.toLowerCase()) {
    case "ceo":
    case "director":
      return "bg-amber-500/10 text-amber-400 border-amber-500/20"
    case "manager":
      return "bg-violet-500/10 text-violet-400 border-violet-500/20"
    case "secretary":
      return "bg-blue-500/10 text-blue-400 border-blue-500/20"
    case "engineer":
    case "developer":
      return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
    default:
      return "bg-blue-500/10 text-blue-400 border-blue-500/20"
  }
}

function OrgTreeNode({ actor, depth = 0, onAddChild }: OrgTreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2)
  const hasChildren = actor.children && actor.children.length > 0
  const roleColor = getRoleColor(actor.role)

  return (
    <div className="relative">
      {/* Connector lines */}
      {depth > 0 && (
        <div className="absolute top-0 left-0 h-6 w-6 -translate-x-4 rounded-bl-xl border-b-2 border-l-2 border-blue-500/15" />
      )}

      <Card className="group mb-3 border-gray-200 bg-white ring-1 ring-gray-200 transition-all duration-300 hover:border-blue-500/15 dark:border-white/10 dark:bg-gray-900 dark:ring-white/10">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            {/* Avatar */}
            <div
              className={`h-10 w-10 rounded-xl bg-gradient-to-br ${roleColor} flex shrink-0 items-center justify-center shadow-lg`}
            >
              {actor.role?.toLowerCase() === "ceo" ||
              actor.role?.toLowerCase() === "director" ? (
                <Crown className="h-5 w-5 text-white" />
              ) : actor.type === "ai" ? (
                <Bot className="h-5 w-5 text-white" />
              ) : (
                <User className="h-5 w-5 text-white" />
              )}
            </div>

            {/* Info */}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  {actor.name}
                </h3>
                <Badge
                  variant="outline"
                  className={`text-xs ${getRoleBadgeClass(actor.role)}`}
                >
                  {actor.role}
                </Badge>
                {actor.status && (
                  <div className="flex items-center gap-1">
                    <div
                      className={`h-1.5 w-1.5 rounded-full ${actor.status === "active" ? "bg-emerald-400" : "bg-muted-foreground"}`}
                    />
                    <span className="text-xs text-muted-foreground">
                      {actor.status}
                    </span>
                  </div>
                )}
              </div>
              {actor.title && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {actor.title}
                </p>
              )}
              {actor.specialties && actor.specialties.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {actor.specialties.map((specialty, i) => (
                    <Badge
                      key={i}
                      variant="outline"
                      className="border-gray-200 bg-background/30 px-1.5 py-0 text-[10px] text-muted-foreground dark:border-gray-700"
                    >
                      {specialty}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex shrink-0 items-center gap-1">
              <Link href={`/dashboard/chat?actor=${actor.id}`}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-emerald-400"
                  title="Chat with this actor"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                </Button>
              </Link>
              {onAddChild && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-primary"
                  onClick={() => onAddChild(actor.id)}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              )}
              {hasChildren && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={() => setExpanded(!expanded)}
                >
                  {expanded ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Children */}
      {hasChildren && expanded && (
        <div className="ml-8 space-y-0 border-l-2 border-gray-200 pl-4 dark:border-white/10">
          {actor.children!.map((child) => (
            <OrgTreeNode
              key={child.id}
              actor={child}
              depth={depth + 1}
              onAddChild={onAddChild}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface OrgTreeProps {
  actors: Actor[]
  onAddChild?: (parentId: string) => void
}

export default function OrgTree({ actors, onAddChild }: OrgTreeProps) {
  if (!actors || actors.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-blue-500/10 to-violet-500/10">
          <Users className="h-10 w-10 text-muted-foreground/50" />
        </div>
        <h3 className="mb-2 text-lg font-semibold text-foreground">
          No Actors Yet
        </h3>
        <p className="text-sm text-muted-foreground">
          Your digital workforce will appear here once created.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-0">
      {actors.map((actor) => (
        <OrgTreeNode key={actor.id} actor={actor} onAddChild={onAddChild} />
      ))}
    </div>
  )
}
