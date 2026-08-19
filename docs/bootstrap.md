# Bootstrap: empty AWS account to a working deployment

> **This path has never been executed.** There is no AWS account in this repository's
> development loop, so `infra/cdk` is verified only as far as synthesis. Every step
> below is reasoned from the stack definitions, not observed. Expect to correct
> something — and please correct this document when you do.

## Prerequisites

- An AWS account and credentials with permission to create IAM, S3, SQS, Lambda,
  CloudFront, and Lightsail resources. **No VPC, RDS, or ECS permissions are needed** —
  none of those are used.
- Node 22, pnpm 11, Docker (able to run `linux/arm64` containers, for the sharp layer).
- The AWS CLI, for the Lightsail resources — they are not CloudFormation resources and
  the CDK cannot create them.
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
pnpm --filter @imgopt/infra build:bundles # esbuild output for both Lambdas
pnpm --filter @imgopt/infra build:layer   # sharp, in a linux/arm64 container
```

Two Lambda bundles, not three: reclamation ships inside the API image and runs on the
control-plane host, beside the database (design.md L2).

The layer build is the one that matters. sharp ships prebuilt libvips binaries per
platform and npm resolves them for the _host_ doing the install, so a layer built on a
macOS or x86 workstation deploys perfectly and then throws `Could not load the "sharp"
module using the linux-arm64 runtime` on its first real request — in front of a viewer,
after CI was green.

## 4. Configure

```bash
export CDN_HOST=images.example.com
export API_HOST=api.example.com
export MALWARE_SCANNING=true               # optional; charged per GB scanned

# Cloudflare, for DNS and certificate validation. A scoped token, never a global key.
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ZONE_ID=...
```

The full list is in [`infra/cdk/README.md`](../infra/cdk/README.md).

Then issue the distribution's certificate, before deploying anything — the CDK takes it
as an ARN and issues nothing itself:

```bash
pnpm --filter @imgopt/cloudflare certs
```

Export the line it prints as `CDN_CERTIFICATE_ARN`. Skip this only if you are deploying
without a custom domain.

**One certificate, not two.** The second used to be for the load balancer; there is no
load balancer, and ACM cannot be attached to a Lightsail instance in any case. The
control plane's certificate comes from Let's Encrypt via Caddy, which obtains and renews
it automatically. Details in [DNS and certificates](#dns-and-certificates).

## 5. Provision the database

Lightsail's managed PostgreSQL, **private-only**. Public mode has no IP allowlist — it
means reachable from every address on the internet with a password as the only control
— and this database holds every asset record and every API key hash.

```bash
aws lightsail create-relational-database \
  --relational-database-name imgopt-production-db \
  --relational-database-blueprint-id postgres_16 \
  --relational-database-bundle-id micro_2_0 \
  --master-database-name imgopt \
  --master-username imgopt \
  --availability-zone ${CDK_REGION}a \
  --no-publicly-accessible \
  --preferred-backup-window 04:00-04:30
```

Automatic snapshots are on by default and retained for seven days. Confirm both, and
confirm the database is not public, before putting anything in it:

```bash
aws lightsail get-relational-database --relational-database-name imgopt-production-db \
  --query 'relationalDatabase.{public:publiclyAccessible,backups:backupRetentionEnabled,endpoint:masterEndpoint.address}'
```

`public` must be `false`. Take the master password from
`get-relational-database-master-user-password`.

## 6. Provision the instance

```bash
aws lightsail create-instances \
  --instance-names imgopt-production \
  --availability-zone ${CDK_REGION}a \
  --blueprint-id ubuntu_24_04 \
  --bundle-id small_3_0

aws lightsail allocate-static-ip --static-ip-name imgopt-production-ip
aws lightsail attach-static-ip --static-ip-name imgopt-production-ip --instance-name imgopt-production
```

A static IP is free while attached and costs money while dangling. It is also what the
`A` record points at, so releasing it means editing DNS.

Open only what is served — the Lightsail firewall is separate from the instance's own,
and both are needed:

```bash
aws lightsail put-instance-public-ports --instance-name imgopt-production --port-infos \
  fromPort=22,toPort=22,protocol=TCP fromPort=80,toPort=80,protocol=TCP fromPort=443,toPort=443,protocol=TCP
