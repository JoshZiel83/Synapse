import crypto from 'crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  authzEnabled,
  buildActorConversationContextId,
  checkPermission,
  diffAuthzRelationships,
  enqueueAuthzRelationships,
  flushAuthzOutboxEntries,
  lookupResources,
  touchActorConversationContext,
  touchRelation,
  type AuthzRelationMutation,
} from '../../infrastructure/authz/index.js';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import { query } from '../../infrastructure/database/index.js';
import { disconnectRelay, isRelayConnected } from './relay-manager.js';
import { incrementMcpVersion } from './instance-manager.js';

// ============ Schemas ============

const createRelaySchema = z.object({
  name: z.string().min(1).max(255),
  metadata: z.record(z.unknown()).optional(),
});

const updateRelaySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const relayGrantScopeEnum = z.enum(['workspace', 'conversation', 'actor_global', 'actor_conversation', 'user']);
const createRelayGrantSchema = z.object({
  grantScope: relayGrantScopeEnum,
  actorId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  reason: z.string().max(2000).optional(),
  metadata: z.record(z.unknown()).optional(),
}).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  switch (value.grantScope) {
    case 'workspace':
      if (value.actorId || value.conversationId || value.userId) invalid('workspace grant cannot target actor, conversation, or user');
      break;
    case 'conversation':
      if (!value.conversationId || value.actorId || value.userId) invalid('conversation grant requires conversationId only');
      break;
    case 'actor_global':
      if (!value.actorId || value.conversationId || value.userId) invalid('actor_global grant requires actorId only');
      break;
    case 'actor_conversation':
      if (!value.actorId || !value.conversationId || value.userId) invalid('actor_conversation grant requires actorId and conversationId');
      break;
    case 'user':
      if (!value.userId || value.actorId || value.conversationId) invalid('user grant requires userId only');
      break;
  }
});

type RelayGrantScope = z.infer<typeof relayGrantScopeEnum>;
type RelayGrantRow = {
  id: string;
  relay_id: string;
  workspace_id: string;
  grant_scope: RelayGrantScope;
  actor_id: string | null;
  conversation_id: string | null;
  user_id: string | null;
  status: 'active' | 'revoked';
  granted_by: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | string | null;
  created_at: string;
  revoked_at: string | null;
};

type RelayRow = {
  id: string;
  user_id: string | null;
  workspace_id: string;
};

// ============ Error helper ============

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    return reply.status(400).send({ error: 'Validation error', details: error.errors });
  }
  console.error('[Relay Controller]', error);
  return reply.status(500).send({ error: 'Internal server error' });
}

function parseJsonObject(value: unknown) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value as Record<string, unknown>;
}

function hasLegacyWorkspacePermission(trustLevel: string | null | undefined, permission: string) {
  switch (permission) {
    case 'view':
      return Boolean(trustLevel);
    case 'manage_relays':
      return trustLevel === 'owner' || trustLevel === 'admin';
    default:
      return false;
  }
}

function hasLegacyRelayPermission(trustLevel: string | null | undefined, permission: string) {
  switch (permission) {
    case 'view':
    case 'invoke':
      return Boolean(trustLevel);
    case 'edit':
    case 'grant':
    case 'delete':
    case 'rotate_token':
      return trustLevel === 'owner' || trustLevel === 'admin';
    default:
      return false;
  }
}

async function getWorkspaceTrustLevel(workspaceId: string, userId: string) {
  const result = await query(
    `SELECT trust_level
     FROM workspace_members
     WHERE workspace_id = $1 AND user_id = $2
     LIMIT 1`,
    [workspaceId, userId],
  );
  return (result.rows[0]?.trust_level as string | undefined) || null;
}

