/**
 * Test setup — runs before each test file.
 */

// Set test environment variables
Object.assign(process.env, {
	NODE_ENV: 'test',
	NEXTAUTH_SECRET: 'test-secret-for-testing-only-minimum-16',
	NEXTAUTH_URL: 'http://localhost:3000',
	ENCRYPTION_KEY: 'test-encryption-key-at-least-16-chars-long',
	DATABASE_URL: 'postgresql://test:test@localhost:5432/judgearena_test',
});