```

Then provision it:

```bash
scp -r deploy/lightsail ubuntu@<static-ip>:/tmp/
ssh ubuntu@<static-ip> 'sudo bash /tmp/lightsail/provision.sh'
```

That installs Docker, lays out `/opt/imgopt`, closes the firewall, and schedules
reclamation. It starts nothing — there is no image tag yet.

## 7. Deploy the CDK stacks and build the image

Four stacks: Storage, Queue, Compute, Cdn — plus Observability. No network stack and no
data stack; see [`infra/cdk/README.md`](../infra/cdk/README.md).

`WORKER_CALLBACK_URL` and `WORKER_CALLBACK_SECRET` are required at synth: the Lambdas
carry them, and the same secret goes in the instance's `.env`. Generate it once:

```bash
export WORKER_CALLBACK_SECRET=$(openssl rand -hex 32)
export WORKER_CALLBACK_URL=https://api.example.com
export CONTROL_PLANE_INSTANCE_NAME=imgopt-production
```

The ECR repository has to exist before an image can be pushed to it. It is no longer in
the compute stack — there is no ECS service to reference it — so create it directly:

```bash
aws ecr create-repository --repository-name imgopt-api --image-tag-mutability IMMUTABLE
```

`IMMUTABLE` is not decoration: the tag is the rollback coordinate, and a mutable one
makes "redeploy the previous version" ambiguous.

```bash
aws ecr get-login-password --region $CDK_REGION \
  | docker login --username AWS --password-stdin $CDK_ACCOUNT.dkr.ecr.$CDK_REGION.amazonaws.com

docker build --platform linux/amd64 -f apps/api/Dockerfile \
  -t $CDK_ACCOUNT.dkr.ecr.$CDK_REGION.amazonaws.com/imgopt-api:v1 .
docker push $CDK_ACCOUNT.dkr.ecr.$CDK_REGION.amazonaws.com/imgopt-api:v1
export API_IMAGE_TAG=v1
```

`--platform linux/amd64` unless the Lightsail bundle is an arm one — the instance runs
what you build, and an architecture mismatch produces a container that pulls fine and
never starts.

```bash
pnpm --filter @imgopt/infra deploy -c env=production --all
```

## 8. Create the control plane's credentials

A Lightsail instance cannot assume an IAM role, so it authenticates with an access key
for the user the compute stack created. **The stack does not create the key** — a
CloudFormation-created key stays readable in the template's outputs forever.

```bash
aws iam create-access-key --user-name imgopt-production-control-plane
```

Put it, and everything else, into `/opt/imgopt/.env` — mode 0600, never committed. The
template is [`deploy/lightsail/.env.example`](../deploy/lightsail/.env.example).

The one to get right by hand: `DATABASE_URL`, using the endpoint and password from
step 5, and **ending in `?sslmode=require`**. The connection crosses the Lightsail
private network rather than a subnet you control.

`UPLOAD_MALWARE_SCAN_ENABLED` must match what the storage stack provisioned — the app
fails closed on a missing verdict, so claiming a scanner where none exists holds every
upload forever, and presents as a broken uploader rather than a configuration error.

## 9. First deploy

```bash
ssh ubuntu@<static-ip> '/opt/imgopt/deploy.sh v1'
```

That pulls the tag, runs migrations to completion, starts the stack, waits for health,
and **rolls back to the previous tag if the new one does not become healthy**. On a
first deploy there is no previous tag, so a failure leaves the stack up for inspection
and says so.

Migrations create `tenant_default`, which step 11's API key references.

## 10. Create the first API key

There is no unauthenticated bootstrap endpoint — issuing a key requires a key that can.
The first one is created out of band, against the database directly. It has to run on
the instance, because the instance is the only host that can reach the database:

```bash
ssh ubuntu@<static-ip>
cd /opt/imgopt

