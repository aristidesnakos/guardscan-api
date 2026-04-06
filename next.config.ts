import type { NextConfig } from 'next';

const config: NextConfig = {
  experimental: {
    // App Router is default in Next 16
  },
  logging: {
    fetches: {
      fullUrl: true,
    },
  },
};

export default config;
