import crypto from 'crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
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

// ============ Error helper ============

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    return reply.status(400).send({ error: 'Validation error', details: error.errors });
  }
  console.error('[Relay Controller]', error);
  return reply.status(500).send({ error: 'Internal server error' });
}

// ============ Route registration ============

export function registerRelayRoutes(app: FastifyInstance) {
  const preHandler = [authMiddleware, workspaceMiddleware];

  // POST /api/v1/workspaces/:workspaceId/mcp/relays — Create relay
  app.post('/api/v1/workspaces/:workspaceId/mcp/relays', { preHandler }, async (request, reply) => {
    try {
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

      const result = await query(
        `SELECT id, name, is_connected, last_connected_at, metadata, created_at, updated_at
         FROM mcp_relays WHERE workspace_id = $1 ORDER BY created_at DESC`,
        [workspaceId]
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

  // DELETE /api/v1/workspaces/:workspaceId/mcp/relays/:id — Delete relay
  app.delete('/api/v1/workspaces/:workspaceId/mcp/relays/:id', { preHandler }, async (request, reply) => {
    try {
      const { workspaceId, id } = request.params as any;

      // Force disconnect if connected
      disconnectRelay(id);

      const result = await query(
        `DELETE FROM mcp_relays WHERE id = $1 AND workspace_id = $2 RETURNING id`,
        [id, workspaceId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Relay not found' });
      }

      // Delete associated relay org (cascades to plugins → installations)
      const orgSlug = `relay_${id.slice(0, 8)}`;
      await query('DELETE FROM mcp_organizations WHERE slug = $1', [orgSlug]);

      await incrementMcpVersion(workspaceId);

      return reply.send({ success: true });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  // PUT /api/v1/workspaces/:workspaceId/mcp/relays/:id — Update relay
  app.put('/api/v1/workspaces/:workspaceId/mcp/relays/:id', { preHandler }, async (request, reply) => {
    try {
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

      const relay = result.rows[0];
      return reply.send({
        id: relay.id,
        name: relay.name,
        isConnected: isRelayConnected(relay.id),
        metadata: relay.metadata,
        updatedAt: relay.updated_at,
      });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  // POST /api/v1/workspaces/:workspaceId/mcp/relays/:id/regenerate-token — Regenerate token
  app.post('/api/v1/workspaces/:workspaceId/mcp/relays/:id/regenerate-token', { preHandler }, async (request, reply) => {
    try {
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
      const { workspaceId, id } = request.params as any;

      // Verify relay belongs to workspace
      const relayCheck = await query(
        `SELECT id FROM mcp_relays WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId]
      );
      if (relayCheck.rows.length === 0) {
        return reply.status(404).send({ error: 'Relay not found' });
      }

      const result = await query(
        `SELECT rs.id, rs.name, rs.transport, rs.tools_manifest, rs.is_enabled, rs.created_at, rs.updated_at,
           i.id as install_id, i.scope_type, i.scope_id, i.lifecycle_scope, i.is_enabled as install_enabled
         FROM mcp_relay_servers rs
         LEFT JOIN mcp_organizations o ON o.slug = $2
         LEFT JOIN mcp_plugins p ON p.org_id = o.id AND p.slug = LOWER(REGEXP_REPLACE(rs.name, '[^a-zA-Z0-9_-]', '_', 'g')) AND p.transport = 'relay'
         LEFT JOIN mcp_installations i ON i.plugin_id = p.id AND i.workspace_id = $3
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
        scopeType: r.scope_type || null,
        scopeId: r.scope_id || null,
        lifecycleScope: r.lifecycle_scope || null,
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
      const { workspaceId, id, serverId } = request.params as any;
      const { isEnabled } = request.body as any;

      if (typeof isEnabled !== 'boolean') {
        return reply.status(400).send({ error: 'isEnabled (boolean) is required' });
      }

      // Verify relay belongs to workspace
      const relayCheck = await query(
        `SELECT id FROM mcp_relays WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId]
      );
      if (relayCheck.rows.length === 0) {
        return reply.status(404).send({ error: 'Relay not found' });
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
