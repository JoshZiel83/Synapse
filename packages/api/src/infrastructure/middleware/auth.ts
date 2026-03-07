import type { FastifyRequest, FastifyReply } from 'fastify';
import type { JWTPayload } from '@synapse/shared';

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.slice(7);
    const decoded = await request.server.jwt.verify<JWTPayload>(token);
    (request as any).user = decoded;
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

export async function optionalAuth(request: FastifyRequest) {
  try {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      (request as any).user = await request.server.jwt.verify<JWTPayload>(token);
    }
  } catch {
    // ignore - auth is optional
  }
}

export function getUserId(request: FastifyRequest): string {
  return (request as any).user?.userId;
}
