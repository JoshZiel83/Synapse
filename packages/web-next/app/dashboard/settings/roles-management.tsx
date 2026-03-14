'use client';

import { useCallback, useEffect, useState } from 'react';
import { Building2, RefreshCw, ShieldCheck, UserRound, Zap } from 'lucide-react';
import { useWorkspace } from '../workspace-provider';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type WorkspaceSupplementalRole =
  | 'model_admin'
  | 'actor_admin'
  | 'capability_admin'
  | 'memory_admin'
  | 'relay_admin'
  | 'conversation_admin';

type PlatformRole =
  | 'super_admin'
  | 'workspace_admin'
  | 'model_admin'
  | 'support'
  | 'auditor';

type WorkspaceMemberRecord = {
  userId: string;
  userName?: string;
  userEmail?: string;
  trustLevel: string;
  roles?: string[];
};

type WorkspaceRoleAssignment = {
  workspaceId: string;
  userId: string;
  role: WorkspaceSupplementalRole;
  assignedBy?: string | null;
  createdAt: string;
  updatedAt: string;
  trustLevel: string;
  userName?: string;
  userEmail?: string;
};

type PlatformRoleAssignment = {
  userId: string;
  role: PlatformRole;
  source: string;
  assignedBy?: string | null;
  createdAt: string;
  updatedAt: string;
  userName?: string;
  userEmail?: string;
};

const workspaceRoleOptions: Array<{
  value: WorkspaceSupplementalRole;
  label: string;
  description: string;
}> = [
  { value: 'model_admin', label: 'Model Admin', description: 'Manage model groups and workspace model config.' },
  { value: 'actor_admin', label: 'Actor Admin', description: 'Manage actors and actor assignments.' },
  { value: 'capability_admin', label: 'Capability Admin', description: 'Manage skills, plugins, and capability sharing.' },
  { value: 'memory_admin', label: 'Memory Admin', description: 'Manage workspace memories and retention.' },
  { value: 'relay_admin', label: 'Relay Admin', description: 'Manage MCP relays and relay tokens.' },
  { value: 'conversation_admin', label: 'Conversation Admin', description: 'Manage conversations and chat administration.' },
];

const platformRoleOptions: Array<{
  value: PlatformRole;
  label: string;
  description: string;
}> = [
  { value: 'super_admin', label: 'Super Admin', description: 'Full platform administration across all resources.' },
  { value: 'workspace_admin', label: 'Workspace Admin', description: 'Manage workspace-level operations on the platform.' },
  { value: 'model_admin', label: 'Model Admin', description: 'Manage platform model groups and global model policy.' },
  { value: 'support', label: 'Support', description: 'Operational access for troubleshooting and support.' },
  { value: 'auditor', label: 'Auditor', description: 'Read-only oversight for auditing and compliance.' },
];

