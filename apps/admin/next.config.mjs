/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

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
