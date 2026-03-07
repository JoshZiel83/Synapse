import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { query } from '../database/index.js';

export function auditMiddleware(app: FastifyInstance) {
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    // Only audit mutating requests
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;

    const action = deriveAction(request.method, request.url);
    if (!action) return;

    try {
      await query(
        `INSERT INTO audit_logs (workspace_id, user_id, action, resource_type, resource_id, details, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          (request.params as any)?.workspaceId || null,
          (request as any).user?.userId || null,
          action,
          deriveResourceType(request.url),
          (request.params as any)?.id || null,
          JSON.stringify({ method: request.method, url: request.url, statusCode: reply.statusCode }),
          request.ip,
        ]
      );
    } catch (err) {
      console.error('Audit log insert failed:', (err as Error).message);
    }
  });
}

function deriveAction(method: string, url: string): string | null {
  const segments = url.split('/').filter(Boolean);
  const resource = segments.find(s => !s.match(/^[0-9a-f-]{36}$/i) && s !== 'api' && s !== 'v1');
  if (!resource) return null;

  const actionMap: Record<string, string> = {
    POST: 'create',
    PUT: 'update',
    PATCH: 'update',
    DELETE: 'delete',
  };

  return `${resource}.${actionMap[method] || method.toLowerCase()}`;
}

function deriveResourceType(url: string): string {
  const segments = url.split('/').filter(Boolean);
  return segments.find(s => !s.match(/^[0-9a-f-]{36}$/i) && s !== 'api' && s !== 'v1') || 'unknown';
}
