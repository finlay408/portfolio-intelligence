import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A year of Trading 212 history is ~200 KB; the default 1 MB action body
  // would reject a multi-year export.
  experimental: { serverActions: { bodySizeLimit: '10mb' } },
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  // Both drivers must stay outside the bundle: postgres.js uses dynamic
  // requires, and PGlite ships a WASM payload that the bundler loses when it
  // rewrites the module into a vendor chunk.
  serverExternalPackages: ['postgres', '@electric-sql/pglite'],
  // Pin the trace root: a lockfile higher up the tree would otherwise be picked
  // as the workspace root and drag unrelated files into the build trace.
  outputFileTracingRoot: path.join(import.meta.dirname, '.'),
  // Pages merged into the five-tab layout. Temporary redirects, so a bookmark
  // or home-screen shortcut still lands somewhere sensible.
  async redirects() {
    return [
      { source: '/exposure', destination: '/positions#exposure', permanent: false },
      { source: '/rrg', destination: '/markets#rotation', permanent: false },
      { source: '/macro', destination: '/markets#macro', permanent: false },
      { source: '/watchlist', destination: '/', permanent: false },
      { source: '/options', destination: '/', permanent: false },
    ];
  },
};

export default nextConfig;
