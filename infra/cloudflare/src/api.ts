/**
 * A very small Cloudflare v4 client.
 *
 * Hand-rolled rather than a dependency: this needs three endpoints, and the official
 * SDK is a large surface to carry — and to keep current — for a tool that runs during
 * a deploy and nowhere else.
 *
 * Errors are unwrapped rather than passed through. Cloudflare returns HTTP 200 with
 * `success: false` for most failures, so a naive client treats an authorization
 * failure as a successful empty response and the reconciler then decides the zone is
 * empty and creates everything again.
 */

const API = 'https://api.cloudflare.com/client/v4';

export interface CloudflareOptions {
  /** Token with `Zone:DNS:Edit` on this zone. Never a global API key. */
  token: string;
  zoneId: string;
  fetchImpl?: typeof fetch;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

export interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
  comment?: string;
}

export class CloudflareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareError';
  }
}

export class CloudflareClient {
  private readonly token: string;
  private readonly zoneId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CloudflareOptions) {
    this.token = options.token;
    this.zoneId = options.zoneId;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${API}/zones/${this.zoneId}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    const body = (await response.json()) as CloudflareEnvelope<T>;

    // Both checks, in this order: a 403 carries no useful envelope, and a 200 with
    // `success: false` is how Cloudflare reports most real failures.
    if (!response.ok) {
      throw new CloudflareError(`Cloudflare ${String(response.status)} on ${path}`);
    }
    if (!body.success) {
      const detail = body.errors
        .map((error) => `${String(error.code)}: ${error.message}`)
        .join('; ');
      throw new CloudflareError(`Cloudflare rejected ${path} — ${detail}`);
    }

    return body.result;
  }

  /** Every DNS record in the zone. Paginated; a busy zone exceeds one page. */
  async listRecords(): Promise<DnsRecord[]> {
    const all: DnsRecord[] = [];
    let page = 1;

    for (;;) {
      const batch = await this.call<DnsRecord[]>(`/dns_records?per_page=100&page=${String(page)}`);
      all.push(...batch);
      if (batch.length < 100) return all;
      page += 1;
    }
  }

  async createRecord(record: {
    name: string;
    type: string;
    content: string;
    proxied: boolean;
    comment?: string;
    ttl?: number;
  }): Promise<DnsRecord> {
    return this.call<DnsRecord>('/dns_records', {
      method: 'POST',
      body: JSON.stringify({ ttl: 300, ...record }),
    });
  }

  async updateRecord(
    id: string,
    record: { name: string; type: string; content: string; proxied: boolean; comment?: string },
  ): Promise<DnsRecord> {
    return this.call<DnsRecord>(`/dns_records/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(record),
    });
  }
}
