'use client';

import { createNextLoader } from '@imgopt/client/next';

/**
 * The custom loader Next calls for every `next/image`.
 *
 * Must be a default export from its own file: `loaderFile` in next.config points
 * here, and Next inlines it into both the server and client bundles.
 */
const loader = createNextLoader({
  cdnHost: process.env['NEXT_PUBLIC_CDN_HOST'] ?? 'cdn.example.com',
  encoderEpoch: Number(process.env['NEXT_PUBLIC_ENCODER_EPOCH'] ?? 1),
});

export default loader;
