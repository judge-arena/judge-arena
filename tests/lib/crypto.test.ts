import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, isEncrypted, encryptIfNeeded, decryptSafe } from '@/lib/crypto';

describe('crypto', () => {
  describe('encrypt / decrypt', () => {
    it('should encrypt and decrypt a string round-trip', () => {
      const plaintext = 'sk-ant-api03-my-secret-key-12345';
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertexts for the same input (random IV)', () => {
      const plaintext = 'test-api-key';
      const encrypted1 = encrypt(plaintext);
      const encrypted2 = encrypt(plaintext);
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should handle empty strings', () => {
      const encrypted = encrypt('');
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe('');
    });

    it('should handle unicode strings', () => {
      const plaintext = 'key-with-émojis-🔑-and-日本語';
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle long strings', () => {
      const plaintext = 'a'.repeat(10000);
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should throw on invalid encrypted format', () => {
      expect(() => decrypt('not-valid')).toThrow();
    });

    it('should throw on tampered ciphertext', () => {
      const encrypted = encrypt('secret');
      const parts = encrypted.split(':');
      parts[2] = 'deadbeef'; // tamper with ciphertext
      expect(() => decrypt(parts.join(':'))).toThrow();
    });
  });

  describe('isEncrypted', () => {
    it('should return true for encrypted format (hex:hex:hex)', () => {
      const encrypted = encrypt('test');
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it('should return false for plaintext', () => {
      expect(isEncrypted('sk-ant-api03-plain-key')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isEncrypted('')).toBe(false);
    });
  });

  describe('encryptIfNeeded', () => {
    it('should encrypt plaintext', () => {
      const plaintext = 'my-api-key';
      const result = encryptIfNeeded(plaintext);
      expect(isEncrypted(result)).toBe(true);
      expect(decrypt(result)).toBe(plaintext);
    });

    it('should not double-encrypt', () => {
      const plaintext = 'my-api-key';
      const encrypted = encrypt(plaintext);
      const result = encryptIfNeeded(encrypted);
      expect(result).toBe(encrypted); // unchanged
    });
  });

  describe('decryptSafe', () => {
    it('should decrypt encrypted values', () => {
      const encrypted = encrypt('secret');
      expect(decryptSafe(encrypted)).toBe('secret');
    });

    it('should return plaintext values unchanged', () => {
      expect(decryptSafe('plaintext-key')).toBe('plaintext-key');
    });
  });
});