function titleize(value: string) {
  return value
    .split('_')
    .join(' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTimestamp(value?: string) {
  if (!value) return 'Unknown';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return 'Unknown';
  }
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function UserIdentity({
  name,
  email,
  userId,
}: {
  name?: string;
  email?: string;
  userId: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="truncate font-medium text-foreground">{name || 'Unknown user'}</div>
      <div className="truncate text-xs text-muted-foreground">{email || userId}</div>
    </div>
  );
}

export default function RolesManagement({
  mode = 'all',
  showIntro = true,
}: {
  mode?: 'workspace' | 'platform' | 'all';
  showIntro?: boolean;
}) {
  const { workspaceId, workspaceName } = useWorkspace();
  const [members, setMembers] = useState<WorkspaceMemberRecord[]>([]);
  const [workspaceRoles, setWorkspaceRoles] = useState<WorkspaceRoleAssignment[]>([]);
  const [platformRoles, setPlatformRoles] = useState<PlatformRoleAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [platformError, setPlatformError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [workspaceRoleTargetUserId, setWorkspaceRoleTargetUserId] = useState('');
  const [workspaceRole, setWorkspaceRole] = useState<WorkspaceSupplementalRole>('model_admin');
  const [platformSuggestionUserId, setPlatformSuggestionUserId] = useState('');
  const [platformTargetUserId, setPlatformTargetUserId] = useState('');
  const [platformRole, setPlatformRole] = useState<PlatformRole>('workspace_admin');
  const [assigningWorkspaceRole, setAssigningWorkspaceRole] = useState(false);
  const [assigningPlatformRole, setAssigningPlatformRole] = useState(false);
  const [revokingWorkspaceKey, setRevokingWorkspaceKey] = useState<string | null>(null);
  const [revokingPlatformKey, setRevokingPlatformKey] = useState<string | null>(null);

  const loadWorkspaceData = useCallback(async (targetWorkspaceId: string) => {
    const [memberResponse, roleResponse] = await Promise.all([
      api.getWorkspaceMembers(targetWorkspaceId),
      api.getWorkspaceRoles(targetWorkspaceId),
    ]);

    const nextMembers = memberResponse?.data ?? [];
    const nextRoles = roleResponse?.data ?? [];

    setMembers(nextMembers);
    setWorkspaceRoles(nextRoles);
    setWorkspaceError(null);

    if (!workspaceRoleTargetUserId || !nextMembers.some((member: WorkspaceMemberRecord) => member.userId === workspaceRoleTargetUserId)) {
      setWorkspaceRoleTargetUserId(nextMembers[0]?.userId ?? '');
    }

    if (!platformTargetUserId && nextMembers[0]?.userId) {
      setPlatformSuggestionUserId(nextMembers[0].userId);
      setPlatformTargetUserId(nextMembers[0].userId);
    } else if (
      platformSuggestionUserId &&
      !nextMembers.some((member: WorkspaceMemberRecord) => member.userId === platformSuggestionUserId)
    ) {
      setPlatformSuggestionUserId(nextMembers[0]?.userId ?? '');
    }
  }, [platformSuggestionUserId, platformTargetUserId, workspaceRoleTargetUserId]);

  const loadPlatformData = useCallback(async () => {
    const response = await api.getPlatformRoles();
    setPlatformRoles(response?.data ?? []);
    setPlatformError(null);
  }, []);

  const refreshData = useCallback(async (options?: { silent?: boolean }) => {
    if (!workspaceId) {
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (options?.silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    setActionError(null);

    try {
      await loadWorkspaceData(workspaceId);
    } catch (error) {
      setMembers([]);
      setWorkspaceRoles([]);
      setWorkspaceError(getErrorMessage(error, 'Failed to load workspace role data.'));
    }

    try {
      await loadPlatformData();
    } catch (error) {
      setPlatformRoles([]);
      setPlatformError(getErrorMessage(error, 'Platform roles are unavailable for your account.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadPlatformData, loadWorkspaceData, workspaceId]);

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  const handleAssignWorkspaceRole = async () => {
    if (!workspaceId || !workspaceRoleTargetUserId) return;
    setAssigningWorkspaceRole(true);
    setActionError(null);
    try {
      await api.assignWorkspaceRole(workspaceId, {
        userId: workspaceRoleTargetUserId,
        role: workspaceRole,
      });
      await loadWorkspaceData(workspaceId);
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to assign workspace role.'));
    } finally {
      setAssigningWorkspaceRole(false);
    }
  };

  const handleRevokeWorkspaceRole = async (userId: string, role: WorkspaceSupplementalRole) => {
    if (!workspaceId) return;
    const key = `${userId}:${role}`;
    setRevokingWorkspaceKey(key);
    setActionError(null);
    try {
      await api.revokeWorkspaceRole(workspaceId, userId, role);
      await loadWorkspaceData(workspaceId);
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to revoke workspace role.'));
    } finally {
      setRevokingWorkspaceKey(null);
    }
  };

  const handleAssignPlatformRole = async () => {
    const normalizedUserId = platformTargetUserId.trim();
    if (!normalizedUserId) return;
    setAssigningPlatformRole(true);
    setActionError(null);
    try {
      await api.assignPlatformRole({
        userId: normalizedUserId,
        role: platformRole,
      });
      await loadPlatformData();
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to assign platform role.'));
    } finally {
      setAssigningPlatformRole(false);
    }
  };

  const handleRevokePlatformRole = async (userId: string, role: PlatformRole) => {
    const key = `${userId}:${role}`;
    setRevokingPlatformKey(key);
    setActionError(null);
    try {
      await api.revokePlatformRole(userId, role);
      await loadPlatformData();
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to revoke platform role.'));
    } finally {
      setRevokingPlatformKey(null);
    }
  };

  if (!workspaceId) {
    return (
      <div className="rounded-2xl border border-dashed border-border px-4 py-10 text-sm text-muted-foreground">
        Select a workspace before managing roles.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className={cn('mx-auto flex w-full flex-col gap-6 pt-4 md:pt-6 pb-6', mode === 'all' ? 'max-w-6xl' : 'max-w-4xl')}>
      {showIntro ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-foreground">
              {mode === 'workspace' ? 'Workspace Roles' : mode === 'platform' ? 'Platform Roles' : 'Roles'}
            </h1>
            {mode !== 'platform' && workspaceName ? <Badge variant="secondary">{workspaceName}</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {mode === 'workspace'
              ? 'Manage supplemental workspace roles for the current workspace.'
              : mode === 'platform'
                ? 'Manage platform administration roles.'
                : 'Manage workspace supplemental roles and platform administration roles from one place.'}
          </p>
        </div>
      ) : null}

      {actionError ? (
        <div className="rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-4 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <div className={`grid gap-6 ${mode === 'all' ? 'xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]' : ''}`}>
        {mode !== 'platform' ? (
        <section className="flex flex-col gap-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <Building2 className="h-4 w-4" />
              Workspace Roles
              </div>
              <p className="text-sm text-muted-foreground">
              Supplemental permissions for members inside the current workspace.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void refreshData({ silent: true })}>
                <RefreshCw className={cn('h-4 w-4', refreshing ? 'animate-spin' : '')} />
                Refresh
            </Button>
          </div>

          <div className="flex flex-col gap-6">
            {workspaceError ? (
              <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                {workspaceError}
              </div>
            ) : (
              <>
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="workspace-role-member">Workspace member</Label>
                    <Select value={workspaceRoleTargetUserId} onValueChange={setWorkspaceRoleTargetUserId}>
                      <SelectTrigger id="workspace-role-member" className="w-full">
                        <SelectValue placeholder="Select a member" />
                      </SelectTrigger>
                      <SelectContent>
                        {members.map((member) => (
                          <SelectItem key={member.userId} value={member.userId}>
                            {member.userName || member.userEmail || member.userId}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="workspace-role">Role</Label>
                    <Select value={workspaceRole} onValueChange={(value) => setWorkspaceRole(value as WorkspaceSupplementalRole)}>
                      <SelectTrigger id="workspace-role" className="w-full">
                        <SelectValue placeholder="Select a role" />
                      </SelectTrigger>
                      <SelectContent>
                        {workspaceRoleOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {workspaceRoleOptions.find((option) => option.value === workspaceRole)?.description}
                    </p>
                  </div>

                  <div className="flex items-end">
                    <Button
                      className="w-full lg:w-auto"
                      onClick={handleAssignWorkspaceRole}
                      disabled={assigningWorkspaceRole || !workspaceRoleTargetUserId}
                    >
                      <Zap className="h-4 w-4" />
                      {assigningWorkspaceRole ? 'Assigning...' : 'Assign role'}
                    </Button>
                  </div>
                </div>

                <Separator />

                <div className="rounded-2xl border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Base Role</TableHead>
                        <TableHead>Supplemental Role</TableHead>
                        <TableHead>Assigned</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workspaceRoles.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                            No supplemental workspace roles have been assigned yet.
                          </TableCell>
                        </TableRow>
                      ) : (
                        workspaceRoles.map((assignment) => {
                          const key = `${assignment.userId}:${assignment.role}`;
                          return (
                            <TableRow key={key}>
                              <TableCell className="max-w-0">
                                <UserIdentity
                                  name={assignment.userName}
                                  email={assignment.userEmail}
                                  userId={assignment.userId}
                                />
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline">{titleize(assignment.trustLevel)}</Badge>
                              </TableCell>
                              <TableCell>
                                <Badge>{titleize(assignment.role)}</Badge>
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {formatTimestamp(assignment.createdAt)}
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => void handleRevokeWorkspaceRole(assignment.userId, assignment.role)}
                                  disabled={revokingWorkspaceKey === key}
                                >
                                  {revokingWorkspaceKey === key ? 'Revoking...' : 'Revoke'}
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </div>
        </section>
        ) : null}

        {mode !== 'workspace' ? (
        <section className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <ShieldCheck className="h-4 w-4" />
              Platform Roles
            </div>
            <p className="text-sm text-muted-foreground">
              Global operational roles beyond a single workspace.
            </p>
          </div>

          <div className="flex flex-col gap-6">
            {platformError ? (
              <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                {platformError}
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="platform-role-member">Workspace member shortcut</Label>
                    <Select
                      value={platformSuggestionUserId}
                      onValueChange={(value) => {
                        setPlatformSuggestionUserId(value);
                        setPlatformTargetUserId(value);
                      }}
                    >
                      <SelectTrigger id="platform-role-member" className="w-full">
                        <SelectValue placeholder="Pick a workspace member" />
                      </SelectTrigger>
                      <SelectContent>
                        {members.map((member) => (
                          <SelectItem key={member.userId} value={member.userId}>
                            {member.userName || member.userEmail || member.userId}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="platform-role-user-id">Target user ID</Label>
                    <Input
                      id="platform-role-user-id"
                      value={platformTargetUserId}
                      onChange={(event) => setPlatformTargetUserId(event.target.value)}
                      placeholder="Paste a user UUID"
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="platform-role">Platform role</Label>
                    <Select value={platformRole} onValueChange={(value) => setPlatformRole(value as PlatformRole)}>
                      <SelectTrigger id="platform-role" className="w-full">
                        <SelectValue placeholder="Select a role" />
                      </SelectTrigger>
                      <SelectContent>
                        {platformRoleOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {platformRoleOptions.find((option) => option.value === platformRole)?.description}
                    </p>
                  </div>

                  <Button
                    onClick={handleAssignPlatformRole}
                    disabled={assigningPlatformRole || platformTargetUserId.trim().length === 0}
                  >
                    <ShieldCheck className="h-4 w-4" />
                    {assigningPlatformRole ? 'Assigning...' : 'Assign platform role'}
                  </Button>
                </div>

                <Separator />

                <div className="rounded-2xl border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {platformRoles.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                            No platform roles are assigned.
                          </TableCell>
                        </TableRow>
                      ) : (
                        platformRoles.map((assignment) => {
                          const key = `${assignment.userId}:${assignment.role}`;
                          const managedByConfig = assignment.source === 'config';
                          return (
                            <TableRow key={key}>
                              <TableCell className="max-w-0">
                                <UserIdentity
                                  name={assignment.userName}
                                  email={assignment.userEmail}
                                  userId={assignment.userId}
                                />
                              </TableCell>
                              <TableCell>
                                <Badge>{titleize(assignment.role)}</Badge>
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline">
                                  {managedByConfig ? 'Config' : titleize(assignment.source)}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => void handleRevokePlatformRole(assignment.userId, assignment.role)}
                                  disabled={managedByConfig || revokingPlatformKey === key}
                                >
                                  {managedByConfig
                                    ? 'Config managed'
                                    : revokingPlatformKey === key
                                      ? 'Revoking...'
                                      : 'Revoke'}
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </div>
        </section>
        ) : null}
      </div>

      {mode !== 'platform' ? (
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <UserRound className="h-4 w-4" />
            Workspace Member Directory
          </div>
          <p className="text-sm text-muted-foreground">
            Quick reference for base membership and currently assigned supplemental roles.
          </p>
        </div>

        <div>
          <div className="rounded-2xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Base Role</TableHead>
                  <TableHead>Supplemental Roles</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-10 text-center text-sm text-muted-foreground">
                      No workspace members found.
                    </TableCell>
                  </TableRow>
                ) : (
                  members.map((member) => (
                    <TableRow key={member.userId}>
                      <TableCell className="max-w-0">
                        <UserIdentity
                          name={member.userName}
                          email={member.userEmail}
                          userId={member.userId}
                        />
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{titleize(member.trustLevel)}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          {(member.roles || []).length > 0 ? (
                            (member.roles || []).map((role) => (
                              <Badge key={role} variant="secondary">
                                {titleize(role)}
                              </Badge>
                            ))
                          ) : (
                            <span className="text-sm text-muted-foreground">No supplemental roles</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </section>
      ) : null}
    </div>
  );
}
