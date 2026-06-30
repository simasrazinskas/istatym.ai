import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Ensure the corpus JSON (imported from src/lib) is traced into the
  // standalone server output. The import in src/lib/corpus.ts already pulls it
  // into the trace, but we pin the tracing root to this package to avoid Next
  // walking up to a non-existent monorepo root.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
