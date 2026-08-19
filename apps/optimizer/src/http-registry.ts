/**
 * The production `RegistryPort`: the control plane over HTTPS.
 *
 * Errors are thrown rather than swallowed, which is the opposite of the generator's
 * bookkeeping sink and is correct here. The optimizer runs behind a queue with nobody
 * waiting, so a failed call should surface as a retriable failure and let SQS redeliver
 * — losing an asset's metadata silently would leave it permanently un-`ready` with
 * nothing in any error rate to say so.
 */

import type { FailureReason, VersionMetadata } from '@imgopt/db';
import type { DerivativeRecord, OptimizeContextResult, RegistryPort } from './registry-port.js';

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface HttpRegistryOptions {
  baseUrl: string;
  secret: string;
  timeoutMs: number;
}

export class HttpRegistry implements RegistryPort {
  constructor(private readonly options: HttpRegistryOptions) {}

  async optimizeContext(assetId: string): Promise<OptimizeContextResult> {
    return this.call<OptimizeContextResult>(
      'GET',
      `/internal/v1/optimize/${encodeURIComponent(assetId)}`,
    );
  }

  async completeOptimize(
    assetId: string,
    version: number,
    metadata: VersionMetadata,
  ): Promise<void> {
    await this.call('POST', `/internal/v1/optimize/${encodeURIComponent(assetId)}/complete`, {
      version,
      // BigInt does not survive JSON.stringify — it throws. Byte counts arrive here as
      // numbers and must stay numbers; the control plane widens them on the way in.
      metadata,
    });
  }

  async markFailed(assetId: string, reason: FailureReason): Promise<void> {
    await this.call('POST', `/internal/v1/optimize/${encodeURIComponent(assetId)}/failed`, {
      reason,
    });
  }

  async recordDerivative(record: DerivativeRecord): Promise<void> {
    await this.call('POST', '/internal/v1/derivatives', record);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    /*
     * An explicit timeout, because the default is none.
     *
     * A control plane that accepts a connection and then stalls would otherwise hold
     * this invocation until Lambda's own timeout — five minutes of billed wall clock
     * per message, across every message in the batch.
     */
    const signal = AbortSignal.timeout(this.options.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${path}`, {
        method,
        signal,
        headers: {
          'x-imgopt-worker-secret': this.options.secret,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new RegistryError(
        `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      // Read the body for the message, but never let a malformed error response turn
      // into a different, more confusing error than the one that actually happened.
      const detail = await response.text().catch(() => '');
      throw new RegistryError(
        `${method} ${path} returned ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }
}
