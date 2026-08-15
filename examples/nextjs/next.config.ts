import type { NextConfig } from 'next';

/**
 * `loader: 'custom'` takes image optimization out of this application entirely.
 *
 * Without it, `next/image` runs its own optimizer inside the Next.js server — per
 * request, on a serverless deployment — which is precisely the work this service
 * exists to do once and cache forever.
 *
 * `deviceSizes` and `imageSizes` come from the SDK rather than being written out
 * here. Next asks the loader for widths from these lists; Next's defaults include
 * values like 384 and 1200, which are not buckets. Nothing breaks when they differ —
 * the edge snaps the width — but the `srcset` descriptor then advertises a width the
 * stored object does not have, so the browser chooses using a wrong number.
 */
const config: NextConfig = {
  images: {
    loader: 'custom',
    loaderFile: './lib/loader.ts',
    deviceSizes: [320, 480, 640, 750, 828, 960, 1080, 1200, 1440, 1920, 2560, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 192, 256],
  },
};

export default config;
