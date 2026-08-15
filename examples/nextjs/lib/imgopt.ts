import { createImageClient, type ImageAsset } from '@imgopt/client';

/**
 * One client for the whole application.
 *
 * `encoderEpoch` must match `ENCODER_EPOCH` on the deployment. It is half of the
 * version segment, so a wrong value produces URLs that resolve to nothing — every
 * image breaks at once, which is at least unmistakable.
 */
export const imgopt = createImageClient({
  cdnHost: process.env['NEXT_PUBLIC_CDN_HOST'] ?? 'cdn.example.com',
  encoderEpoch: Number(process.env['NEXT_PUBLIC_ENCODER_EPOCH'] ?? 1),
});

/**
 * Stand-in for `GET /v1/images/:id`.
 *
 * The real application fetches this envelope from the control plane. Fixed data
 * here keeps the example runnable with no backend, and the shape is exactly what the
 * API returns.
 */
function fixture(id: string, width: number, height: number, color: string): ImageAsset {
  return {
    id,
    status: 'ready',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    altText: `Example asset ${id}`,
    tags: [],
    focalPoint: null,
    failureReason: null,
    source: {
      width,
      height,
      format: 'jpeg',
      bytes: '482915',
      hasAlpha: false,
      dominantColor: color,
    },
    // A real LQIP is a ~24px WebP stored on the asset version and delivered inline
    // with the metadata, so blur-up costs no additional request.
    lqip: null,
    urls: { base: '', src: '', srcset: '' },
  };
}

export const heroAsset = fixture('hero01', 3000, 1688, '#2f4858');

export const galleryAssets = [
  fixture('gal001', 2400, 1600, '#8c5a3c'),
  fixture('gal002', 1800, 1800, '#3c8c5a'),
  fixture('gal003', 2000, 1333, '#5a3c8c'),
  fixture('gal004', 1600, 2400, '#8c3c5a'),
  fixture('gal005', 2200, 1467, '#3c5a8c'),
  fixture('gal006', 1920, 1080, '#5a8c3c'),
];

export const avatarAssets = [
  fixture('ava001', 512, 512, '#c46b4a'),
  fixture('ava002', 400, 400, '#4ac46b'),
  fixture('ava003', 128, 128, '#6b4ac4'),
  // Deliberately smaller than the smallest ladder rung, to show the candidate set
  // collapsing to the source's own width rather than offering an upscale.
  fixture('ava004', 12, 12, '#c44a6b'),
];
