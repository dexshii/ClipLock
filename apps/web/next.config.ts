import type { NextConfig } from 'next';

const api = process.env.CLIPLOCK_API_URL ?? 'http://localhost:8080';

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@cliplock/shared'],
  // One public origin: in production a reverse proxy routes /media and /v1 to the
  // API (see infrastructure/Caddyfile); in development Next forwards them.
  async rewrites() {
    return [
      { source: '/media/:path*', destination: `${api}/media/:path*` },
      { source: '/v1/:path*', destination: `${api}/v1/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        // Everything except the embeddable player must not be framed.
        source: '/((?!embed/).*)',
        headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
      },
    ];
  },
};

export default config;
