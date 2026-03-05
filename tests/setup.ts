/**
 * Test setup — runs before each test file.
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.NEXTAUTH_SECRET = 'test-secret-for-testing-only-minimum-16';
process.env.NEXTAUTH_URL = 'http://localhost:3000';
process.env.ENCRYPTION_KEY = 'test-encryption-key-at-least-16-chars-long';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/judgearena_test';
