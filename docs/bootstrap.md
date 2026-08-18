# Bootstrap: empty AWS account to a working deployment

> **This path has never been executed.** There is no AWS account in this repository's
> development loop, so `infra/cdk` is verified only as far as synthesis. Every step
> below is reasoned from the stack definitions, not observed. Expect to correct
> something — and please correct this document when you do.

## Prerequisites

- An AWS account and credentials with permission to create IAM, VPC, S3, RDS, ECS,
  Lambda, and CloudFront resources.
- Node 22, pnpm 11, Docker (able to run `linux/arm64` containers).
- A domain you control, ideally with its hosted zone in the same account. If DNS lives
  elsewhere the deployment still works — see [DNS](#dns).

## 1. Install and verify locally first

```bash
pnpm install
pnpm --filter @imgopt/db db:generate
pnpm typecheck && pnpm lint && pnpm test
```

Then run the whole thing against the local stack, because every failure you find here
is one you will not be debugging through CloudFormation:

```bash
pnpm dev:up
DATABASE_URL='postgres://imgopt:imgopt@localhost:5434/imgopt' \
  pnpm --filter @imgopt/db db:migrate
pnpm test:integration
```

## 2. Bootstrap CDK

```bash
export CDK_ACCOUNT=123456789012
export CDK_REGION=us-east-1
pnpm --filter @imgopt/infra exec cdk bootstrap aws://$CDK_ACCOUNT/$CDK_REGION
```

If the CDN will use a custom domain and the region is not `us-east-1`, bootstrap
`us-east-1` as well — the viewer certificate must live there regardless of where
everything else runs.

## 3. Build the artifacts

CDK will happily package a missing bundle and deploy a function that fails on its
first invocation, so `lib/artifacts.ts` checks each path and names the command that
produces it.

```bash
pnpm --filter @imgopt/edge generate       # CloudFront Function, from packages/core
pnpm --filter @imgopt/infra build:bundles # esbuild output for all three Lambdas
pnpm --filter @imgopt/infra build:layer   # sharp, in a linux/arm64 container
```

The layer build is the one that matters. sharp ships prebuilt libvips binaries per
platform and npm resolves them for the _host_ doing the install, so a layer built on a
macOS or x86 workstation deploys perfectly and then throws `Could not load the "sharp"
module using the linux-arm64 runtime` on its first real request — in front of a viewer,
after CI was green.

## 4. Configure

```bash
export CDN_HOST=images.example.com
export API_HOST=api.example.com            # optional
export HOSTED_ZONE_ID=Z123...              # optional; see DNS below
export HOSTED_ZONE_NAME=example.com
export MALWARE_SCANNING=true               # optional; charged per GB scanned
```

The full list is in [`infra/cdk/README.md`](../infra/cdk/README.md).

## 5. First deploy, in two parts

The compute stack references an ECR repository **by tag**, so the repository has to
exist and hold that tag before the service can start. First time only:

```bash
pnpm --filter @imgopt/infra deploy -c env=staging \
  Imgopt-staging-Compute/ApiRepository

aws ecr get-login-password --region $CDK_REGION \
  | docker login --username AWS --password-stdin \
      $CDK_ACCOUNT.dkr.ecr.$CDK_REGION.amazonaws.com

# `--platform linux/amd64` is required, not optional. Both Fargate task definitions
# declare X86_64; an image built on an arm64 machine (any Apple Silicon laptop, and
# the same machine the sharp layer's arm64 build wants) pushes fine, deploys fine,
# and then never starts — the error names the manifest, not the architecture.
docker build --platform linux/amd64 -f apps/api/Dockerfile -t <repositoryUri>:v1 .
docker push <repositoryUri>:v1
export API_IMAGE_TAG=v1
```

`API_IMAGE_TAG` is required and must name an immutable tag. Synthesis fails without
it, and refuses `latest`: the tag is the rollback coordinate, and a mutable one makes
"redeploy the previous version" ambiguous — the same tag can point at different bytes
on two consecutive days, and the service and the migration task can silently disagree
about which version they are.

Then everything:

```bash
pnpm --filter @imgopt/infra deploy -c env=staging --all
```

Deploy order is Network → Storage/Queue → Data → Compute → Cdn → Observability, and
CDK derives it from the stack dependencies.

## 6. Migrate

Migrations are a one-off task, never a container entrypoint — several tasks starting at
once would race to apply the same migration, and the result is a half-migrated schema
rather than a clean error.

```bash
aws ecs run-task \
  --cluster <ClusterName> \
  --task-definition <MigrationTaskDefinition> \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[<private-subnets>],securityGroups=[<appSecurityGroup>]}'
```

Both values are stack outputs. Wait for the task to reach `STOPPED` with exit code 0.

## 7. Create the first API key

There is no unauthenticated bootstrap endpoint — issuing a key requires a key that
can. The first one is created out of band, against the database directly:

```bash
# Generate a key and its hash locally.
node -e "
const { generateApiKey } = require('./apps/api/dist/modules/auth/api-key.js');
const k = generateApiKey();
console.log('PLAINTEXT (store now):', k.plaintext);
console.log('INSERT INTO api_keys (id, name, hash, permissions, created_at) VALUES (\'' +
  k.keyId + \"', 'bootstrap', '\" + k.hash + \"', ARRAY['read','upload','delete','admin'], now());\");
"
```

Run the emitted `INSERT` against the database, then use the plaintext to create
properly scoped keys through `POST /v1/keys`. Revoke the bootstrap key afterwards.

## 8. Verify

```bash
pnpm --filter @imgopt/infra smoke -- --env staging
```

That checks the distribution answers, that an unknown asset is refused, and — most
usefully — that the edge function is actually attached, since an unattached function
lets malformed parameters through to the origin instead of rejecting them.

Then the real test: upload an image and request it twice.

```bash
curl -X POST https://api.example.com/v1/images \
  -H "x-api-key: $KEY" -F file=@photo.jpg

curl -sI "https://images.example.com/i/<assetId>/v1-1/photo?w=640" | grep -i x-cache
# first:  Miss from cloudfront   (generated on demand)
curl -sI "https://images.example.com/i/<assetId>/v1-1/photo?w=640" | grep -i x-cache
# second: Hit from cloudfront

pnpm --filter @imgopt/infra smoke -- --env staging --asset <assetId>
```

Miss then hit is the whole architecture working. If the second request also misses,
stop and read [the runbook](operations.md#every-request-is-regenerating).

## DNS

With `HOSTED_ZONE_ID` and `HOSTED_ZONE_NAME` set, the certificate is issued and
validated automatically and the alias records are created.

Without them the deployment still succeeds — the distribution serves on its own
`*.cloudfront.net` name, and the `ManualDnsRecord` output names the record to create by
hand. An externally managed zone is a normal arrangement, not a blocker. Once the
record exists, set `CDN_HOST` on the API to match so generated URLs use it.

## Production

Same steps with `-c env=production`. Differences are in `lib/config.ts`: Multi-AZ
database, deletion protection, larger tasks, `PriceClass_All`, malware scanning on by
default.

Deploy staging first and leave it running. It is the only place to find out whether a
change to the transform grammar did what you expected before it reaches cached URLs.

## Known rough edges

- **`cdk synth` needs credentials** even though it deploys nothing: resolving a VPC's
  availability zones for a concrete account is a context lookup. Use
  `pnpm --filter @imgopt/infra test` for a credential-free check.
- **First deploy is two-phase** because of the ECR chicken-and-egg above.
- **The API image builds and runs**, verified locally: `/healthz` 200, `/readyz` 503
  with dependencies down, 401 unauthenticated, non-root, healthcheck green. It is
  ~720MB, which is unremarkable for Node plus sharp plus Prisma plus the AWS SDK but
  does affect task start time; `pnpm deploy --prod` would shrink it if that matters.
- **The migration task's command** assumes prisma resolves at
  `node_modules/prisma/build/index.js` inside the API image. Verify against the actual
  image layout; this is the kind of thing that differs by base image.
- **`MALWARE_SCANNING` must match on both sides.** The stack sets the app flag from the
  same value, but if you diverge them by hand, an app that believes a scanner exists
  where none does holds every upload forever — which presents as a broken uploader
  rather than a configuration error.
