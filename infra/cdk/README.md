# Infrastructure

CDK app for the deployable stack. Six stacks, split by how often they change and how
much damage a mistake does.

| Stack     | Changes       | Holds                                         |
| --------- | ------------- | --------------------------------------------- |
| `Network` | rarely        | VPC, subnets, every security group and rule   |
| `Storage` | never         | the asset bucket, retained                    |
| `Data`    | never         | PostgreSQL, retained                          |
| `Queue`   | rarely        | optimize queue + dead-letter queue            |
| `Compute` | every release | both Lambdas, Fargate service, migration task |
| `Cdn`     | occasionally  | distribution, edge function, DNS              |

The split is the point: shipping application code touches `Compute` only, and can
never present CloudFormation with a plan that replaces the bucket holding every
original.

## Configuration

Everything comes from the environment, so no account id or hostname is committed.

| Variable                      | Required            | Meaning                                                           |
| ----------------------------- | ------------------- | ----------------------------------------------------------------- |
| `CDK_ACCOUNT`                 | yes                 | target AWS account id                                             |
| `CDK_REGION`                  | no                  | defaults to `us-east-1`                                           |
| `CDN_HOST`                    | yes                 | public delivery hostname                                          |
| `API_HOST`                    | production          | public control-plane hostname                                     |
| `CDN_CERTIFICATE_ARN`         | for a custom domain | pre-issued **us-east-1** certificate; see DNS below               |
| `API_CERTIFICATE_ARN`         | production          | pre-issued certificate in **this region**; synth fails without it |
| `API_IMAGE_TAG`               | yes                 | control-plane image tag; `latest` is refused                      |
| `CDN_DISTRIBUTION_ID`         | no                  | pins the bucket read grant to one distribution; set on redeploy   |
| `MALWARE_SCANNING`            | no                  | GuardDuty on `staging/`; on in production                         |
| `PRIVATE_DELIVERY_PUBLIC_KEY` | no                  | PEM public key enabling signed-URL delivery                       |

Every variable can be prefixed with the deployment's own name, upper-cased:
`DEMO_CDN_HOST` wins over `CDN_HOST` when deploying `demo`. The bare name is the
fallback, so a single-deployment account never needs a prefix — but two deployments
sharing one account **must** set at least their own `*_CDN_HOST`, since two
distributions cannot claim one alias.

DNS credentials are not read by the CDK at all — `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ZONE_ID` belong to [`infra/cloudflare`](../cloudflare/README.md).

### The deployment manifest

`DEPLOYMENTS` in `lib/config.ts` lists every deployment. Each entry names itself and
picks a _tier_ — `staging` or `production` — which is only a sizing profile: database
class, task count, CDN price class, whether malware scanning defaults on.

```ts
export const DEPLOYMENTS: DeploymentEntry[] = [
  { name: 'staging', tier: 'staging' },
  { name: 'production', tier: 'production' },
  { name: 'demo', tier: 'staging' },
];
```

