import { describe, expect, it } from 'vitest';
import { desiredRecords, formatPlan, reconcile, type ExistingRecord } from './records.js';

const hosts = { cdnHost: 'images.example.com', apiHost: 'api.example.com' };
const outputs = {
  cdnTarget: 'd111.cloudfront.net',
  apiTarget: 'alb-123.us-east-1.elb.amazonaws.com',
};

describe('desired records', () => {
  it('points each hostname at the target its stack published', () => {
    const records = desiredRecords(hosts, outputs);

    expect(records).toEqual([
      expect.objectContaining({ name: 'images.example.com', content: 'd111.cloudfront.net' }),
      expect.objectContaining({ name: 'api.example.com', content: outputs.apiTarget }),
    ]);
  });

  /*
   * The rule that keeps images correct.
   *
   * Cloudflare's proxy caches by URL and honours `Vary` only for `Accept-Encoding`.
   * This service returns AVIF, WebP or JPEG from one URL depending on `Accept`, so an
   * orange-clouded record caches whichever format the first visitor received and
   * serves it to everyone — AVIF to browsers that cannot decode it.
   */
  it('never proxies', () => {
    for (const record of desiredRecords(hosts, outputs)) {
      expect(record.proxied, record.name).toBe(false);
    }
  });

  it('skips a hostname whose stack has not been deployed', () => {
    // Pointing a live name at a guess is worse than leaving it unresolved.
    expect(desiredRecords(hosts, { cdnTarget: 'd111.cloudfront.net' })).toHaveLength(1);
    expect(desiredRecords(hosts, {})).toHaveLength(0);
  });

  it('skips the API record when no API hostname is configured', () => {
    expect(desiredRecords({ cdnHost: hosts.cdnHost }, outputs)).toHaveLength(1);
  });
});

describe('reconcile', () => {
  const existing = (over: Partial<ExistingRecord> = {}): ExistingRecord => ({
    id: 'rec-1',
    name: 'images.example.com',
    type: 'CNAME',
    content: 'd111.cloudfront.net',
    proxied: false,
    ...over,
  });

  it('creates what is missing', () => {
    const { changes } = reconcile(desiredRecords(hosts, outputs), []);
    expect(changes.every((change) => change.action === 'create')).toBe(true);
  });

  it('leaves a correct record alone', () => {
    const { changes } = reconcile(desiredRecords({ cdnHost: hosts.cdnHost }, outputs), [
      existing(),
    ]);
    expect(changes[0]?.action).toBe('unchanged');
  });

  it('repoints a record whose target moved', () => {
    const { changes } = reconcile(desiredRecords({ cdnHost: hosts.cdnHost }, outputs), [
      existing({ content: 'd999.cloudfront.net' }),
    ]);
    expect(changes[0]).toMatchObject({ action: 'update', id: 'rec-1' });
  });

  it('turns the proxy off when someone has turned it on', () => {
    // The most likely way this breaks in practice: a well-meaning orange cloud
    // clicked in the dashboard, which silently caches one format for every viewer.
    const { changes } = reconcile(desiredRecords({ cdnHost: hosts.cdnHost }, outputs), [
      existing({ proxied: true }),
    ]);

    expect(changes[0]?.action).toBe('update');
    expect(formatPlan(changes, [])).toContain('turning the proxy OFF');
  });

  it('refuses to convert a different record type', () => {
    // Replacing an A record with a CNAME is a decision, and doing it silently is how
    // a reconciler takes something unrelated offline.
    const { changes, conflicts } = reconcile(desiredRecords({ cdnHost: hosts.cdnHost }, outputs), [
      existing({ type: 'A', content: '203.0.113.10' }),
    ]);

    expect(changes).toHaveLength(0);
    expect(conflicts[0]).toContain('already exists as A');
  });

  it('ignores every record it does not own', () => {
    // A zone holds mail, the apex, and whatever else the domain does. A reconciler
    // that prunes what it does not recognize is one that takes a company offline.
    const unrelated: ExistingRecord[] = [
      { id: 'mx', name: 'example.com', type: 'MX', content: 'mail.example.com' },
      { id: 'apex', name: 'example.com', type: 'A', content: '203.0.113.1' },
      { id: 'www', name: 'www.example.com', type: 'CNAME', content: 'example.com' },
    ];

    const { changes, conflicts } = reconcile(desiredRecords(hosts, outputs), unrelated);

    expect(conflicts).toHaveLength(0);
    expect(changes).toHaveLength(2);
    expect(changes.every((change) => change.action === 'create')).toBe(true);
  });
});

describe('plan output', () => {
  it('says plainly when there is nothing to do', () => {
    expect(formatPlan([], [])).toContain('has the stack been deployed');
  });
});
