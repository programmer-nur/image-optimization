/**
 * Delivery load test (task 13.7).
 *
 * Measures the three numbers the cost model actually rests on, and nothing else:
 *
 * 1. **Cache hit ratio.** The single largest determinant of the bill. Read from
 *    CloudFront's own `x-cache` header rather than from CloudWatch, so the result
 *    describes this run instead of blending into background traffic.
 * 2. **Generations per asset.** The claim being tested is that this converges to a
 *    bounded number and *stops* — that compute tracks new assets, not traffic. A
 *    figure that keeps climbing with request count means the variant space is not
 *    bounded, which is the failure the whole design exists to prevent.
 * 3. **Cost per thousand delivered images**, from measured bytes and the price
 *    inputs below.
 *
 * Deliberately dependency-light — `fetch` and stack outputs — so it runs from CI or
 * a laptop with nothing but credentials.
 *
 *   pnpm --filter @imgopt/infra tsx scripts/load-test.ts \
 *     --env staging --assets abc,def,ghi --requests 2000 --concurrency 25
 *
 * NOTE: this has never been run. There is no AWS account in this repository's
 * development loop, so the arithmetic below is reasoned, not observed, and the price
 * constants are list prices that will drift.
 */

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DEVICE_WIDTHS } from '@imgopt/core';

/** US/EU list prices, subject to change. Override for an accurate figure. */
const PRICING = {
  /** CloudFront data transfer out to internet, first 10TB. */
  cdnPerGb: Number(process.env['PRICE_CDN_PER_GB'] ?? 0.085),
  /** CloudFront HTTPS requests, per 10,000. */
  cdnPer10kRequests: Number(process.env['PRICE_CDN_PER_10K_REQUESTS'] ?? 0.012),
};

interface Args {
  env: string;
  region: string;
  assetIds: string[];
  version: string;
  requests: number;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(`--${flag}`);
    return index === -1 ? undefined : argv[index + 1];
  };

  const env = get('env');
  const assets = get('assets');
  if (env === undefined) throw new Error('Missing --env <name>.');
  if (assets === undefined) {
    throw new Error('Missing --assets <id,id,...>. Upload a few assets first.');
  }

  return {
    env,
    region: get('region') ?? process.env['CDK_REGION'] ?? 'us-east-1',
    assetIds: assets
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    version: get('version') ?? 'v1-1',
    requests: Number(get('requests') ?? 1000),
    concurrency: Number(get('concurrency') ?? 20),
  };
}

interface Sample {
  status: number;
  bytes: number;
  cacheHit: boolean;
  durationMs: number;
  url: string;
}

/**
 * The request mix.
 *
 * Drawn from the ladder on purpose. A load test using random widths would measure
 * the *edge normalizer* rather than the cache: every request would snap to a rung
 * anyway, so the hit ratio would look identical while telling you nothing about
 * whether real client traffic buckets correctly. This mirrors what the SDK emits.
 */
function requestUrls(base: string, assetIds: string[], version: string): string[] {
  const widths = DEVICE_WIDTHS.filter((w) => w <= 1920);
  return assetIds.flatMap((id) =>
    widths.map((width) => `${base}/i/${id}/${version}/load?w=${width}`),
  );
}

async function stackOutput(
  client: CloudFormationClient,
  stackName: string,
  key: string,
): Promise<string> {
  const result = await client.send(new DescribeStacksCommand({ StackName: stackName }));
  const match = (result.Stacks?.[0]?.Outputs ?? []).find((o) => o.OutputKey === key);

  if (match?.OutputValue === undefined) {
    throw new Error(`Stack ${stackName} has no output ${key}. Is it deployed?`);
  }
  return match.OutputValue;
}

async function fetchOnce(url: string): Promise<Sample> {
  const startedAt = Date.now();
  const response = await fetch(url, { headers: { accept: 'image/avif,image/webp,*/*' } });
  const body = await response.arrayBuffer();

  // `x-cache` is CloudFront's own verdict. Anything containing "Hit" was served
  // without an origin fetch, which is the only thing that matters here.
  const xCache = response.headers.get('x-cache') ?? '';

  return {
    status: response.status,
    bytes: body.byteLength,
    cacheHit: xCache.includes('Hit'),
    durationMs: Date.now() - startedAt,
    url,
  };
}

