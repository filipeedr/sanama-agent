import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['tesseract.js', 'tesseract.js-core', '@napi-rs/canvas'],
  outputFileTracingIncludes: {
    '/api/**': [
      './node_modules/tesseract.js/**/*',
      './node_modules/tesseract.js-core/**/*',
      './tessdata/**/*'
    ]
  }
};

export default nextConfig;
