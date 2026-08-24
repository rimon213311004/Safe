import type { NextConfig } from 'next';

/**
 * The API runs as a separate process on its own port. Rather than pointing the
 * browser at it directly, every `/api/*` request is proxied through Next.
 *
 * That is not a convenience — it is what makes the auth design work. The refresh
 * token is an httpOnly cookie the API scopes to path `/api/auth`. Proxying keeps
 * it a first-party, same-origin cookie: no CORS preflight on every call, no
 * `SameSite` edge cases between :3000 and :4000, and nothing to reconfigure when
 * the API moves behind a gateway in production.
 *
 * Set `NEXT_PUBLIC_API_BASE_URL` to an absolute URL if you would rather have the
 * browser talk to the API directly; the client honours it and this proxy then
 * goes unused. You will need the API's `WEB_ORIGIN` to match this origin exactly,
 * because it sends `Access-Control-Allow-Credentials`.
 */
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiTarget}/api/:path*` }];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // The client never renders third-party HTML and never embeds anything,
          // so the strictest framing and referrer policies cost us nothing.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // A search result concerns someone who is not the person looking. Keep
          // it out of shared caches and out of prefetch heuristics.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
