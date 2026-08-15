/**
 * Client configuration.
 *
 * Configured once, so a CDN host change is one edit rather than a search across
 * every call site. Everything else in this package takes a resolved config rather
 * than reading a module-level global, which is what lets a server render for two
 * deployments in one process.
 */

import { DEFAULT_QUALITY, type QualityLevel } from '@imgopt/core';

export interface ClientConfig {
  /**
   * Delivery hostname, with or without a scheme. `localhost` and `127.0.0.1` default
   * to http so a local stack works without ceremony.
   */
  cdnHost: string;

  /**
   * Must match `ENCODER_EPOCH` on the deployment.
   *
   * It is half of the version segment, so a wrong value produces URLs that resolve
   * to nothing — every image on the page breaks at once, which is at least loud.
   * Required rather than defaulted for that reason: a silent default of 1 against a
   * deployment on epoch 2 would look like a working configuration.
   *
   * Prefer `fromBase()` when you already hold an asset's `urls.base` from the API;
   * that value carries the deployment's epoch and cannot drift.
   */
  encoderEpoch: number;

  /** Applied when a call omits quality. Nominal, not a raw codec value. */
  defaultQuality?: QualityLevel;
}

export interface ResolvedConfig {
  origin: string;
  encoderEpoch: number;
  defaultQuality: QualityLevel;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function toOrigin(cdnHost: string): string {
  if (cdnHost.startsWith('http://') || cdnHost.startsWith('https://')) {
    return cdnHost.replace(/\/+$/, '');
  }

  const host = cdnHost.replace(/\/+$/, '');
  const isLocal = LOCAL_HOSTS.some((local) => host === local || host.startsWith(`${local}:`));
  return `${isLocal ? 'http' : 'https'}://${host}`;
}

export function resolveConfig(config: ClientConfig): ResolvedConfig {
  if (config.cdnHost === undefined || config.cdnHost === '') {
    throw new Error('imgopt: cdnHost is required.');
  }
  if (!Number.isInteger(config.encoderEpoch) || config.encoderEpoch < 0) {
    throw new Error(
      `imgopt: encoderEpoch must be a non-negative integer, received ${String(config.encoderEpoch)}. ` +
        'It must match ENCODER_EPOCH on the deployment.',
    );
  }

  return {
    origin: toOrigin(config.cdnHost),
    encoderEpoch: config.encoderEpoch,
    defaultQuality: config.defaultQuality ?? DEFAULT_QUALITY,
  };
}
