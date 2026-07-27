/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Moved out of experimental in Next.js 14
  serverExternalPackages: ['@prisma/client'],
  eslint: {
    // `next build`'s built-in lint step only strips legacy ESLint options
    // (useEslintrc/extensions) when it detects ESLint >=9 *and* flat config;
    // this repo is ESLint 8.57 + flat config (eslint.config.mjs), a
    // combination it doesn't handle, so it hands those legacy options to
    // ESLint 8's flat-mode `ESLint` class, which rejects them ("Unknown
    // options: useEslintrc, extensions"). `npm run lint` (run as its own
    // step in CI and locally) already covers this codebase with the same
    // config, so skip the redundant, currently-broken in-build pass rather
    // than force an ESLint 9 migration for this platform-upgrade task.
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
