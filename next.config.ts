import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  // Both drivers must stay outside the bundle: postgres.js uses dynamic
  // requires, and PGlite ships a WASM payload that the bundler loses when it
  // rewrites the module into a vendor chunk.
  serverExternalPackages: ['postgres', '@electric-sql/pglite'],
  // Pin the trace root: a lockfile higher up the tree would otherwise be picked
  // as the workspace root and drag unrelated files into the build trace.
  outputFileTracingRoot: path.join(import.meta.dirname, '.'),
};

export default nextConfig;
