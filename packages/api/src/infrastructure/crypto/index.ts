import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const ENCRYPTED_PREFIX = 'enc:';

function getEncryptionKey(): Buffer {
  const keySource = process.env.MCP_ENCRYPTION_KEY || process.env.JWT_SECRET || 'default-dev-key-change-in-production';
  return createHash('sha256').update(keySource).digest();
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedValue: string): string {
  if (!encryptedValue.startsWith(ENCRYPTED_PREFIX)) {
    return encryptedValue;
  }

  const key = getEncryptionKey();
  const parts = encryptedValue.slice(ENCRYPTED_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format');
  }

  const [ivHex, authTagHex, ciphertext] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

export function encryptSensitiveFields(
  config: Record<string, unknown>,
  schema: Record<string, unknown>
): Record<string, unknown> {
  if (!schema || !config) return config;

  const properties = (schema as any).properties as Record<string, any> | undefined;
  if (!properties) return config;

  const result = { ...config };

  for (const [key, value] of Object.entries(result)) {
    if (
      properties[key]?.sensitive === true &&
      typeof value === 'string' &&
      value.length > 0 &&
      !value.startsWith(ENCRYPTED_PREFIX)
    ) {
      result[key] = encrypt(value);
    }
  }

  return result;
}

export function decryptSensitiveFields(
  config: Record<string, unknown>
): Record<string, unknown> {
  if (!config) return config;

  const result = { ...config };

  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX)) {
      try {
        result[key] = decrypt(value);
      } catch {
        // If decryption fails, leave the value as-is
        // This can happen if the encryption key changed
      }
    }
  }

  return result;
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}
