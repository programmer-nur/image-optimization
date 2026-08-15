/**
 * Delivery URL construction.
 *
 * Builds the public URLs and the `srcset` that the API hands back with an asset.
 * Two rules keep the responsive markup honest:
 *
 * - Every `srcset` candidate is drawn from the same ladder the edge buckets to, so a
 *   candidate the browser picks maps to a warm or cheaply-generable variant rather
 *   than a bespoke size.
 * - Candidates are capped at the source's intrinsic width, so the browser is never
 *   offered an upscale.
 *
 * This is the server-side twin of the client SDK's builder; both exist so a
 * consumer never hand-writes a delivery URL and drifts off the ladder.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@imgopt/config';
import { LADDER, toVersionSegment } from '@imgopt/core';
import type { Asset, AssetVersion } from '@imgopt/db';
import { APP_CONFIG } from '../../tokens.js';

export interface DeliveryUrls {
  /** Canonical URL at the asset's natural size. */
  src: string;
  /** Responsive candidate set, widths capped at the source. */
  srcset: string;
  /** Base URL without query, for a consumer to append its own params. */
  base: string;
}

@Injectable()
export class DeliveryService {
  private readonly cdnHost: string;
  private readonly encoderEpoch: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.cdnHost = config.delivery.cdnHost;
    this.encoderEpoch = config.delivery.encoderEpoch;
  }

  /** Base delivery URL for a version: `https://cdn/i/{id}/{version}`. */
  baseUrl(assetId: string, assetVersion: number, slug?: string): string {
    const version = toVersionSegment(assetVersion, this.encoderEpoch);
    const scheme = this.cdnHost.startsWith('localhost') ? 'http' : 'https';
    const path =
      slug !== undefined
        ? `${assetId}/${version}/${encodeURIComponent(slug)}`
        : `${assetId}/${version}`;
    return `${scheme}://${this.cdnHost}/i/${path}`;
  }

  /** A single URL with a width parameter. */
  urlForWidth(assetId: string, assetVersion: number, width: number): string {
    return `${this.baseUrl(assetId, assetVersion)}?w=${width}`;
  }

  /** Ladder-aligned srcset, capped at `sourceWidth` when known. */
  srcset(assetId: string, assetVersion: number, sourceWidth?: number): string {
    const widths = LADDER.filter((w) => sourceWidth === undefined || w <= sourceWidth);
    // If the source is smaller than the smallest rung, offer its native width alone.
    const candidates = widths.length > 0 ? widths : [sourceWidth ?? LADDER[0]!];

    return candidates.map((w) => `${this.urlForWidth(assetId, assetVersion, w)} ${w}w`).join(', ');
  }

  urlsFor(asset: Asset, version: AssetVersion | null): DeliveryUrls {
    const v = version?.version ?? asset.currentVersion;
    const sourceWidth = version?.width ?? undefined;

    return {
      base: this.baseUrl(asset.id, v),
      src:
        version?.width !== undefined && version.width !== null
          ? this.urlForWidth(asset.id, v, this.defaultWidth(version.width))
          : this.baseUrl(asset.id, v),
      srcset: this.srcset(asset.id, v, sourceWidth ?? undefined),
    };
  }

  /** Largest ladder width not exceeding the source, as a sensible default `src`. */
  private defaultWidth(sourceWidth: number): number {
    const fitting = LADDER.filter((w) => w <= sourceWidth);
    return fitting.length > 0 ? fitting[fitting.length - 1]! : sourceWidth;
  }
}
