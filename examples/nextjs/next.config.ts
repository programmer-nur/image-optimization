import type { NextConfig } from 'next';
import { DEVICE_WIDTHS, ICON_WIDTHS } from '@imgopt/client';

/**
 * `loader: 'custom'` takes image optimization out of this application entirely.
 *
 * Without it, `next/image` runs its own optimizer inside the Next.js server — per
 * request, on a serverless deployment — which is precisely the work this service
 * exists to do once and cache forever.
 *
 * `deviceSizes` and `imageSizes` are imported from the SDK rather than written out
 * here, which is the whole point of the SDK exporting them. Next asks the loader for
 * widths from these lists; Next's own defaults include values like 384 and 3840-with-
 * gaps that are not buckets. Nothing breaks when they differ — the edge snaps the
 * width — but the `srcset` descriptor then advertises a width the stored object does
 * not have, so the browser chooses using a wrong number.
 *
 * They were previously transcribed as literals, which meant this example would keep
 * claiming the old ladder after the ladder changed, and would say so in a comment
 * asserting the opposite. `readonly number[]` from the SDK is copied into a mutable
 * array because that is the type Next's config demands.
 */
const config: NextConfig = {
  images: {
    loader: 'custom',
    loaderFile: './lib/loader.ts',
    deviceSizes: [...DEVICE_WIDTHS],
    imageSizes: [...ICON_WIDTHS],
  },
};

export default config;
