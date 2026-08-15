/**
 * Post-deploy smoke test.
 *
 * Answers one question a green CloudFormation deploy cannot: does a real viewer
 * request produce a real image? The failure this exists to catch is a native binary
 * built for the wrong architecture — the layer deploys cleanly, the stack reports
 * CREATE_COMPLETE, and the function throws on its first invocation. Without this,
 * that surfaces as a broken image in a browser rather than a failed release.
 *
 * Deliberately dependency-light: it reads stack outputs and makes plain HTTPS
 * requests, so it can run from CI or a laptop with nothing but credentials.
 *
 *   pnpm --filter @imgopt/infra smoke -- --env staging --asset <assetId> --version v1-1
 *
 * With no asset id it verifies only that the distribution is reachable and that an
 * unknown asset is refused correctly, which is still enough to catch a misrouted
 * origin group or an edge function that failed to attach.
 */

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

interface Args {
  env: string;
  region: string;
  assetId?: string;
  version: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(`--${flag}`);
    return index === -1 ? undefined : argv[index + 1];
  };

  const env = get('env');
  if (env === undefined) throw new Error('Missing --env <name>.');

  return {
    env,
    region: get('region') ?? process.env['CDK_REGION'] ?? 'us-east-1',
    ...(get('asset') !== undefined ? { assetId: get('asset')! } : {}),
    version: get('version') ?? 'v1-1',
  };
}

async function stackOutput(
  client: CloudFormationClient,
  stackName: string,
  key: string,
): Promise<string> {
  const result = await client.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = result.Stacks?.[0]?.Outputs ?? [];
  const match = outputs.find((o) => o.OutputKey === key);

  if (match?.OutputValue === undefined) {
    throw new Error(`Stack ${stackName} has no output ${key}. Is it deployed?`);
  }
  return match.OutputValue;
}

interface Check {
  name: string;
  run: () => Promise<void>;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfn = new CloudFormationClient({ region: args.region });

  const base = await stackOutput(cfn, `Imgopt-${args.env}-Cdn`, 'DeliveryUrl');
  console.log(`Delivery base: ${base}`);

  const checks: Check[] = [];

  checks.push({
    name: 'unknown asset is refused, not served',
    run: async () => {
      const response = await fetch(`${base}/i/definitelynotanasset/v1-1/x?w=640`, {
        headers: { accept: 'image/avif,image/webp,*/*' },
      });
      assert(
        response.status === 403 || response.status === 404,
        `expected 403/404 for an unknown asset, got ${response.status}`,
      );
    },
  });

  checks.push({
    name: 'malformed parameters are rejected at the edge',
    run: async () => {
      const response = await fetch(`${base}/i/anything/v1-1/x?fit=squish`);
      assert(response.status === 400, `expected 400, got ${response.status}`);
      // Proves the edge function is attached and running: an unattached function
      // would let this through to the origin and produce 403/404 instead.
      assert(
        response.headers.get('x-imgopt-error') === 'invalid_enum',
        'edge function did not reject the request; is it attached to viewer-request?',
      );
    },
  });

  if (args.assetId !== undefined) {
    const url = `${base}/i/${args.assetId}/${args.version}/smoke?w=640`;

    checks.push({
      name: 'a real variant generates and returns image bytes',
      run: async () => {
        const response = await fetch(url, {
          headers: { accept: 'image/avif,image/webp,*/*' },
        });
        assert(response.ok, `expected 200, got ${response.status}`);

        const type = response.headers.get('content-type') ?? '';
        assert(type.startsWith('image/'), `expected an image, got content-type "${type}"`);

        const body = Buffer.from(await response.arrayBuffer());
        // The specific thing a wrong-architecture sharp binary fails: bytes.
        assert(body.length > 1000, `suspiciously small response: ${body.length} bytes`);

        const cacheControl = response.headers.get('cache-control') ?? '';
        assert(
          cacheControl.includes('immutable'),
          `expected an immutable cache directive, got "${cacheControl}"`,
        );
      },
    });

    checks.push({
      name: 'the second request is served from cache or storage',
      run: async () => {
        const response = await fetch(url, {
          headers: { accept: 'image/avif,image/webp,*/*' },
        });
        assert(response.ok, `expected 200, got ${response.status}`);

        // Not a hard failure: a Hit requires the first request to have populated
        // this same edge location. Reported either way, because a persistent Miss
        // is the signature of edge/core normalization drift.
        const hit = response.headers.get('x-cache') ?? 'unknown';
        console.log(`    x-cache: ${hit}`);
      },
    });
  } else {
    console.log('No --asset given; skipping generation checks.');
  }

  let failed = 0;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`  PASS  ${check.name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL  ${check.name}\n        ${(error as Error).message}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} of ${checks.length} smoke checks failed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nAll ${checks.length} smoke checks passed.`);
}

await main();
