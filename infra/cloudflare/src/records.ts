/**
 * The DNS records this deployment needs, derived from CDK stack outputs.
 *
 * Pure on purpose: computing the desired state is the part worth testing, and it is
 * separable from talking to an API. `reconcile` below diffs desired against actual
 * and returns the changes, so `apply` is a loop over an already-decided plan rather
 * than a decision made mid-flight.
 */

/**
 * Proxying is off on every record here, and it is not a preference.
 *
 * Cloudflare's proxy is a second CDN in front of CloudFront, and it caches by URL.
 * This service negotiates image format at the CloudFront edge — the same
 * `/i/{id}/{v}?w=640` URL legitimately returns AVIF, WebP or JPEG depending on the
 * viewer's `Accept` header, which is why every response carries `Vary: Accept`.
 * Cloudflare's cache honours `Vary` only for `Accept-Encoding`, so an orange-clouded
 * record would cache whichever format the first visitor happened to get and serve it
 * to everyone: AVIF to a browser that cannot decode it, appearing as a broken image
 * for a subset of users and for no discoverable reason.
 *
 * It also breaks the cost model in the other direction — CloudFront's cache-hit
 * metrics stop reflecting reality, and the drift detector that watches them goes
 * quiet. See design.md D9 and D18.
 */
export const PROXIED = false as const;

export interface DesiredRecord {
  /** Fully qualified name, e.g. `images.example.com`. */
  name: string;
  type: 'CNAME';
  content: string;
  proxied: boolean;
  /** Why this record exists, written into the Cloudflare record comment. */
  comment: string;
}

export interface StackOutputs {
  /** `CdnDnsTarget` from the CDN stack — the distribution's own hostname. */
  cdnTarget?: string;
  /** `ApiDnsTarget` from the compute stack — the load balancer's DNS name. */
  apiTarget?: string;
}

export interface HostConfig {
  cdnHost: string;
  apiHost?: string;
}

/**
 * The record set for one environment.
 *
 * A missing target is skipped rather than defaulted: pointing a live hostname at a
 * guess is worse than leaving it unresolved, and the usual cause is simply that the
 * stack has not been deployed yet.
 */
export function desiredRecords(hosts: HostConfig, outputs: StackOutputs): DesiredRecord[] {
  const records: DesiredRecord[] = [];

  if (outputs.cdnTarget !== undefined && outputs.cdnTarget !== '') {
    records.push({
      name: hosts.cdnHost,
      type: 'CNAME',
      content: outputs.cdnTarget,
      proxied: PROXIED,
      comment: 'imgopt delivery -> CloudFront. Proxy must stay off; see infra/cloudflare.',
    });
  }

  if (hosts.apiHost !== undefined && outputs.apiTarget !== undefined && outputs.apiTarget !== '') {
    records.push({
      name: hosts.apiHost,
      type: 'CNAME',
      content: outputs.apiTarget,
      proxied: PROXIED,
      comment: 'imgopt control plane -> ALB. Proxy must stay off; see infra/cloudflare.',
    });
  }

  return records;
}

/** A record as Cloudflare reports it. */
export interface ExistingRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
}

export type Change =
  | { action: 'create'; record: DesiredRecord }
  | { action: 'update'; id: string; record: DesiredRecord; from: ExistingRecord }
  | { action: 'unchanged'; id: string; record: DesiredRecord };

/**
 * Diffs desired against what the zone holds.
 *
 * Deliberately narrow: it only ever touches records whose *name* this deployment
 * owns. Anything else in the zone — the apex, mail, whatever else the domain does —
 * is invisible to this tool, because a DNS reconciler that prunes what it does not
 * recognize is a reconciler that takes a company offline the first time someone adds
 * a record by hand.
 *
 * A name held by a different record type is reported as a conflict rather than
 * silently replaced: turning an existing A record into a CNAME is a decision, not a
 * detail.
 */
export function reconcile(
  desired: DesiredRecord[],
  existing: ExistingRecord[],
): { changes: Change[]; conflicts: string[] } {
  const changes: Change[] = [];
  const conflicts: string[] = [];

  for (const record of desired) {
    const sameName = existing.filter((candidate) => candidate.name === record.name);
    const match = sameName.find((candidate) => candidate.type === record.type);

    if (match === undefined) {
      if (sameName.length > 0) {
        conflicts.push(
          `${record.name} already exists as ${sameName.map((r) => r.type).join('/')}; ` +
            `expected ${record.type}. Resolve by hand — replacing it is a decision.`,
        );
        continue;
      }
      changes.push({ action: 'create', record });
      continue;
    }

    const proxied = match.proxied ?? false;
    if (match.content === record.content && proxied === record.proxied) {
      changes.push({ action: 'unchanged', id: match.id, record });
    } else {
      changes.push({ action: 'update', id: match.id, record, from: match });
    }
  }

  return { changes, conflicts };
}

/** Human-readable plan, printed before anything is written. */
export function formatPlan(changes: Change[], conflicts: string[]): string {
  const lines = changes.map((change) => {
    switch (change.action) {
      case 'create':
        return `  + ${change.record.name} CNAME ${change.record.content} (proxy off)`;
      case 'update':
        return (
          `  ~ ${change.record.name} CNAME ${change.from.content} -> ${change.record.content}` +
          (change.from.proxied === true ? ' (and turning the proxy OFF)' : '')
        );
      case 'unchanged':
        return `  = ${change.record.name} CNAME ${change.record.content}`;
    }
  });

  const conflictLines = conflicts.map((conflict) => `  ! ${conflict}`);

  if (lines.length === 0 && conflictLines.length === 0) {
    return 'No records to reconcile — has the stack been deployed?';
  }
  return [...lines, ...conflictLines].join('\n');
}
