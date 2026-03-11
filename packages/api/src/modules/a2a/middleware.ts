import type { FastifyRequest, FastifyReply } from 'fastify';
import { authenticateApiKey } from './service.js';
import { A2A_API_KEY_HEADER } from '@synapse/shared';
import { redis } from '../../infrastructure/redis/index.js';

export async function a2aAuthMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers[A2A_API_KEY_HEADER] as string;
  if (!apiKey) {
    return reply.status(401).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Missing API key' },
      id: null,
    });
  }

  const result = await authenticateApiKey(apiKey);
  if (!result) {
    return reply.status(401).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid API key' },
      id: null,
    });
  }

  (request as any).a2aApp = result.app;
  (request as any).a2aWorkspaceId = result.workspaceId;
}

export async function a2aRateLimitMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const app = (request as any).a2aApp;
  if (!app) return;

  const key = `a2a:ratelimit:${app.id}`;
  const now = Date.now();
  const windowMs = 60_000;

  const pipe = (redis as any).pipeline();
  pipe.zremrangebyscore(key, 0, now - windowMs);
  pipe.zadd(key, now, `${now}:${Math.random()}`);
  pipe.zcard(key);
  pipe.expire(key, 120);
  const results = await pipe.exec();

  const count = results?.[2]?.[1] as number;
  if (count > app.rateLimitRpm) {
    return reply.status(429).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Rate limit exceeded' },
      id: null,
    });
  }
}
