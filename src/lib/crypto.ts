/**
 * ─── Encryption Utilities ──────────────────────────────────────────────────
 *
 * AES-256-GCM encryption for sensitive data at rest (LLM API keys).
 * Uses a 32-byte key derived from the ENCRYPTION_KEY environment variable.
 *
 * Format: <iv>:<authTag>:<ciphertext> (all hex-encoded)
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a 32-byte key from the ENCRYPTION_KEY env var.
 * Uses SHA-256 to ensure consistent key length regardless of input.
 */
function getEncryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY environment variable is required for API key encryption. ' +
      'Generate one with: openssl rand -hex 32'
    );
  }
  return createHash('sha256').update(raw).digest();
}

/**
 * Encrypt a plaintext string.
 * Returns a string in the format: iv:authTag:ciphertext (hex-encoded).
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a string encrypted with encrypt().
 * Input format: iv:authTag:ciphertext (hex-encoded).
 */
export function decrypt(encryptedText: string): string {
  const key = getEncryptionKey();
  const parts = encryptedText.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format');
  }

  const [ivHex, authTagHex, ciphertext] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Check if a string looks like it's already encrypted (hex:hex:hex format).
 */
export function isEncrypted(value: string): boolean {
  return /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(value);
}

/**
 * Encrypt a value only if it's not already encrypted.
 * Useful during migration from plaintext to encrypted storage.
 */
export function encryptIfNeeded(value: string): string {
  if (isEncrypted(value)) return value;
  return encrypt(value);
}

/**
 * Safely decrypt a value, returning the original if decryption fails.
 * Handles the transition period where some values may still be plaintext.
 */
export function decryptSafe(value: string): string {
  if (!isEncrypted(value)) return value;
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}