Each deployment gets its own bucket, database, distribution, domain, and queues —
nothing is shared, and no resource name is derivable from another deployment's. That
isolation is also what makes a deployment the tenant boundary: **a second application
is a second entry here**, not a second code path. See
[docs/bootstrap.md](../../docs/bootstrap.md#onboarding-another-application) for the
out-of-band work each one still needs, and `openspec/changes/multi-tenancy/design.md`
T2 for why the boundary is the deployment rather than the URL.

`resolveAllDeployments()` builds every entry at once and refuses two that claim the
same hostname or bucket. Worth running before adding an entry: CloudFront reports a
duplicate alias as `CNAMEAlreadyExists` partway through the _second_ deployment, once
the first is already created.

### DNS

**This app creates no DNS records and issues no certificates.** DNS is in Cloudflare
(design.md D18), and CloudFormation can only write a hosted zone it owns — point a
DNS-validated certificate at an external zone and the stack does not fail, it _waits_,
holding the deploy open until CloudFormation gives up hours later.

So the two halves are split:

- **Certificates** are requested ahead of the deploy by
  [`infra/cloudflare`](../cloudflare/README.md), which writes the validation record
  into the zone, waits for issuance, and prints the ARNs to set here. Two of them:
  CloudFront accepts a viewer certificate only from `us-east-1`, an ALB only from its
  own region.
- **Records** are reconciled after the deploy by the same package, from the
  `CdnDnsTarget` and `ApiDnsTarget` outputs. Every record is created with the
  **proxy off** — an orange-clouded record caches one image format for every viewer.

Without a certificate the deployment still succeeds: the distribution serves on its
own `*.cloudfront.net` name and the load balancer on its own DNS name. Staging may run
that way; production synthesis fails without an API certificate.

### Region constraint

The observability stack is deployable **only to `us-east-1`** while it owns CloudFront
alarms: CloudFront publishes `CacheHitRate` and `5xxErrorRate` only there, and
CloudWatch refuses an alarm on a metric from another region. Everything else deploys
anywhere — the distribution's certificate is a literal ARN, so a `us-east-1`
certificate attaches from a stack in any region with no cross-region machinery.

Moving the deployment out of `us-east-1` therefore means splitting the two CloudFront
alarms into their own `us-east-1` stack with its own SNS topic, which is an operator
wart (two subscriptions to confirm) rather than a code change. Not done, because
nothing has been deployed yet and the region has not been chosen.

## Release order

Artifacts first. CDK will happily package a missing bundle and deploy a function that
fails on its first invocation, so `lib/artifacts.ts` checks each path and names the
command that produces it.

```bash
pnpm --filter @imgopt/edge generate       # the CloudFront Function, from packages/core
pnpm --filter @imgopt/infra build:bundles # esbuild output for both Lambdas
pnpm --filter @imgopt/infra build:layer   # sharp, built in a linux/arm64 container
```

Then, first time only, build and push the control-plane image. The `Compute` stack
references an ECR repository by tag, so the repository has to exist and hold that tag
before the service can start:

```bash
pnpm --filter @imgopt/infra deploy -c env=staging Imgopt-staging-Compute/ApiRepository
# --platform is required: the task definitions declare X86_64, and an arm64 image
# deploys cleanly and then never starts.
docker build --platform linux/amd64 -f apps/api/Dockerfile -t <repositoryUri>:<tag> .
docker push <repositoryUri>:<tag>
```

Then deploy, run migrations, and smoke-test:

```bash
pnpm --filter @imgopt/infra deploy -c env=staging --all
aws ecs run-task --cluster <ClusterName> --task-definition <MigrationTaskDefinition> \
  --launch-type FARGATE --network-configuration '...'
pnpm --filter @imgopt/infra smoke -- --env staging --asset <assetId>
```

Migrations are a one-off task, never a container entrypoint. Several tasks starting
at once would otherwise race to apply the same migration, and the result of that is a
half-migrated schema rather than a clean error.

## The sharp layer

`scripts/build-sharp-layer.sh` builds sharp inside `public.ecr.aws/sam/build-nodejs22.x`
for `linux/arm64`. This is not ceremony: sharp ships prebuilt libvips binaries per
platform and npm resolves them for the host doing the install, so a layer built on a
macOS or x86 workstation deploys perfectly and then throws

```
Could not load the "sharp" module using the linux-arm64 runtime
```

on its first real invocation — in front of a viewer, after CI was green. Building in
the runtime's own image makes the artifact independent of whoever ran the release.

**Verify it without deploying.** On an x86 host this needs one-time arm64 emulation
(`docker run --privileged --rm tonistiigi/binfmt --install arm64`, reversible with
`--uninstall`). Then load each bundle exactly the way Lambda does — the layer mounted
at `/opt/nodejs`, exposed through `NODE_PATH`:

```bash
docker run --rm --platform linux/arm64 \
  -v "$PWD/apps/generator/dist-bundle:/var/task:ro" \
  -v "$PWD/infra/cdk/layers/sharp/nodejs:/opt/nodejs:ro" \
  -w /var/task -e NODE_PATH=/opt/nodejs/node_modules \
  -e AWS_REGION=us-east-1 -e S3_BUCKET=x -e CDN_HOST=x \
  -e SQS_OPTIMIZE_QUEUE_URL=x -e DATABASE_URL=postgres://u:p@127.0.0.1:5432/d \
  public.ecr.aws/sam/build-nodejs22.x:latest-arm64 \
  node -e "import('/var/task/index.mjs').then(m => console.log(typeof m.handler))"
```

`function` means the whole init path works: the ESM bundle loaded, it reached sharp
through the layer, and the handler is exported under the name `index.handler` resolves
to. That is the closest check available to a real invocation, and it catches both
failure modes the `.mjs` rename and the `createRequire` shim exist for. The
post-deploy smoke test is the backstop if this ever regresses.

## Verification without an account

```bash
pnpm --filter @imgopt/infra test
```

Synthesizes every stack for every environment and asserts the properties whose
failure modes are silent or expensive — failover on 403, a path-only cache key,
retention on stateful resources, prefix-scoped IAM.

`cdk synth` itself needs credentials even though it deploys nothing: resolving a
VPC's availability zones for a concrete account is a context lookup. That is why the
CI gate is the vitest suite above, which synthesizes through `Template.fromStack`
and needs no account.

## Things that will bite

**Origin failover is on 403, not just 404.** With OAC and no `s3:ListBucket`, S3
reports a missing key as 403. Configure only 404 and every ungenerated variant shows
the viewer an access-denied error instead of an image — and only for variants nobody
has requested yet, so it survives testing.

**The CDN stack imports the bucket by name.** Passing the construct makes CDK attach
the OAC policy to the bucket in the storage stack, referencing the distribution:
storage then depends on CDN, CDN on compute, compute on storage. CloudFormation
rejects the cycle and reports it as a wall of unrelated route-table associations. The
read grant is written explicitly in `StorageStack` instead. CDK logs
`Cannot update bucket policy of an imported bucket` — that is the intended outcome
here, not a warning to fix.

**All security groups live in the network stack**, including the ones describing
compute. A rule is created in whichever stack calls `allowFrom`, so wiring the load
balancer to the tasks from the compute stack writes a rule into the network stack
that points back at compute — the same cycle, with the same unreadable error.

**"Deny unencrypted writes" is narrower than it looks.** The obvious policy denies
requests without an `x-amz-server-side-encryption` header, which is every write this
service makes: default encryption applies server-side and the request never carries
the header. That policy breaks all uploads while looking correct in review. See the
comment on `DenyExplicitlyUnencryptedWrites`.

**Malware scanning has two switches that must agree.** `MALWARE_SCANNING` provisions
GuardDuty here and sets `UPLOAD_MALWARE_SCAN_ENABLED` on the control plane from the
same value. The app fails closed on a missing verdict, so an app that believes a
scanner exists where none does holds every upload forever — which presents as a
broken uploader, not as a configuration error.

**Signed-URL delivery is a separate cache behavior, not a flag.** Trusted key groups
apply per behavior, so enabling them on the default behavior would require a
signature for every public image in the deployment. Private assets are served under
`/p/*` instead, which is also why an asset's privacy is expressed in its URL.

**The maintenance worker holds the only role that can delete an original.** That is
deliberate — reclaiming a superseded version means deleting its source — and it is why
every job in `apps/maintenance` is written to fail toward keeping objects: a safety
window, a per-run deletion cap, and unparseable keys left in place. Run it with
`MAINTENANCE_DRY_RUN=true` the first time; the report says what it would reclaim.

**Bumping `SHARP_VERSION` is an encoder-epoch decision.** A libvips upgrade can
change encoder output, and every derivative already cached at the edge was produced
by the previous one. See design.md D8.
