import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Pin the tracing root to this package so Next does not walk up to a
  // non-existent monorepo root when producing the standalone output.
  outputFileTracingRoot: __dirname,
  // `pg` is a server-only dependency used by instrumentation and route
  // handlers; keep it external so Next does not try to bundle its native bits.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
