# Bootstrap: empty AWS account to a working deployment

> **This path has never been executed.** There is no AWS account in this repository's
> development loop, so `infra/cdk` is verified only as far as synthesis. Every step
> below is reasoned from the stack definitions, not observed. Expect to correct
> something — and please correct this document when you do.

## Prerequisites

- An AWS account and credentials with permission to create IAM, VPC, S3, RDS, ECS,
  Lambda, and CloudFront resources.
- Node 22, pnpm 11, Docker (able to run `linux/arm64` containers).
- A domain you control, with its zone in **Cloudflare**, and a scoped API token
  (`Zone:DNS:Edit` on that zone). Route 53 is not used — see [DNS and certificates](#dns-and-certificates).
  A first deploy works without any domain at all, on the `*.cloudfront.net` name.

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
export API_HOST=api.example.com            # optional in staging, required in production
export MALWARE_SCANNING=true               # optional; charged per GB scanned

# Cloudflare, for DNS and certificate validation. A scoped token, never a global key.
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ZONE_ID=...
```

The full list is in [`infra/cdk/README.md`](../infra/cdk/README.md).

Then issue the certificates, before deploying anything — the CDK takes them as ARNs
and issues nothing itself:

```bash
pnpm --filter @imgopt/cloudflare certs
```

Export the two lines it prints. Skip this only if you are deploying without a custom
domain; production will refuse to synthesize without the API certificate. Details and
the reasoning are in [DNS and certificates](#dns-and-certificates).

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
console.log(\"INSERT INTO api_keys (id, tenant_id, name, hash, permissions, created_at) VALUES ('\" +
  k.keyId + \"', 'tenant_default', 'bootstrap', '\" + k.hash + \"', ARRAY['read','upload','delete','admin'], now());\");
"
```

`tenant_default` is created by the migration in step 6, so it already exists — the
insert fails on a foreign key if you run it before migrating, which is the intended
order. Every asset this key uploads is attributed to that tenant, and its quota is
accounted there rather than on the key: issuing a second key does not grant a second
allowance.

Run the emitted `INSERT` against the database, then use the plaintext to create
properly scoped keys through `POST /v1/keys`. Those are issued into the issuer's own
tenant — the endpoint takes no tenant id, because `admin` on any key would otherwise be
a way to mint credentials for someone else's data. Revoke the bootstrap key afterwards.

## 8. Point Cloudflare at it

The distribution and load balancer hostnames only exist once the stacks do, so DNS is
the phase after the deploy rather than part of it:

```bash
pnpm --filter @imgopt/cloudflare dns
```

Read the plan, then re-run with `--apply`. Every record is created **proxy off**; see
[DNS and certificates](#dns-and-certificates) for why that is not a preference.

## 9. Verify

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

## DNS and certificates

DNS is in Cloudflare and the CDK creates no records and issues no certificates — it
cannot, because CloudFormation can only write a zone it owns. Point the certificate
construct at an external zone and the stack does not fail, it _waits_, holding the
deploy open until CloudFormation gives up hours later. So issuance happens before the
deploy and DNS after it. See design.md D18.

**Before the first deploy — certificates.** Run this once per environment; it requests
both certificates, writes each validation record into Cloudflare, waits for ACM to
issue, and prints the ARNs:

```bash
pnpm --filter @imgopt/cloudflare certs
```

Export the two lines it prints (`CDN_CERTIFICATE_ARN`, `API_CERTIFICATE_ARN`) before
deploying. Two certificates, not one: CloudFront accepts a viewer certificate only
from `us-east-1`, an ALB only from its own region.

**Leave the validation records alone afterwards.** ACM re-checks them to renew, roughly
every eleven months; deleting them turns renewal into a silent failure that surfaces as
an expired certificate on a date nobody has in a calendar.

**After each deploy — DNS.** The distribution and load balancer hostnames are assigned
by AWS, so they are read from stack outputs rather than written down:

```bash
pnpm --filter @imgopt/cloudflare dns
```

That prints a plan and writes nothing. Add `--apply` when it looks right. Re-run it
after any deploy that could replace the distribution or the load balancer.

**The proxy must stay off** — grey cloud, not orange. Cloudflare's proxy caches by URL
and honours `Vary` only for `Accept-Encoding`, while this service returns AVIF, WebP or
JPEG from one URL depending on the viewer's `Accept`. Proxied, Cloudflare caches
whichever format the first visitor received and serves it to everyone — AVIF to
browsers that cannot decode it, with nothing in any log to explain the broken images.
The reconciler turns the proxy off rather than reporting it.

**Without a domain** the deployment still succeeds: the distribution serves on its own
`*.cloudfront.net` name and the ALB on its own DNS name, with staging permitted to run
plain HTTP. Production refuses to synthesize without an API certificate.

## Production

Same steps with `-c env=production`. Differences are in `lib/config.ts`: Multi-AZ
database, deletion protection, larger tasks, `PriceClass_All`, malware scanning on by
default.

Deploy staging first and leave it running. It is the only place to find out whether a
change to the transform grammar did what you expected before it reaches cached URLs.

## Onboarding another application

A second application is a second deployment. There is no tenant id in a URL, no shared
bucket, and no route that branches on who is calling — the isolation the stacks already
have between staging and production is the same isolation between two customers. See
`openspec/changes/multi-tenancy/design.md` T2 for why the boundary is drawn here.

Add the entry to `DEPLOYMENTS` in `infra/cdk/lib/config.ts`:

```ts
{ name: 'acme', tier: 'production' },
```

`tier` is a sizing profile only — database class, task count, price class, whether
malware scanning defaults on. It says nothing about who the deployment is for, and two
deployments on the same tier collide nowhere: every resource name derives from `name`.

Then repeat this guide with `-c env=acme`, using `ACME_`-prefixed variables so the new
deployment does not read another's settings:

```bash
export ACME_CDN_HOST=images.acme.example.com
export ACME_API_HOST=api.acme.example.com
export ACME_CDN_CERTIFICATE_ARN=...   # us-east-1, from `pnpm --filter @imgopt/cloudflare certs`
export ACME_API_CERTIFICATE_ARN=...   # this region
export ACME_CDN_DISTRIBUTION_ID=...   # after the first deploy; see step 5
```

Any variable without a prefix falls back to the bare name, which is what keeps a
single-deployment account working — and is also the trap: leave `ACME_CDN_HOST` unset
and the new deployment claims the existing one's hostname. CloudFront reports that as
`CNAMEAlreadyExists`, partway through the second deploy, after resources have already
been created. `resolveAllDeployments()` refuses it at synth instead; the manifest test
in `infra/cdk/test/stacks.test.ts` runs that check.

### What is per-deployment, and what is shared

**Per-deployment — all of it:**

| Thing                               | Why it cannot be shared                                                    |
| ----------------------------------- | -------------------------------------------------------------------------- |
| S3 bucket                           | the read grant is pinned to one distribution; sharing defeats it           |
| PostgreSQL instance                 | the registry is the deployment's, and quotas are accounted in it           |
| CloudFront distribution + function  | one origin, one edge normalizer, one cache                                 |
| SQS optimize + dead-letter queues   | a shared queue would hand one deployment's job to another's worker         |
| Both Lambdas, the Fargate service   | each carries its own bucket and queue in its environment                   |
| Hostnames (CDN and API)             | an alias belongs to exactly one distribution                               |
| Two ACM certificates                | us-east-1 for CloudFront, this region for the ALB                          |
| Two Cloudflare CNAMEs, grey-clouded | see [DNS and certificates](#dns-and-certificates)                          |
| VPC, NAT gateway, RDS instance      | the fixed cost floor; see [tuning.md](tuning.md#cost-floor-per-deployment) |

**Shared: nothing.** Deployments may sit in one AWS account, and that is the only thing
they have in common. It is also the only place they can run out of room — CloudFront's
per-account quotas on cache policies, response-headers policies, functions, and key
groups are counted per account, not per deployment. The wall arrives around the
eleventh deployment for key groups and the twenty-first for policies, as a
`LimitExceeded` naming a resource nobody associates with deployment count.

The registry carries a `tenant_id` on every asset and key regardless, with one tenant
row per deployment. It costs nothing at one tenant and it is what makes collapsing
several deployments into one later a data migration rather than a route-by-route audit.

## Known rough edges

- **`cdk synth` needs credentials** even though it deploys nothing: resolving a VPC's
  availability zones for a concrete account is a context lookup. Use
  `pnpm --filter @imgopt/infra test` for a credential-free check.
- **First deploy is two-phase** because of the ECR chicken-and-egg above.
- **DNS is a third phase**, after the deploy, because the hostnames to point at do not
  exist until the stacks do.
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
