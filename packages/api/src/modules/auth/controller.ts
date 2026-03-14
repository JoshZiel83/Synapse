import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createAuthService, AuthError } from './service.js';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1, 'Name is required').max(100),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

const updateMeSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  avatarUrl: z.string().min(1).nullable().optional(),
}).refine((body) => body.name !== undefined || body.avatarUrl !== undefined, {
  message: 'At least one field is required',
});

function handleAuthError(error: unknown, reply: FastifyReply) {
  if (error instanceof AuthError) {
    return reply.status(error.statusCode).send({ error: error.message });
  }
  if (error instanceof z.ZodError) {
    return reply.status(400).send({
      error: 'Validation failed',
      details: error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
  }
  throw error;
}

export function registerAuthRoutes(app: FastifyInstance) {
  const authService = createAuthService(app);

  app.post('/api/v1/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = registerSchema.parse(request.body);
      const result = await authService.register(body.email, body.password, body.name);
      return reply.status(201).send(result);
    } catch (error) {
      return handleAuthError(error, reply);
    }
  });

  app.post('/api/v1/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = loginSchema.parse(request.body);
      const result = await authService.login(body.email, body.password);
      return reply.status(200).send(result);
    } catch (error) {
      return handleAuthError(error, reply);
    }
  });

  app.post('/api/v1/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = refreshSchema.parse(request.body);
      const tokens = await authService.refreshTokens(body.refreshToken);
      return reply.status(200).send({ tokens });
    } catch (error) {
      return handleAuthError(error, reply);
    }
  });

  app.get(
    '/api/v1/auth/me',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await authService.getProfile((request as any).user!.userId);
        return reply.status(200).send({ user });
      } catch (error) {
        return handleAuthError(error, reply);
      }
    },
  );

  app.put(
    '/api/v1/auth/me',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = updateMeSchema.parse(request.body);
        const user = await authService.updateProfile((request as any).user!.userId, {
          name: body.name,
          avatarUrl: body.avatarUrl,
        });
        return reply.status(200).send({ user });
      } catch (error) {
        return handleAuthError(error, reply);
      }
    },
  );
}
