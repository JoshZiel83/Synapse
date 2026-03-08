const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

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

  // Actors
  getActors(wsId: string) { return this.fetch(`/workspaces/${wsId}/actors`); }
  getOrgTree(wsId: string) { return this.fetch(`/workspaces/${wsId}/actors/tree`); }
  createActor(wsId: string, data: any) { return this.fetch(`/workspaces/${wsId}/actors`, { method: 'POST', body: JSON.stringify(data) }); }

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
  createGroup(wsId: string, actorId: string, content: string) { return this.fetch(`/workspaces/${wsId}/chat/groups`, { method: 'POST', body: JSON.stringify({ actorId, content }) }); }
  getGroupMessages(wsId: string, rootSessionId: string, limit?: number, before?: string) {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (before) params.set('before', before);
    const qs = params.toString();
    return this.fetch(`/workspaces/${wsId}/chat/groups/${rootSessionId}/messages${qs ? '?' + qs : ''}`);
  }
  sendGroupMessage(wsId: string, rootSessionId: string, content: string) { return this.fetch(`/workspaces/${wsId}/chat/groups/${rootSessionId}/messages`, { method: 'POST', body: JSON.stringify({ content }) }); }
  markGroupRead(wsId: string, rootSessionId: string) { return this.fetch(`/workspaces/${wsId}/chat/groups/${rootSessionId}/read`, { method: 'POST', body: '{}' }); }
  cancelGroup(wsId: string, rootSessionId: string) { return this.fetch(`/workspaces/${wsId}/chat/groups/${rootSessionId}`, { method: 'DELETE' }); }

  // MCP Marketplace
  getMarketplace(params?: string) { return this.fetch(`/mcp/marketplace${params ? '?' + params : ''}`); }
  getMarketplacePlugin(pluginId: string) { return this.fetch(`/mcp/marketplace/${pluginId}`); }
  getMcpOrganizations() { return this.fetch('/mcp/organizations'); }
  getMcpOrganization(orgId: string) { return this.fetch(`/mcp/organizations/${orgId}`); }

  // MCP Unified Installations
  getInstallations(wsId: string, params?: string) { return this.fetch(`/workspaces/${wsId}/mcp/installations${params ? '?' + params : ''}`); }
  installPlugin(wsId: string, data: { pluginId: string; scopeType: string; scopeId?: string; lifecycleScope?: string; configData?: Record<string, unknown> }) {
    return this.fetch(`/workspaces/${wsId}/mcp/installations`, { method: 'POST', body: JSON.stringify(data) });
  }
  updateInstallation(wsId: string, installId: string, data: any) { return this.fetch(`/workspaces/${wsId}/mcp/installations/${installId}`, { method: 'PUT', body: JSON.stringify(data) }); }
  uninstallPlugin(wsId: string, installId: string) { return this.fetch(`/workspaces/${wsId}/mcp/installations/${installId}`, { method: 'DELETE' }); }

  // MCP Audit
  getMcpToolCallLogs(wsId: string, params?: string) { return this.fetch(`/workspaces/${wsId}/mcp/audit/tool-calls${params ? '?' + params : ''}`); }
  getMcpEventLogs(wsId: string, params?: string) { return this.fetch(`/workspaces/${wsId}/mcp/audit/events${params ? '?' + params : ''}`); }
}

export const api = new ApiClient();
