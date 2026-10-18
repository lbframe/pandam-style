import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import { withPandamStyle } from '@pandamstyle/next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: { typedRoutes: true },
};

export default (phase: string) =>
  withPandamStyle({
    backend: 'turbopack',
    publicationMode: 'semantic-dev',
    definition: './design.pandamstyle.config.mjs',
    roots: ['./components/ui'],
  })(nextConfig);
