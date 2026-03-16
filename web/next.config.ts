import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['tesseract.js', 'tesseract.js-core', '@napi-rs/canvas']
};

export default nextConfig;