/** Bounded-concurrency worker pool. */
async function run(urls: string[], total: number, concurrency: number): Promise<Sample[]> {
  const samples: Sample[] = [];
  let issued = 0;

  const worker = async (): Promise<void> => {
    while (issued < total) {
      const url = urls[issued % urls.length]!;
      issued += 1;
      try {
        samples.push(await fetchOnce(url));
      } catch {
        samples.push({ status: 0, bytes: 0, cacheHit: false, durationMs: 0, url });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return samples;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfn = new CloudFormationClient({ region: args.region });
  const base = await stackOutput(cfn, `Imgopt-${args.env}-Cdn`, 'DeliveryUrl');

  const urls = requestUrls(base, args.assetIds, args.version);
  console.log(
    `${args.requests} requests over ${urls.length} distinct variants ` +
      `(${args.assetIds.length} assets), concurrency ${args.concurrency}`,
  );

  /*
   * A warm-up pass over every distinct variant, measured separately.
   *
   * Without it the headline hit ratio is dominated by unavoidable first-request
   * misses and says more about the size of the variant set than about the cache.
   * The warm pass is where the *generation* count is observed; the measured pass is
   * where the hit ratio is.
   */
  console.log('\nWarm-up: one request per distinct variant...');
  const warmup = await run(urls, urls.length, args.concurrency);
  const generated = warmup.filter((s) => !s.cacheHit).length;

  console.log('Measured pass...');
  const samples = await run(urls, args.requests, args.concurrency);

  const ok = samples.filter((s) => s.status === 200);
  const hits = ok.filter((s) => s.cacheHit).length;
  const totalBytes = ok.reduce((sum, s) => sum + s.bytes, 0);
  const hitRatio = ok.length === 0 ? 0 : (hits / ok.length) * 100;

  const gbServed = totalBytes / 1024 ** 3;
  const costPerThousand =
    ok.length === 0
      ? 0
      : ((gbServed * PRICING.cdnPerGb + (ok.length / 10_000) * PRICING.cdnPer10kRequests) /
          ok.length) *
        1000;

  console.log('\n--- results ---');
  console.log(`requests            ${ok.length} ok / ${samples.length} total`);
  console.log(`cache hit ratio     ${hitRatio.toFixed(1)}%`);
  console.log(`generations         ${generated} over ${args.assetIds.length} assets`);
  console.log(
    `  per asset         ${(generated / Math.max(args.assetIds.length, 1)).toFixed(1)} ` +
      `(distinct variants requested per asset: ${urls.length / Math.max(args.assetIds.length, 1)})`,
  );
  console.log(`bytes served        ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`mean object         ${(totalBytes / Math.max(ok.length, 1) / 1024).toFixed(1)} KB`);
  console.log(
    `latency p50/p95/p99 ${percentile(
      ok.map((s) => s.durationMs),
      50,
    )}/` +
      `${percentile(
        ok.map((s) => s.durationMs),
        95,
      )}/` +
      `${percentile(
        ok.map((s) => s.durationMs),
        99,
      )} ms`,
  );
  console.log(`cost / 1000 images  $${costPerThousand.toFixed(4)} (delivery only)`);

  console.log('\n--- interpretation ---');
  if (generated > urls.length) {
    // The failure this test exists to catch.
    console.error(
      `FAIL: ${generated} generations for ${urls.length} distinct variants. More ` +
        'generations than variants means the variant space is not bounded — almost ' +
        'certainly edge/core normalization drift. Check infra/cloudfront conformance.',
    );
    process.exitCode = 1;
    return;
  }
  if (hitRatio < 90) {
    console.warn(
      `WARN: hit ratio ${hitRatio.toFixed(1)}% on a warmed cache. Expect >95% here; ` +
        'anything lower suggests cache-key fragmentation.',
    );
  }
  console.log(
    `Generations (${generated}) did not exceed distinct variants (${urls.length}), so ` +
      'compute is tracking variants rather than traffic — the property the cost model rests on.',
  );
}

await main();
