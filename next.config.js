/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Moved out of experimental in Next.js 14
  serverExternalPackages: ['@prisma/client'],
};

module.exports = nextConfig;
