import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRootEnv } from '../../scripts/load-root-env.mjs';

// The root `.env` is the file `.env.example` tells you to copy; Next would
// otherwise only read `apps/admin/.env`. No-op when there is no file.
loadRootEnv();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // See the storefront's config: tracing must start at the workspace root or
  // the symlinked @levelup/* packages are left out of the standalone bundle.
  output: 'standalone',
  outputFileTracingRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),

  // Workspace packages ship TypeScript source rather than a build artifact,
  // so Next has to compile them alongside the app.
  transpilePackages: ['@levelup/db', '@levelup/engine', '@levelup/provider', '@levelup/shared'],

  // postgres.js is a native-ish driver; bundling it into the server build
  // breaks its dynamic requires.
  serverExternalPackages: ['postgres'],

  /**
   * The workspace packages import with explicit `.js` specifiers, which is what
   * ESM requires and what lets Node run them directly. Webpack does not map
   * those back to the `.ts` sources on its own, so tell it to.
   */
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },

  // The panel is internal and handles payment approvals — it should never be
  // indexed or embedded anywhere.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
