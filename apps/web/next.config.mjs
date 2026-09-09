import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRootEnv } from '../../scripts/load-root-env.mjs';

// The root `.env` is the file `.env.example` tells you to copy; Next would
// otherwise only read `apps/web/.env`. No-op when there is no file.
loadRootEnv();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Standalone bundles the server and only the files it traced into
   * `.next/standalone`, so the runtime image needs no node_modules and no
   * package manager. `outputFileTracingRoot` has to point at the workspace
   * root: without it Next traces from `apps/web` and misses the symlinked
   * @levelup/* packages entirely, producing an image that builds cleanly and
   * crashes on first request.
   */
  output: 'standalone',
  outputFileTracingRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),

  transpilePackages: ['@levelup/db', '@levelup/engine', '@levelup/provider', '@levelup/shared'],
  serverExternalPackages: ['postgres'],

  // Workspace packages import with explicit `.js` specifiers, which is correct
  // ESM. Webpack does not map those to the `.ts` sources without being told.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },

  // Traffic arrives from TikTok, Instagram and WhatsApp on phones, so the
  // images are the page weight that matters.
  images: { formats: ['image/avif', 'image/webp'] },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        // Order pages carry a player ID in the URL; keep them out of indexes
        // and out of any shared cache.
        source: '/pedido/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'private, no-store' },
        ],
      },
    ];
  },
};

export default nextConfig;
