/**
 * Response shaping.
 *
 * One place that turns domain rows into the public JSON envelope, so every endpoint
 * returns an asset the same way. BigInt byte counts become strings — JSON has no
 * BigInt, and silently narrowing to a number would corrupt large values.
 */

import type { Asset, AssetVersion } from '@imgopt/db';
import type { DeliveryService } from '../delivery/delivery.service.js';

export interface AssetResponse {
  id: string;
  status: string;
  version: number;
  createdAt: string;
  altText: string | null;
  tags: string[];
  focalPoint: unknown;
  failureReason: string | null;
  source: {
    width: number | null;
    height: number | null;
    format: string | null;
    bytes: string | null;
    hasAlpha: boolean | null;
    dominantColor: string | null;
  } | null;
  /** Base64 placeholder, inlined by the client for blur-up. */
  lqip: string | null;
  urls: { base: string; src: string; srcset: string } | null;
}

export function presentAsset(
  asset: Asset & { versions?: AssetVersion[] },
  delivery: DeliveryService,
): AssetResponse {
  const version = asset.versions?.find((v) => v.version === asset.currentVersion) ?? null;

  const servable = asset.currentVersion > 0 && asset.status !== 'deleted';

  return {
    id: asset.id,
    status: asset.status,
    version: asset.currentVersion,
    createdAt: asset.createdAt.toISOString(),
    altText: asset.altText,
    tags: asset.tags,
    focalPoint: asset.focalPoint,
    failureReason: asset.failureReason,
    source:
      version === null
        ? null
        : {
            width: version.width,
            height: version.height,
            format: version.format,
            bytes: version.bytes === null ? null : version.bytes.toString(),
            hasAlpha: version.hasAlpha,
            dominantColor: version.dominantColor,
          },
    lqip: version?.lqip ?? null,
    urls: servable ? delivery.urlsFor(asset, version) : null,
  };
}
