import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['tesseract.js', 'tesseract.js-core', '@napi-rs/canvas']
};

export default nextConfig;
