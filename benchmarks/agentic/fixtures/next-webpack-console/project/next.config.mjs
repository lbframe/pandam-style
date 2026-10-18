import { withPandamStyle } from '@pandamstyle/next';

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default withPandamStyle({
  backend: 'webpack',
  definition: './design.pandamstyle.config.mjs',
  roots: ['./app', './components'],
})(nextConfig);
