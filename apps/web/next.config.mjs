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
   * Next's Server Actions default to a 1MB request body, which is smaller
   * than a single phone photo — checkout's own comprobante upload validates
   * up to `MAX_UPLOAD_BYTES` (8MB, packages/shared/src/upload.ts) but never
   * got the chance: the framework rejected anything over 1MB before that
   * validation ran, surfacing as a generic "Algo salió mal" error boundary
   * with no indication it was a size limit. Set above 8MB for multipart
   * encoding overhead.
   */
  experimental: { serverActions: { bodySizeLimit: '10mb' } },

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

  transpilePackages: [
    '@levelup/db',
    '@levelup/engine',
    '@levelup/payments',
    '@levelup/provider',
    '@levelup/shared',
  ],
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