docker compose run --rm --entrypoint node api -e "
const { generateApiKey } = require('./apps/api/dist/modules/auth/api-key.js');
const k = generateApiKey();
console.log('PLAINTEXT (store now):', k.plaintext);
console.log(\"INSERT INTO api_keys (id, tenant_id, name, hash, permissions, created_at) VALUES ('\" +
  k.keyId + \"', 'tenant_default', 'bootstrap', '\" + k.hash + \"', ARRAY['read','upload','delete','admin'], now());\");
"
```

`tenant_default` is created by the migration in step 9, so it already exists — the
insert fails on a foreign key if you run it first, which is the intended order.

Run the emitted `INSERT` against the database, then use the plaintext to create properly
scoped keys through `POST /v1/keys`. Those are issued into the issuer's own tenant; the
endpoint takes no tenant id, because `admin` on any key would otherwise be a way to mint
credentials for someone else's data. Revoke the bootstrap key afterwards.

Quota is accounted on the **tenant**, not the key, so issuing a second key does not
grant a second allowance.

## 11. Point Cloudflare at it

The distribution's hostname only exists once the CDN stack does, and the control
plane's address is the static IP from step 6:

```bash
export API_STATIC_IP=<static-ip>
pnpm --filter @imgopt/cloudflare dns
```

Read the plan, then re-run with `--apply`. Two records: a **CNAME** for the CDN host
onto the distribution, and an **A** record for the API host onto the instance. Both
**proxy off**; see [DNS and certificates](#dns-and-certificates) for why that is not a
preference.

Caddy obtains the control plane's certificate the first time the hostname resolves to
the instance and a request arrives on port 443. Watch it happen:

```bash
ssh ubuntu@<static-ip> 'cd /opt/imgopt && docker compose logs caddy | tail -20'
curl -sI https://api.example.com/healthz | head -1
```

## 12. Verify

```bash
pnpm --filter @imgopt/infra smoke -- --env production
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

Export the line it prints as `CDN_CERTIFICATE_ARN` before deploying.

**One certificate.** CloudFront accepts a viewer certificate only from `us-east-1`, so
that is where this one lives. The control plane's is not an ACM certificate at all —
Caddy obtains it from Let's Encrypt on the instance and renews it without a cron entry
to forget, which is the part of certificate management that fails silently eleven months
later.

**Leave the validation records alone afterwards.** ACM re-checks them to renew, roughly
every eleven months; deleting them turns renewal into a silent failure that surfaces as
an expired certificate on a date nobody has in a calendar.

**After each deploy — DNS.** The distribution's hostname is assigned by AWS and read
from a stack output; the control plane's address is the static IP attached in step 6 and
passed as `API_STATIC_IP`, since Lightsail is not a CloudFormation resource:

```bash
pnpm --filter @imgopt/cloudflare dns
```

That prints a plan and writes nothing. Add `--apply` when it looks right. Re-run it
after any deploy that could replace the distribution, and after any change to the
instance's static IP.

**The proxy must stay off** — grey cloud, not orange. Cloudflare's proxy caches by URL
and honours `Vary` only for `Accept-Encoding`, while this service returns AVIF, WebP or
JPEG from one URL depending on the viewer's `Accept`. Proxied, Cloudflare caches
whichever format the first visitor received and serves it to everyone — AVIF to
browsers that cannot decode it, with nothing in any log to explain the broken images.
The reconciler turns the proxy off rather than reporting it.

**Without a domain** the CDK half still deploys: the distribution serves on its own
`*.cloudfront.net` name. The control plane needs a hostname regardless, because Caddy
obtains its certificate for one — reach it by IP over plain HTTP only while setting up.

## Production

Same steps with `-c env=production`. The tier differences left in `lib/config.ts` are
`PriceClass_All`, higher Lambda concurrency, and malware scanning on by default — the
database and compute sizing moved out with RDS and Fargate, and are now Lightsail bundle
choices made in steps 5 and 6.

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
| Lightsail PostgreSQL                | the registry is the deployment's, and quotas are accounted in it           |
| CloudFront distribution + function  | one origin, one edge normalizer, one cache                                 |
| SQS optimize + dead-letter queues   | a shared queue would hand one deployment's job to another's worker         |
| Both Lambdas                        | each carries its own bucket and queue in its environment                   |
| Lightsail instance and database     | one instance runs the control plane, Caddy, and reclamation                |
| Hostnames (CDN and API)             | an alias belongs to exactly one distribution                               |
| One ACM certificate                 | us-east-1, for CloudFront. The control plane's comes from Caddy            |
| Two Cloudflare CNAMEs, grey-clouded | see [DNS and certificates](#dns-and-certificates)                          |
| Instance + managed database         | the fixed cost floor; see [tuning.md](tuning.md#cost-floor-per-deployment) |

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
