import type {
  ActorTemplateCloneResult,
  ActorTemplateRecord,
  CanonicalContentBlock,
} from '@synapse/shared';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

class ApiClient {
  private token: string | null = null;

  setToken(token: string) { this.token = token; if (typeof window !== 'undefined') localStorage.setItem('token', token); }
  getToken() { if (!this.token && typeof window !== 'undefined') this.token = localStorage.getItem('token'); return this.token; }
  clearToken() { this.token = null; if (typeof window !== 'undefined') localStorage.removeItem('token'); }

  private async fetch(path: string, options: RequestInit = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...options.headers as any };
    const token = this.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (res.status === 401) { this.clearToken(); if (typeof window !== 'undefined') window.location.href = '/login'; }
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API error');
    return data;
  }

  // Auth
  register(email: string, password: string, name: string) { return this.fetch('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) }); }
  login(email: string, password: string) { return this.fetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); }
  getMe() { return this.fetch('/auth/me'); }

  // Workspaces
  getWorkspaces() { return this.fetch('/workspaces'); }
  createWorkspace(name: string, description?: string) { return this.fetch('/workspaces', { method: 'POST', body: JSON.stringify({ name, description }) }); }
  getWorkspace(id: string) { return this.fetch(`/workspaces/${id}`); }
  getWorkspaceMembers(wsId: string) { return this.fetch(`/workspaces/${wsId}/members`); }

  // Workspace Invites
  getInviteInfo(token: string) { return this.fetch(`/invites/${token}`); }
  redeemInvite(token: string) { return this.fetch(`/invites/${token}/redeem`, { method: 'POST', body: '{}' }); }
  createInvite(wsId: string, data: { trustLevel?: string; maxUses?: number; expiresAt?: string }) {
    return this.fetch(`/workspaces/${wsId}/invites`, { method: 'POST', body: JSON.stringify(data) });
  }
  listInvites(wsId: string) { return this.fetch(`/workspaces/${wsId}/invites`); }
  revokeInvite(wsId: string, inviteId: string) { return this.fetch(`/workspaces/${wsId}/invites/${inviteId}`, { method: 'DELETE' }); }

  // Actors
  getActors(wsId: string) { return this.fetch(`/workspaces/${wsId}/actors`); }
  getActor(wsId: string, actorId: string) { return this.fetch(`/workspaces/${wsId}/actors/${actorId}`); }
  getActorVersions(wsId: string, actorId: string) { return this.fetch(`/workspaces/${wsId}/actors/${actorId}/versions`); }
  getActorTemplates(wsId: string, search?: string): Promise<ActorTemplateRecord[]> {
    const params = search ? `?search=${encodeURIComponent(search)}` : ''
    return this.fetch(`/workspaces/${wsId}/actors/templates${params}`)
  }
  getActorTemplate(wsId: string, templateId: string): Promise<ActorTemplateRecord> {
    return this.fetch(`/workspaces/${wsId}/actors/templates/${templateId}`)
  }
  cloneActorTemplate(
    wsId: string,
    templateId: string,
    data?: {
      name?: string
      title?: string
      parentId?: string | null
      syncMode?: 'notify' | 'manual_merge'
    },
  ): Promise<ActorTemplateCloneResult> {
    return this.fetch(`/workspaces/${wsId}/actors/templates/${templateId}/clone`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    })
  }
  getOrgTree(wsId: string) { return this.fetch(`/workspaces/${wsId}/actors/tree`); }
  createActor(wsId: string, data: any) { return this.fetch(`/workspaces/${wsId}/actors`, { method: 'POST', body: JSON.stringify(data) }); }
  updateActor(wsId: string, actorId: string, data: any) { return this.fetch(`/workspaces/${wsId}/actors/${actorId}`, { method: 'PUT', body: JSON.stringify(data) }); }

  // Work Items
  getWorkItems(wsId: string, params?: string) { return this.fetch(`/workspaces/${wsId}/work-items${params ? '?' + params : ''}`); }
  getWorkItem(wsId: string, id: string) { return this.fetch(`/workspaces/${wsId}/work-items/${id}`); }

  // Secretary
  sendMessage(wsId: string, content: string) { return this.fetch(`/workspaces/${wsId}/secretary/message`, { method: 'POST', body: JSON.stringify({ content }) }); }
  getConversation(wsId: string) { return this.fetch(`/workspaces/${wsId}/secretary/conversation`); }
  clearConversation(wsId: string) { return this.fetch(`/workspaces/${wsId}/secretary/conversation`, { method: 'DELETE' }); }

  // Messages
  getMessages(wsId: string, params?: string) { return this.fetch(`/workspaces/${wsId}/messages${params ? '?' + params : ''}`); }

  // Memories
  getMemories(wsId: string, params?: string) { return this.fetch(`/workspaces/${wsId}/memories${params ? '?' + params : ''}`); }
  createMemory(wsId: string, data: any) { return this.fetch(`/workspaces/${wsId}/memories`, { method: 'POST', body: JSON.stringify(data) }); }
  updateMemory(wsId: string, id: string, data: any) { return this.fetch(`/workspaces/${wsId}/memories/${id}`, { method: 'PUT', body: JSON.stringify(data) }); }
  deleteMemory(wsId: string, id: string) { return this.fetch(`/workspaces/${wsId}/memories/${id}`, { method: 'DELETE' }); }

  // Audit
  getAuditLogs(wsId: string, params?: string) { return this.fetch(`/workspaces/${wsId}/audit-logs${params ? '?' + params : ''}`); }

  // Model Groups - Workspace
  getModelGroups(wsId: string) { return this.fetch(`/workspaces/${wsId}/model-groups`); }
  createModelGroup(wsId: string, data: any) { return this.fetch(`/workspaces/${wsId}/model-groups`, { method: 'POST', body: JSON.stringify(data) }); }
  getModelGroup(wsId: string, groupId: string) { return this.fetch(`/workspaces/${wsId}/model-groups/${groupId}`); }
  updateModelGroup(wsId: string, groupId: string, data: any) { return this.fetch(`/workspaces/${wsId}/model-groups/${groupId}`, { method: 'PUT', body: JSON.stringify(data) }); }
  deleteModelGroup(wsId: string, groupId: string) { return this.fetch(`/workspaces/${wsId}/model-groups/${groupId}`, { method: 'DELETE' }); }
  addModelItem(wsId: string, groupId: string, data: any) { return this.fetch(`/workspaces/${wsId}/model-groups/${groupId}/items`, { method: 'POST', body: JSON.stringify(data) }); }
  updateModelItem(wsId: string, groupId: string, itemId: string, data: any) { return this.fetch(`/workspaces/${wsId}/model-groups/${groupId}/items/${itemId}`, { method: 'PUT', body: JSON.stringify(data) }); }
  deleteModelItem(wsId: string, groupId: string, itemId: string) { return this.fetch(`/workspaces/${wsId}/model-groups/${groupId}/items/${itemId}`, { method: 'DELETE' }); }
  getItemVersions(wsId: string, groupId: string, itemId: string) { return this.fetch(`/workspaces/${wsId}/model-groups/${groupId}/items/${itemId}/versions`); }

  // Model Groups - Platform
  getPlatformModelGroups() { return this.fetch('/platform/model-groups'); }
  createPlatformModelGroup(data: any) { return this.fetch('/platform/model-groups', { method: 'POST', body: JSON.stringify(data) }); }
  getPlatformModelGroup(groupId: string) { return this.fetch(`/platform/model-groups/${groupId}`); }
  updatePlatformModelGroup(groupId: string, data: any) { return this.fetch(`/platform/model-groups/${groupId}`, { method: 'PUT', body: JSON.stringify(data) }); }
  deletePlatformModelGroup(groupId: string) { return this.fetch(`/platform/model-groups/${groupId}`, { method: 'DELETE' }); }
  addPlatformModelItem(groupId: string, data: any) { return this.fetch(`/platform/model-groups/${groupId}/items`, { method: 'POST', body: JSON.stringify(data) }); }
  updatePlatformModelItem(groupId: string, itemId: string, data: any) { return this.fetch(`/platform/model-groups/${groupId}/items/${itemId}`, { method: 'PUT', body: JSON.stringify(data) }); }
  deletePlatformModelItem(groupId: string, itemId: string) { return this.fetch(`/platform/model-groups/${groupId}/items/${itemId}`, { method: 'DELETE' }); }
  getPlatformItemVersions(groupId: string, itemId: string) { return this.fetch(`/platform/model-groups/${groupId}/items/${itemId}/versions`); }

  // Actor Model Group Assignment
  getActorModelGroups(wsId: string, actorId: string) { return this.fetch(`/workspaces/${wsId}/actors/${actorId}/model-groups`); }
  setActorModelGroups(wsId: string, actorId: string, groups: { groupId: string; priority: number }[]) {
    return this.fetch(`/workspaces/${wsId}/actors/${actorId}/model-groups`, { method: 'PUT', body: JSON.stringify({ groups }) });
  }

  // Sessions
  createSession(wsId: string, actorId: string, content: string, channelType?: string) {
    return this.fetch(`/workspaces/${wsId}/actors/${actorId}/sessions`, { method: 'POST', body: JSON.stringify({ content, channelType: channelType || 'web' }) });
  }
  sendSessionMessage(wsId: string, sessionId: string, content: string) {
    return this.fetch(`/workspaces/${wsId}/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
  }
  getSession(wsId: string, sessionId: string) { return this.fetch(`/workspaces/${wsId}/sessions/${sessionId}`); }
  getSessionMessages(wsId: string, sessionId: string) { return this.fetch(`/workspaces/${wsId}/sessions/${sessionId}/messages`); }
  getActorSessions(wsId: string, actorId: string, status?: string) {
    const params = status ? `?status=${status}` : '';
    return this.fetch(`/workspaces/${wsId}/actors/${actorId}/sessions${params}`);
  }
  getSessionTree(wsId: string, sessionId: string) { return this.fetch(`/workspaces/${wsId}/sessions/${sessionId}/tree`); }
  cancelSession(wsId: string, sessionId: string) { return this.fetch(`/workspaces/${wsId}/sessions/${sessionId}`, { method: 'DELETE' }); }

  // Chat Groups
  getGroups(wsId: string) { return this.fetch(`/workspaces/${wsId}/chat/groups`); }
  createGroup(wsId: string, actorIds: string[], content?: string, targetActorId?: string) {
    const body: any = actorIds.length === 1
      ? { actorId: actorIds[0], ...(content && { content }) }
      : { actorIds, ...(content && { content }), targetActorId: targetActorId || actorIds[0] };
    return this.fetch(`/workspaces/${wsId}/chat/groups`, { method: 'POST', body: JSON.stringify(body) });
  }
  getGroupMessages(wsId: string, groupId: string, limit?: number, before?: string) {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (before) params.set('before', before);
    const qs = params.toString();
    return this.fetch(`/workspaces/${wsId}/chat/groups/${groupId}/messages${qs ? '?' + qs : ''}`);
  }
  sendGroupMessage(wsId: string, groupId: string, contentBlocks: CanonicalContentBlock[], targetActorIds?: string[]) {
    const body: any = { contentBlocks };
    if (targetActorIds && targetActorIds.length > 0) body.targetActorIds = targetActorIds;
    return this.fetch(`/workspaces/${wsId}/chat/groups/${groupId}/messages`, { method: 'POST', body: JSON.stringify(body) });
  }
  markGroupRead(wsId: string, groupId: string) { return this.fetch(`/workspaces/${wsId}/chat/groups/${groupId}/read`, { method: 'POST', body: '{}' }); }
  cancelGroup(wsId: string, groupId: string) { return this.fetch(`/workspaces/${wsId}/chat/groups/${groupId}`, { method: 'DELETE' }); }

  // MCP Marketplace
  getMarketplace(params?: string) { return this.fetch(`/mcp/marketplace${params ? '?' + params : ''}`); }
  getMarketplacePlugin(pluginId: string) { return this.fetch(`/mcp/marketplace/${pluginId}`); }
  getPluginCategories() { return this.fetch('/mcp/categories'); }
  getMcpOrganizations() { return this.fetch('/mcp/organizations'); }
  getMcpOrganization(orgId: string) { return this.fetch(`/mcp/organizations/${orgId}`); }

  // MCP Unified Installations
  getInstallations(wsId: string, params?: string) { return this.fetch(`/workspaces/${wsId}/mcp/installations${params ? '?' + params : ''}`); }
  getInstallation(wsId: string, installId: string) { return this.fetch(`/workspaces/${wsId}/mcp/installations/${installId}`); }
  installPlugin(
    wsId: string,
    data: {
      pluginId: string;
      scopeType: 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
      actorId?: string;
      conversationId?: string;
      userId?: string;
      lifecycleScope?: 'turn' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
      configData?: Record<string, unknown>;
      authSessionIds?: Record<string, string>;
    },
  ) {
    return this.fetch(`/workspaces/${wsId}/mcp/installations`, { method: 'POST', body: JSON.stringify(data) });
  }
  updateInstallation(wsId: string, installId: string, data: any) { return this.fetch(`/workspaces/${wsId}/mcp/installations/${installId}`, { method: 'PUT', body: JSON.stringify(data) }); }
  uninstallPlugin(wsId: string, installId: string) { return this.fetch(`/workspaces/${wsId}/mcp/installations/${installId}`, { method: 'DELETE' }); }
  startPluginAuth(wsId: string, pluginId: string, providerKey: string) {
    return this.fetch(`/workspaces/${wsId}/mcp/plugins/${pluginId}/auth/${providerKey}/start`, { method: 'POST', body: '{}' });
  }
  getPluginAuthSession(wsId: string, sessionId: string) {
    return this.fetch(`/workspaces/${wsId}/mcp/auth/sessions/${sessionId}`);
  }
  getCapabilityGrants(wsId: string, bindingId: string) {
    return this.fetch(`/workspaces/${wsId}/capabilities/bindings/${bindingId}/grants`);
  }
  getCapabilityAuthorization(wsId: string, bindingId: string, params?: string) {
    return this.fetch(`/workspaces/${wsId}/capabilities/bindings/${bindingId}/authorization${params ? `?${params}` : ''}`);
  }
  issueCapabilityGrant(
    wsId: string,
    bindingId: string,
    data: {
      grantScope?: 'platform' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
      conversationId?: string;
      actorId?: string;
      userId?: string;
      permissions?: string[];
      reason?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    return this.fetch(`/workspaces/${wsId}/capabilities/bindings/${bindingId}/grants`, { method: 'POST', body: JSON.stringify(data) });
  }
  revokeCapabilityGrant(wsId: string, grantId: string) {
    return this.fetch(`/workspaces/${wsId}/capabilities/grants/${grantId}`, { method: 'DELETE' });
  }

  // MCP Audit
  getMcpToolCallLogs(wsId: string, params?: string) { return this.fetch(`/workspaces/${wsId}/mcp/audit/tool-calls${params ? '?' + params : ''}`); }
  getMcpEventLogs(wsId: string, params?: string) { return this.fetch(`/workspaces/${wsId}/mcp/audit/events${params ? '?' + params : ''}`); }

  // MCP Relays
  getRelays(wsId: string) { return this.fetch(`/workspaces/${wsId}/mcp/relays`); }
  createRelay(wsId: string, data: { name: string; metadata?: Record<string, unknown> }) {
    return this.fetch(`/workspaces/${wsId}/mcp/relays`, { method: 'POST', body: JSON.stringify(data) });
  }
  updateRelay(wsId: string, relayId: string, data: { name?: string; metadata?: Record<string, unknown> }) {
    return this.fetch(`/workspaces/${wsId}/mcp/relays/${relayId}`, { method: 'PUT', body: JSON.stringify(data) });
  }
  deleteRelay(wsId: string, relayId: string) { return this.fetch(`/workspaces/${wsId}/mcp/relays/${relayId}`, { method: 'DELETE' }); }
  regenerateRelayToken(wsId: string, relayId: string) {
    return this.fetch(`/workspaces/${wsId}/mcp/relays/${relayId}/regenerate-token`, { method: 'POST', body: '{}' });
  }
  getRelayServers(wsId: string, relayId: string) { return this.fetch(`/workspaces/${wsId}/mcp/relays/${relayId}/servers`); }
  updateRelayServer(wsId: string, relayId: string, serverId: string, data: { isEnabled: boolean }) {
    return this.fetch(`/workspaces/${wsId}/mcp/relays/${relayId}/servers/${serverId}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  // File Upload
  async uploadFile(wsId: string, file: File) {
    const formData = new FormData();
    formData.append('file', file);
    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/workspaces/${wsId}/files`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Upload failed');
    }
    return res.json();
  }

  // A2A Apps
  getA2AApps(wsId: string) { return this.fetch(`/workspaces/${wsId}/a2a/apps`); }
  createA2AApp(wsId: string, data: { name: string; description?: string; actorIds: string[]; rateLimitRpm?: number }) {
    return this.fetch(`/workspaces/${wsId}/a2a/apps`, { method: 'POST', body: JSON.stringify(data) });
  }
  getA2AApp(wsId: string, appId: string) { return this.fetch(`/workspaces/${wsId}/a2a/apps/${appId}`); }
  updateA2AApp(wsId: string, appId: string, data: any) {
    return this.fetch(`/workspaces/${wsId}/a2a/apps/${appId}`, { method: 'PUT', body: JSON.stringify(data) });
  }
  deleteA2AApp(wsId: string, appId: string) { return this.fetch(`/workspaces/${wsId}/a2a/apps/${appId}`, { method: 'DELETE' }); }
  regenerateA2AAppKey(wsId: string, appId: string) {
    return this.fetch(`/workspaces/${wsId}/a2a/apps/${appId}/regenerate-key`, { method: 'POST', body: '{}' });
  }
}

export const api = new ApiClient();