function buildRelayScopeRelations(params: {
  relayId: string;
  scope: RelayGrantScope;
  workspaceId: string;
  actorId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
  enabled?: boolean;
}): AuthzRelationMutation[] {
  if (params.enabled === false) {
    return [];
  }

  switch (params.scope) {
    case 'workspace':
      return [touchRelation('mcp_relay', params.relayId, 'use_workspace', 'workspace', params.workspaceId)];
    case 'conversation':
      return params.conversationId
        ? [touchRelation('mcp_relay', params.relayId, 'use_conversation', 'conversation', params.conversationId)]
        : [];
    case 'actor_global':
      return params.actorId
        ? [touchRelation('mcp_relay', params.relayId, 'use_principal', 'actor', params.actorId)]
        : [];
    case 'actor_conversation':
      return params.actorId && params.conversationId
        ? [
            ...touchActorConversationContext(params.actorId, params.conversationId),
            touchRelation(
              'mcp_relay',
              params.relayId,
              'use_actor_conversation',
              'actor_conversation',
              buildActorConversationContextId(params.actorId, params.conversationId),
            ),
          ]
        : [];
    case 'user':
      return params.userId
        ? [touchRelation('mcp_relay', params.relayId, 'use_principal', 'user', params.userId)]
        : [];
    default:
      return [];
  }
}

function buildRelayGrantAuthzRelations(relayId: string, workspaceId: string, grants: RelayGrantRow[]) {
  return grants
    .filter((grant) => grant.status === 'active')
    .flatMap((grant) =>
      buildRelayScopeRelations({
        relayId,
        scope: grant.grant_scope,
        workspaceId,
        actorId: grant.actor_id,
        conversationId: grant.conversation_id,
        userId: grant.user_id,
        enabled: true,
      }),
    );
}

function buildRelayAuthzRelations(relay: RelayRow, grants: RelayGrantRow[]) {
  return [
    touchRelation('mcp_relay', relay.id, 'workspace', 'workspace', relay.workspace_id),
    ...(relay.user_id ? [touchRelation('mcp_relay', relay.id, 'owner', 'user', relay.user_id)] : []),
    ...buildRelayGrantAuthzRelations(relay.id, relay.workspace_id, grants),
  ];
}

function mapRelayGrant(row: RelayGrantRow) {
  return {
    id: row.id,
    relayId: row.relay_id,
    workspaceId: row.workspace_id,
    grantScope: row.grant_scope,
    actorId: row.actor_id || undefined,
    conversationId: row.conversation_id || undefined,
    userId: row.user_id || undefined,
    status: row.status,
    grantedBy: row.granted_by || undefined,
    reason: row.reason || undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    revokedAt: row.revoked_at || undefined,
  };
}

async function listRelayGrants(relayId: string, workspaceId: string) {
  const result = await query<RelayGrantRow>(
    `SELECT *
     FROM mcp_relay_grants
     WHERE relay_id = $1 AND workspace_id = $2
     ORDER BY created_at DESC`,
    [relayId, workspaceId],
  );
  return result.rows;
}

async function validateRelayGrantTargets(
  workspaceId: string,
  input: {
    actorId?: string;
    conversationId?: string;
    userId?: string;
  },
) {
  if (input.actorId) {
    const actorResult = await query(
      `SELECT 1
       FROM actors
       WHERE id = $1 AND workspace_id = $2
       LIMIT 1`,
      [input.actorId, workspaceId],
    );
    if (actorResult.rows.length === 0) {
      return 'actorId does not belong to this workspace';
    }
  }

  if (input.conversationId) {
    const conversationResult = await query(
      `SELECT 1
       FROM conversations
       WHERE id = $1 AND workspace_id = $2
       LIMIT 1`,
      [input.conversationId, workspaceId],
    );
    if (conversationResult.rows.length === 0) {
      return 'conversationId does not belong to this workspace';
    }
  }

  if (input.userId) {
    const userResult = await query(
      `SELECT 1
       FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2
       LIMIT 1`,
      [workspaceId, input.userId],
    );
    if (userResult.rows.length === 0) {
      return 'userId is not a member of this workspace';
    }
  }

  return null;
}

async function requireWorkspacePermission(
  request: any,
  reply: FastifyReply,
  permission: string,
  errorMessage: string,
) {
  const { workspaceId } = request.params as { workspaceId: string };
  const userId = (request as any).user.userId;

  if (!authzEnabled()) {
    const trustLevel = await getWorkspaceTrustLevel(workspaceId, userId);
    if (!hasLegacyWorkspacePermission(trustLevel, permission)) {
      reply.status(403).send({ error: errorMessage });
      return false;
    }
    return true;
  }

  const allowed = await checkPermission({
    resourceType: 'workspace',
    resourceId: workspaceId,
    permission,
    subject: { type: 'user', id: userId },
  });

  if (!allowed) {
    reply.status(403).send({ error: errorMessage });
    return false;
  }

  return true;
}

