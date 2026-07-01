"use client"

import type { InviteTrustLevel, WorkspaceInviteView } from "@synapse/shared"
import { useEffect, useState, useCallback } from "react"
import { useWorkspace } from "../workspace-provider"
import { api } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Plus, Copy, Trash2, Check } from "lucide-react"

import { createLogger } from "@/lib/client-logger"

const clientLog = createLogger("web.dashboard.settings.invite-management")

export default function InviteManagement() {
  const { workspaceId } = useWorkspace()
  const [invites, setInvites] = useState<WorkspaceInviteView[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Create form state
  const [trustLevel, setTrustLevel] = useState<InviteTrustLevel>("member")
  const [maxUses, setMaxUses] = useState("")
  const [expiresIn, setExpiresIn] = useState("")
  const [creating, setCreating] = useState(false)

  const loadInvites = useCallback(async () => {
    if (!workspaceId) return
    try {
      const invites = await api.listInvites(workspaceId)
      setInvites(invites ?? [])
    } catch (err) {
      clientLog.error("Failed to load invites:", err)
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    loadInvites()
  }, [loadInvites])

  const handleCreate = async () => {
    if (!workspaceId) return
    setCreating(true)
    try {
      const data: Parameters<typeof api.createInvite>[1] = { trustLevel }
      if (maxUses) data.maxUses = parseInt(maxUses, 10)
      if (expiresIn) {
        // Send a RELATIVE TTL; the server mints the authoritative absolute
        // expiry from its own clock so a skewed client clock can't forge one.
        const hours = parseInt(expiresIn, 10)
        if (hours > 0) {
          data.expiresInHours = hours
        }
      }
      await api.createInvite(workspaceId, data)
      setDialogOpen(false)
      setTrustLevel("member")
      setMaxUses("")
      setExpiresIn("")
      loadInvites()
    } catch (err: any) {
      alert(err.message || "Failed to create invite")
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (inviteId: string) => {
    if (!workspaceId) return
    try {
      await api.revokeInvite(workspaceId, inviteId)
      loadInvites()
    } catch (err: any) {
      alert(err.message || "Failed to revoke invite")
    }
  }

  const copyLink = (token: string, inviteId: string) => {
    const link = `${window.location.origin}/invite/${token}`
    navigator.clipboard.writeText(link)
    setCopiedId(inviteId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">
            Invite Links
          </h3>
          <p className="text-sm text-muted-foreground">
            Manage invite links for this workspace
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              Create Invite
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Invite Link</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div>
                <Label>Role</Label>
                <select
                  value={trustLevel}
                  onChange={(e) =>
                    setTrustLevel(e.target.value as InviteTrustLevel)
                  }
                  className="mt-1.5 block w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-foreground dark:border-white/10 dark:bg-white/5"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                  <option value="guest">Guest</option>
                </select>
              </div>
              <div>
                <Label>Max uses (optional)</Label>
                <Input
                  type="number"
                  min="1"
                  value={maxUses}
                  onChange={(e) => setMaxUses(e.target.value)}
                  placeholder="Unlimited"
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label>Expires in hours (optional)</Label>
                <Input
                  type="number"
                  min="1"
                  value={expiresIn}
                  onChange={(e) => setExpiresIn(e.target.value)}
                  placeholder="Never"
                  className="mt-1.5"
                />
              </div>
              <Button
                onClick={handleCreate}
                disabled={creating}
                className="w-full"
              >
                {creating ? "Creating..." : "Create Invite Link"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {invites.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No active invites. Create one to invite people to this workspace.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {invites.map((invite) => {
            const isExpired =
              invite.expiresAt && new Date(invite.expiresAt) < new Date()
            const isUsedUp =
              invite.maxUses !== null && invite.useCount >= invite.maxUses

            return (
              <Card key={invite.id}>
                <CardContent className="flex items-center gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-sm font-semibold text-foreground">
                        {invite.token}
                      </code>
                      <Badge variant="outline" className="text-xs capitalize">
                        {invite.trustLevel}
                      </Badge>
                      {isExpired ? (
                        <Badge variant="destructive" className="text-xs">
                          Expired
                        </Badge>
                      ) : null}
                      {isUsedUp ? (
                        <Badge variant="destructive" className="text-xs">
                          Used up
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Used {invite.useCount}
                      {invite.maxUses !== null ? `/${invite.maxUses}` : ""}{" "}
                      times
                      {invite.expiresAt && !isExpired ? (
                        <>
                          {" "}
                          &middot; Expires{" "}
                          {new Date(invite.expiresAt).toLocaleDateString()}
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => copyLink(invite.token, invite.id)}
                      className="h-8 w-8 p-0"
                      title="Copy invite link"
                    >
                      {copiedId === invite.id ? (
                        <Check className="h-4 w-4 text-green-600" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevoke(invite.id)}
                      className="h-8 w-8 p-0 text-red-500 hover:text-red-600"
                      title="Revoke invite"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
