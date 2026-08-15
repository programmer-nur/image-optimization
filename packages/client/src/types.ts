/**
 * The API's asset envelope, as consumers receive it.
 *
 * Structurally mirrors `AssetResponse` in the control plane rather than importing it:
 * `apps/api` pulls in NestJS, Prisma, and the AWS SDK, none of which belong in a
 * browser bundle. The shape is a wire contract, and the e2e tests are what hold the
 * two ends together.
 */

export interface ImageSource {
  width: number | null;
  height: number | null;
  format: string | null;
  /** A string because JSON has no BigInt and narrowing would corrupt large values. */
  bytes: string | null;
  hasAlpha: boolean | null;
  dominantColor: string | null;
}

export interface ImageAsset {
  id: string;
  status: string;
  version: number;
  createdAt: string;
  altText: string | null;
  tags: string[];
  focalPoint: unknown;
  failureReason: string | null;
  source: ImageSource | null;
  /** Base64 WebP, inlined for blur-up. Costs no request; see design.md D6. */
  lqip: string | null;
  urls: { base: string; src: string; srcset: string } | null;
}

/** Whether an asset has finished processing and can be rendered. */
export function isReady(asset: ImageAsset): boolean {
  return asset.status === 'ready' && asset.urls !== null;
}
