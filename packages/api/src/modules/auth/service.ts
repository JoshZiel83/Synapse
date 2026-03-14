import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { config } from '../../config/index.js';
import { query } from '../../infrastructure/database/index.js';
import { redis } from '../../infrastructure/redis/index.js';
import type { FastifyInstance } from 'fastify';
import type { User, AuthTokens } from '@synapse/shared';
import { ensureConfiguredPlatformAdminForUser } from '../platform/admin-service.js';

const SALT_ROUNDS = 10;
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

function mapUserRow(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

async function storeRefreshToken(token: string, userId: string): Promise<void> {
  await redis.set(`refresh:${token}`, userId, 'EX', REFRESH_TOKEN_TTL);
}

async function revokeRefreshToken(token: string): Promise<void> {
  await redis.del(`refresh:${token}`);
}

async function resolveRefreshToken(token: string): Promise<string | null> {
  return redis.get(`refresh:${token}`);
}

export function createAuthService(app: FastifyInstance) {
  function generateAccessToken(userId: string, email: string): string {
    return app.jwt.sign({ userId, email }, { expiresIn: config.jwt.accessExpiry });
  }

  async function generateTokens(userId: string, email: string): Promise<AuthTokens> {
    const accessToken = generateAccessToken(userId, email);
    const refreshToken = generateRefreshToken();
    await storeRefreshToken(refreshToken, userId);
    return { accessToken, refreshToken };
  }

  async function register(
    email: string,
    password: string,
    name: string,
  ): Promise<{ user: User; tokens: AuthTokens }> {
    // Check if user already exists
    const existing = await query<UserRow>(
      'SELECT id FROM users WHERE email = $1',
      [email],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      throw new AuthError('A user with this email already exists', 409);
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await query<UserRow>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, avatar_url, password_hash, created_at, updated_at`,
      [email, passwordHash, name],
    );

    const user = mapUserRow(result.rows[0]);
    await ensureConfiguredPlatformAdminForUser({ id: user.id, email: user.email });
    const tokens = await generateTokens(user.id, user.email);

    return { user, tokens };
  }

  async function login(
    email: string,
    password: string,
  ): Promise<{ user: User; tokens: AuthTokens }> {
    const result = await query<UserRow>(
      `SELECT id, email, name, avatar_url, password_hash, created_at, updated_at
       FROM users WHERE email = $1`,
      [email],
    );

    if (!result.rowCount || result.rowCount === 0) {
      throw new AuthError('Invalid email or password', 401);
    }

    const row = result.rows[0];
    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) {
      throw new AuthError('Invalid email or password', 401);
    }

    const user = mapUserRow(row);
    await ensureConfiguredPlatformAdminForUser({ id: user.id, email: user.email });
    const tokens = await generateTokens(user.id, user.email);

    return { user, tokens };
  }

  async function refreshTokens(refreshToken: string): Promise<AuthTokens> {
    const userId = await resolveRefreshToken(refreshToken);
    if (!userId) {
      throw new AuthError('Invalid or expired refresh token', 401);
    }

    // Revoke the old token (rotation)
    await revokeRefreshToken(refreshToken);

    // Fetch user to get email for new access token
    const result = await query<UserRow>(
      'SELECT id, email FROM users WHERE id = $1',
      [userId],
    );

    if (!result.rowCount || result.rowCount === 0) {
      throw new AuthError('User not found', 401);
    }

    const { id, email } = result.rows[0];
    return generateTokens(id, email);
  }

  async function getProfile(userId: string): Promise<User> {
    const result = await query<UserRow>(
      `SELECT id, email, name, avatar_url, password_hash, created_at, updated_at
       FROM users WHERE id = $1`,
      [userId],
    );

    if (!result.rowCount || result.rowCount === 0) {
      throw new AuthError('User not found', 404);
    }

    return mapUserRow(result.rows[0]);
  }

  async function updateProfile(userId: string, input: { name?: string; avatarUrl?: string | null }): Promise<User> {
    const current = await getProfile(userId);
    const nextName = input.name === undefined ? current.name : input.name.trim();
    const nextAvatarUrl = input.avatarUrl === undefined ? current.avatarUrl ?? null : input.avatarUrl;

    const result = await query<UserRow>(
      `UPDATE users
       SET name = $2,
           avatar_url = $3,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, avatar_url, password_hash, created_at, updated_at`,
      [userId, nextName, nextAvatarUrl ?? null],
    );

    if (!result.rowCount || result.rowCount === 0) {
      throw new AuthError('User not found', 404);
    }

    return mapUserRow(result.rows[0]);
  }

  return { register, login, refreshTokens, getProfile, updateProfile };
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