async function getRelay(relayId: string, workspaceId: string) {
  const result = await query<RelayRow>(
    `SELECT *
     FROM mcp_relays
     WHERE id = $1 AND workspace_id = $2
     LIMIT 1`,
    [relayId, workspaceId],
  );
  return result.rows[0] ?? null;
}

async function requireRelayPermission(
  request: any,
  reply: FastifyReply,
  permission: string,
  errorMessage: string,
) {
  const { workspaceId, id } = request.params as { workspaceId: string; id: string };
  const relay = await getRelay(id, workspaceId);
  if (!relay) {
    reply.status(404).send({ error: 'Relay not found' });
    return null;
  }

  const userId = (request as any).user.userId;
  if (!authzEnabled()) {
    const trustLevel = await getWorkspaceTrustLevel(workspaceId, userId);
    if (!hasLegacyRelayPermission(trustLevel, permission)) {
      reply.status(403).send({ error: errorMessage });
      return null;
    }
    return relay;
  }

  const allowed = await checkPermission({
    resourceType: 'mcp_relay',
    resourceId: relay.id,
    permission,
    subject: { type: 'user', id: userId },
  });

  if (!allowed) {
    reply.status(403).send({ error: errorMessage });
    return null;
  }

  return relay;
}

async function flushQueuedAuthzEntries(entryIds: string[], source: string) {
  if (!authzEnabled() || entryIds.length === 0) return;

  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(`[authz] Failed to flush ${source} relationship updates:`, error);
  }
}

// ============ Route registration ============

