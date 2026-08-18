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

| Variable                      | Required | Meaning                                       |
| ----------------------------- | -------- | --------------------------------------------- |
| `CDK_ACCOUNT`                 | yes      | target AWS account id                         |
| `CDK_REGION`                  | no       | defaults to `us-east-1`                       |
| `CDN_HOST`                    | yes      | public delivery hostname                      |
| `API_HOST`                    | no       | public control-plane hostname                 |
| `HOSTED_ZONE_ID`              | no       | Route 53 zone id, when DNS is in this account |
| `HOSTED_ZONE_NAME`            | no       | zone name, e.g. `example.com`                 |
| `CDN_CERTIFICATE_ARN`         | no       | pre-issued **us-east-1** certificate          |
| `API_IMAGE_TAG`               | no       | control-plane image tag, defaults to `latest` |
| `MALWARE_SCANNING`            | no       | GuardDuty on `staging/`; on in production     |
| `PRIVATE_DELIVERY_PUBLIC_KEY` | no       | PEM public key enabling signed-URL delivery   |

Named environments live in `lib/config.ts`. Each gets its own bucket, database,
distribution, domain, and queues — nothing is shared, and staging cannot read
production's data.

### DNS

Supply `HOSTED_ZONE_ID` and `HOSTED_ZONE_NAME` and the certificate is issued and
validated automatically and the alias records are created. Supply neither and the
deployment still succeeds: the distribution serves on its own `*.cloudfront.net`
name, and the `ManualDnsRecord` output names the record to create by hand. An
externally managed zone is a normal arrangement, not a blocker.

The zone is referenced by id rather than looked up, deliberately — a `fromLookup`
needs credentials at synth time, which would put an AWS account between a
contributor and `pnpm test`.

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
The post-deploy smoke test exists to catch it if this ever regresses.

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
