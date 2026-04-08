/**
 * ─── Encryption Utilities ──────────────────────────────────────────────────
 *
 * AES-256-GCM encryption for sensitive data at rest (LLM API keys).
 * Uses a 32-byte key derived from the ENCRYPTION_KEY environment variable.
 *
 * Format: enc:v1:<iv>:<authTag>:<ciphertext> (all hex-encoded)
 *
 * The "enc:v1:" prefix eliminates ambiguity between encrypted and plaintext
 * values, preventing false positives that could leave keys unencrypted.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
/** NIST SP 800-38D recommends 12-byte (96-bit) IVs for AES-GCM */
const IV_LENGTH = 12;
const ENCRYPTED_PREFIX = 'enc:v1:';

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
 * Returns: enc:v1:<iv>:<authTag>:<ciphertext> (hex-encoded).
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a string encrypted with encrypt().
 * Accepts both new format (enc:v1:<iv>:<authTag>:<ciphertext>)
 * and legacy format (<iv>:<authTag>:<ciphertext>) for migration.
 */
export function decrypt(encryptedText: string): string {
  const key = getEncryptionKey();

  let ivHex: string, authTagHex: string, ciphertext: string;

  if (encryptedText.startsWith(ENCRYPTED_PREFIX)) {
    // New format: enc:v1:<iv>:<authTag>:<ciphertext>
    const payload = encryptedText.slice(ENCRYPTED_PREFIX.length);
    const parts = payload.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted text format (v1)');
    }
    [ivHex, authTagHex, ciphertext] = parts;
  } else {
    // Legacy format: <iv>:<authTag>:<ciphertext>
    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted text format (legacy)');
    }
    [ivHex, authTagHex, ciphertext] = parts;
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Check if a string is encrypted using the tagged format.
 * Also detects legacy format (hex:hex:hex) for backward compatibility.
 */
export function isEncrypted(value: string): boolean {
  if (value.startsWith(ENCRYPTED_PREFIX)) return true;
  // Legacy detection: exactly 3 hex segments, and the first segment is
  // exactly 32 hex chars (16-byte IV) or 24 hex chars (12-byte IV)
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  const [iv, tag] = parts;
  return (
    (iv.length === 32 || iv.length === 24) &&
    tag.length === 32 && // GCM auth tag is always 16 bytes = 32 hex chars
    /^[0-9a-f]+$/i.test(parts.join(''))
  );
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
 * Logs a warning on decryption failure to aid debugging key rotation issues.
 */
export function decryptSafe(value: string): string {
  if (!isEncrypted(value)) return value;
  try {
    return decrypt(value);
  } catch (error) {
    console.error(
      '[crypto] Decryption failed — this may indicate a rotated ENCRYPTION_KEY or corrupted data. ' +
      'The raw (encrypted) value will be passed through, which will likely cause an auth error downstream.',
      error instanceof Error ? error.message : error
    );
    return value;
  }
}