export function registerRelayRoutes(app: FastifyInstance) {
  const preHandler = [authMiddleware, workspaceMiddleware];

  // POST /api/v1/workspaces/:workspaceId/mcp/relays — Create relay
  app.post('/api/v1/workspaces/:workspaceId/mcp/relays', { preHandler }, async (request, reply) => {
    try {
      const allowed = await requireWorkspacePermission(
        request,
        reply,
        'manage_relays',
        'Not allowed to manage relays in this workspace',
      );
      if (!allowed) return;

      const { workspaceId } = request.params as any;
      const userId = (request as any).user.userId;
      const body = createRelaySchema.parse(request.body);

      const authToken = crypto.randomBytes(32).toString('hex');

      const result = await query(
        `INSERT INTO mcp_relays (user_id, workspace_id, name, auth_token, metadata)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, is_connected, created_at`,
        [userId, workspaceId, body.name, authToken, JSON.stringify(body.metadata || {})]
      );

      const relay = result.rows[0];

      const authzEntryIds = await enqueueAuthzRelationships(
        buildRelayAuthzRelations(
          {
            id: relay.id,
            workspace_id: workspaceId,
            user_id: userId,
          },
          [],
        ),
        {
          source: 'mcp_relay.create',
          workspaceId,
          relayId: relay.id,
          userId,
        },
      );
      await flushQueuedAuthzEntries(authzEntryIds, 'mcp_relay.create');

      return reply.status(201).send({
        id: relay.id,
        name: relay.name,
        token: authToken, // Only returned once at creation
        isConnected: relay.is_connected,
        createdAt: relay.created_at,
      });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  // GET /api/v1/workspaces/:workspaceId/mcp/relays — List relays
  app.get('/api/v1/workspaces/:workspaceId/mcp/relays', { preHandler }, async (request, reply) => {
    try {
      const { workspaceId } = request.params as any;
      const userId = (request as any).user.userId;

      const allowed = await requireWorkspacePermission(
        request,
        reply,
        'view',
        'Not allowed to access relays in this workspace',
      );
      if (!allowed) return;

      const relayIds = authzEnabled()
        ? await lookupResources({
            resourceType: 'mcp_relay',
            permission: 'view',
            subject: { type: 'user', id: userId },
          })
        : [];

      if (authzEnabled() && relayIds.length === 0) {
        return reply.send([]);
      }

      const result = await query(
        `SELECT id, name, is_connected, last_connected_at, metadata, created_at, updated_at
         FROM mcp_relays
         WHERE workspace_id = $1
           ${authzEnabled() ? 'AND id = ANY($2)' : ''}
         ORDER BY created_at DESC`,
        authzEnabled() ? [workspaceId, relayIds] : [workspaceId]
      );

      // Enrich with live connection status
      const relays = result.rows.map(r => ({
        id: r.id,
        name: r.name,
        isConnected: isRelayConnected(r.id),
        lastConnectedAt: r.last_connected_at,
        metadata: r.metadata,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));

      return reply.send(relays);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  // GET /api/v1/workspaces/:workspaceId/mcp/relays/:id/grants — List relay grants
  app.get('/api/v1/workspaces/:workspaceId/mcp/relays/:id/grants', { preHandler }, async (request, reply) => {
    try {
      const relay = await requireRelayPermission(
        request,
        reply,
        'grant',
        'Not allowed to manage grants for this relay',
      );
      if (!relay) return;

      const { workspaceId } = request.params as any;
      const grants = await listRelayGrants(relay.id, workspaceId);
      return reply.send({ grants: grants.map(mapRelayGrant) });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  // POST /api/v1/workspaces/:workspaceId/mcp/relays/:id/grants — Create relay grant
  app.post('/api/v1/workspaces/:workspaceId/mcp/relays/:id/grants', { preHandler }, async (request, reply) => {
    try {
      const relay = await requireRelayPermission(
        request,
        reply,
        'grant',
        'Not allowed to manage grants for this relay',
      );
      if (!relay) return;

      const { workspaceId } = request.params as any;
      const userId = (request as any).user.userId;
      const body = createRelayGrantSchema.parse(request.body);
      const targetError = await validateRelayGrantTargets(workspaceId, body);
      if (targetError) {
        return reply.status(400).send({ error: targetError });
      }
      const previousGrants = await listRelayGrants(relay.id, workspaceId);

      const existing = await query<RelayGrantRow>(
        `SELECT *
         FROM mcp_relay_grants
         WHERE relay_id = $1
           AND workspace_id = $2
           AND grant_scope = $3
           AND conversation_id IS NOT DISTINCT FROM $4
           AND actor_id IS NOT DISTINCT FROM $5
           AND user_id IS NOT DISTINCT FROM $6
           AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 1`,
        [
          relay.id,
          workspaceId,
          body.grantScope,
          body.conversationId || null,
          body.actorId || null,
          body.userId || null,
        ],
      );

      if (existing.rows[0]) {
        return reply.send({ grant: mapRelayGrant(existing.rows[0]) });
      }

      const result = await query<RelayGrantRow>(
        `INSERT INTO mcp_relay_grants (
           relay_id, workspace_id, grant_scope, conversation_id, actor_id, user_id,
           status, granted_by, reason, metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9)
         RETURNING *`,
        [
          relay.id,
          workspaceId,
          body.grantScope,
          body.conversationId || null,
          body.actorId || null,
          body.userId || null,
          userId,
          body.reason || null,
          JSON.stringify(body.metadata || {}),
        ],
      );

      const nextGrants = await listRelayGrants(relay.id, workspaceId);
      const authzEntryIds = await enqueueAuthzRelationships(
        diffAuthzRelationships(
          buildRelayAuthzRelations(relay, previousGrants),
          buildRelayAuthzRelations(relay, nextGrants),
        ),
        {
          source: 'mcp_relay_grant.create',
          workspaceId,
          relayId: relay.id,
          grantId: result.rows[0].id,
        },
      );
      await flushQueuedAuthzEntries(authzEntryIds, 'mcp_relay_grant.create');
      await incrementMcpVersion(workspaceId);

      return reply.status(201).send({ grant: mapRelayGrant(result.rows[0]) });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  // POST /api/v1/workspaces/:workspaceId/mcp/relays/:id/grants/:grantId/revoke — Revoke relay grant
  app.post('/api/v1/workspaces/:workspaceId/mcp/relays/:id/grants/:grantId/revoke', { preHandler }, async (request, reply) => {
    try {
      const relay = await requireRelayPermission(
        request,
        reply,
        'grant',
        'Not allowed to manage grants for this relay',
      );
      if (!relay) return;

      const { workspaceId, grantId } = request.params as { workspaceId: string; grantId: string };
      const previousGrants = await listRelayGrants(relay.id, workspaceId);
      const result = await query<RelayGrantRow>(
        `UPDATE mcp_relay_grants
         SET status = 'revoked', revoked_at = NOW()
         WHERE id = $1
           AND relay_id = $2
           AND workspace_id = $3
           AND status = 'active'
         RETURNING *`,
        [grantId, relay.id, workspaceId],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Relay grant not found' });
      }

      const nextGrants = await listRelayGrants(relay.id, workspaceId);
      const authzEntryIds = await enqueueAuthzRelationships(
        diffAuthzRelationships(
          buildRelayAuthzRelations(relay, previousGrants),
          buildRelayAuthzRelations(relay, nextGrants),
        ),
        {
          source: 'mcp_relay_grant.revoke',
          workspaceId,
          relayId: relay.id,
          grantId,
        },
      );
      await flushQueuedAuthzEntries(authzEntryIds, 'mcp_relay_grant.revoke');
      await incrementMcpVersion(workspaceId);

      return reply.send({ grant: mapRelayGrant(result.rows[0]) });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  // DELETE /api/v1/workspaces/:workspaceId/mcp/relays/:id — Delete relay
  app.delete('/api/v1/workspaces/:workspaceId/mcp/relays/:id', { preHandler }, async (request, reply) => {
    try {
      const relay = await requireRelayPermission(
        request,
        reply,
        'delete',
        'Not allowed to delete this relay',
      );
      if (!relay) return;

      const { workspaceId, id } = request.params as any;
      const grants = await listRelayGrants(relay.id, workspaceId);

      // Force disconnect if connected
      disconnectRelay(id);

      const result = await query(
        `DELETE FROM mcp_relays WHERE id = $1 AND workspace_id = $2 RETURNING id`,
        [id, workspaceId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Relay not found' });
      }

      // Delete associated relay publisher (cascades to packages → bindings)
      const orgSlug = `relay_${id.slice(0, 8)}`;
      await query('DELETE FROM capability_publishers WHERE slug = $1', [orgSlug]);

      const authzEntryIds = await enqueueAuthzRelationships(
        diffAuthzRelationships(
          buildRelayAuthzRelations(relay, grants),
          [],
        ),
        {
          source: 'mcp_relay.delete',
          workspaceId,
          relayId: relay.id,
        },
      );
      await flushQueuedAuthzEntries(authzEntryIds, 'mcp_relay.delete');

      await incrementMcpVersion(workspaceId);

      return reply.send({ success: true });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  // PUT /api/v1/workspaces/:workspaceId/mcp/relays/:id — Update relay
  app.put('/api/v1/workspaces/:workspaceId/mcp/relays/:id', { preHandler }, async (request, reply) => {
    try {
      const authorizedRelay = await requireRelayPermission(
        request,
        reply,
        'edit',
        'Not allowed to edit this relay',
      );
      if (!authorizedRelay) return;

      const { workspaceId, id } = request.params as any;
      const body = updateRelaySchema.parse(request.body);

      const sets: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (body.name !== undefined) {
        sets.push(`name = $${idx++}`);
        values.push(body.name);
      }
      if (body.metadata !== undefined) {
        sets.push(`metadata = $${idx++}`);
        values.push(JSON.stringify(body.metadata));
      }

      if (sets.length === 0) {
        return reply.status(400).send({ error: 'No fields to update' });
      }

      values.push(id, workspaceId);
      const result = await query(
        `UPDATE mcp_relays SET ${sets.join(', ')} WHERE id = $${idx++} AND workspace_id = $${idx}
         RETURNING id, name, is_connected, metadata, updated_at`,
        values
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Relay not found' });
      }

      const relayRow = result.rows[0];
      return reply.send({
        id: relayRow.id,
        name: relayRow.name,
        isConnected: isRelayConnected(relayRow.id),
        metadata: relayRow.metadata,
        updatedAt: relayRow.updated_at,
      });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  // POST /api/v1/workspaces/:workspaceId/mcp/relays/:id/regenerate-token — Regenerate token
  app.post('/api/v1/workspaces/:workspaceId/mcp/relays/:id/regenerate-token', { preHandler }, async (request, reply) => {
    try {
      const authorizedRelay = await requireRelayPermission(
        request,
        reply,
        'rotate_token',
        'Not allowed to rotate this relay token',
      );
      if (!authorizedRelay) return;

      const { workspaceId, id } = request.params as any;

      // Force disconnect
      disconnectRelay(id);

      const newToken = crypto.randomBytes(32).toString('hex');

      const result = await query(
        `UPDATE mcp_relays SET auth_token = $1 WHERE id = $2 AND workspace_id = $3 RETURNING id, name`,
        [newToken, id, workspaceId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Relay not found' });
      }

      return reply.send({
        id: result.rows[0].id,
        name: result.rows[0].name,
        token: newToken, // Returned once
      });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  // GET /api/v1/workspaces/:workspaceId/mcp/relays/:id/servers — List servers for relay
  app.get('/api/v1/workspaces/:workspaceId/mcp/relays/:id/servers', { preHandler }, async (request, reply) => {
    try {
      const relay = await requireRelayPermission(
        request,
        reply,
        'view',
        'Not allowed to view this relay',
      );
      if (!relay) return;

      const { workspaceId, id } = request.params as any;

      const result = await query(
        `SELECT rs.id, rs.name, rs.transport, rs.tools_manifest, rs.is_enabled, rs.created_at, rs.updated_at,
           b.id as install_id,
           b.attachment_type,
           b.attachment_actor_id,
           b.attachment_conversation_id,
           b.attachment_user_id,
           b.reuse_scope,
           b.is_enabled as install_enabled
         FROM mcp_relay_servers rs
         LEFT JOIN capability_publishers pub ON pub.slug = $2
         LEFT JOIN capability_packages p
           ON p.publisher_id = pub.id
          AND p.kind = 'plugin'
          AND p.slug = LOWER(REGEXP_REPLACE(rs.name, '[^a-zA-Z0-9_-]', '_', 'g'))
          AND p.is_active = TRUE
         LEFT JOIN capability_package_revisions r ON r.id = p.latest_revision_id AND r.transport = 'relay'
         LEFT JOIN capability_instances b ON b.package_id = p.id AND b.workspace_id = $3
         WHERE rs.relay_id = $1 ORDER BY rs.name`,
        [id, `relay_${id.slice(0, 8)}`, workspaceId]
      );

      const servers = result.rows.map(r => ({
        id: r.id,
        name: r.name,
        transport: r.transport,
        toolsManifest: r.tools_manifest,
        isEnabled: r.is_enabled,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        installId: r.install_id || null,
        attachmentType: r.attachment_type || null,
        attachmentActorId: r.attachment_actor_id || null,
        attachmentConversationId: r.attachment_conversation_id || null,
        attachmentUserId: r.attachment_user_id || null,
        lifecycleScope: r.reuse_scope || null,
        installEnabled: r.install_enabled ?? null,
      }));

      return reply.send(servers);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  // PUT /api/v1/workspaces/:workspaceId/mcp/relays/:id/servers/:serverId — Toggle server enabled
  app.put('/api/v1/workspaces/:workspaceId/mcp/relays/:id/servers/:serverId', { preHandler }, async (request, reply) => {
    try {
      const relay = await requireRelayPermission(
        request,
        reply,
        'edit',
        'Not allowed to edit this relay',
      );
      if (!relay) return;

      const { workspaceId, id, serverId } = request.params as any;
      const { isEnabled } = request.body as any;

      if (typeof isEnabled !== 'boolean') {
        return reply.status(400).send({ error: 'isEnabled (boolean) is required' });
      }
      const result = await query(
        `UPDATE mcp_relay_servers SET is_enabled = $1 WHERE id = $2 AND relay_id = $3
         RETURNING id, name, is_enabled`,
        [isEnabled, serverId, id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Server not found' });
      }

      await incrementMcpVersion(workspaceId);

      return reply.send({
        id: result.rows[0].id,
        name: result.rows[0].name,
        isEnabled: result.rows[0].is_enabled,
      });
    } catch (error) {
      return handleError(reply, error);
    }
  });
}
