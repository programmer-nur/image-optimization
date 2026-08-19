# Operations runbook

> Written against the stack definitions rather than against a running deployment —
> nothing here has been executed in anger. Correct it as you go.

## Every request is regenerating

**The most important failure in this system, and the only one that produces no
errors.**

Symptom: `OnDemandGenerations` stays flat instead of decaying. Possibly a Lambda bill
climbing with traffic. Status codes are 200, latency is normal, images are correct,
and no error metric moves at all.

Cause, in order of likelihood:

1. **Edge/core normalization drift.** The CloudFront Function computes cache key A
   while the generator writes object B. Every request misses forever.
2. `encoderEpoch` changed without the client SDK being updated, so clients request an
   epoch nothing has been generated for.
3. The conditional write is failing, so nothing is ever persisted.

Diagnose:

```bash
# 1. Do the edge and the core still agree?
pnpm --filter @imgopt/edge test

# 2. Is the deployed function the current artifact?
pnpm --filter @imgopt/edge generate
git diff --stat infra/cloudfront/normalize.generated.js     # must be empty
aws cloudfront describe-function --name imgopt-<env>-normalize --stage LIVE

# 3. Is anything actually landing in the bucket?
aws s3 ls s3://<bucket>/derived/<assetId>/ --recursive
```

Then request one URL twice and compare `x-cache`. Miss twice means the object is not
being written where the edge is looking. Fetch the same URL and list the bucket — the
key the generator wrote and the path CloudFront requested will differ, and the diff
tells you which side drifted.

`RedundantGenerations` is the sharper signal if it is non-zero: it counts generations
whose conditional write found the object **already present**, which has no innocent
explanation beyond two concurrent first requests racing.

Fix: regenerate the edge function from `packages/core`, redeploy the CDN stack, and add
a conformance vector covering whatever diverged. Never hand-edit the generated file.

## Changing encoder policy (the epoch procedure)

Bump `encoderEpoch` when encoder output should change for already-published assets: a
quality audit, a codec setting change, or a libvips upgrade that alters output.

**What it does.** The version segment is `v{assetVersion}-{encoderEpoch}`. Bumping the
epoch mints an entirely new URL space for every asset at once, with **no per-asset
database write and no CDN invalidation**. Old derivatives keep serving their old URLs
until lifecycle reclaims them.

This is the escape hatch that makes `Cache-Control: immutable` safe to promise.
Without it, "immutable" would mean "we can never change our encoder settings".

Procedure:

1. Change `encoderEpoch` in `infra/cdk/lib/config.ts` for the environment.
2. Deploy Compute (the Lambdas read it) and Cdn.
3. Update every consumer's `createImageClient({ encoderEpoch })`. **Until this
   happens, clients keep requesting the old epoch** — which still works, because those
   objects still exist. That is the point: there is no flag day.
4. Expect `OnDemandGenerations` to rise as the new space fills, then decay. That rise
   is legitimate and will trip the alarm if it is broad; note it before it pages
   someone.
5. Old derivatives are reclaimed by the maintenance job's orphan pass once nothing
   references them.

Bumping `SHARP_VERSION` in the layer build is an epoch-level decision for the same
reason: a libvips upgrade can change output, and every cached derivative was produced
by the previous one.

## Dead-letter queue has messages

Expected steady-state depth is zero, so the alarm has no tolerance. Anything here
failed five times.

```bash
aws sqs receive-message --queue-url <dlq-url> \
  --max-number-of-messages 10 --visibility-timeout 30
```

The body is `{ assetId, assetVersion, correlationId }`. Filter the optimizer's logs by
that `correlationId` for the actual failure.

Terminal failures — a corrupt source, an unsupported format — are recorded on the asset
and acknowledged rather than retried, so they should **not** reach the DLQ. A message
here means something retriable failed repeatedly: storage unreachable, the database
down, or a genuine bug.

Replay after fixing the cause:

```bash
aws sqs start-message-move-task \
  --source-arn <dlq-arn> --destination-arn <optimize-queue-arn>
```

Processing is idempotent — reprocessing yields no duplicate derivatives — so replaying
a message that already partly succeeded is safe.

Alternatively, `POST /v1/images/:id/reprocess` re-enqueues one asset's warm set.

## Queue is backing up

`ApproximateAgeOfOldestMessage` rising means the worker has stalled or is failing
repeatedly. Uploads still succeed — the bytes are durable before the enqueue — but
assets never reach `ready`, so they have no LQIP and no warm set.

Check the optimizer's error rate and concurrency first. A common cause is the database
being unreachable from the Lambda: the worker needs it for every job, and it will fail
every message uniformly.

## Cache hit ratio has dropped

Usually cache-key fragmentation — a parameter reaching the cache key that should have
been normalized away.

0. Confirm the metric is real. `CacheHitRate` is an _additional_ CloudFront metric and
   is published only while the distribution's monitoring subscription exists — without
   it the alarm sits in INSUFFICIENT_DATA and reads as healthy, so a hit rate that
   "looks fine" is worth verifying against the graph before trusting it.
1. Confirm the cache policy still includes **no** query strings, headers, or cookies.
2. Confirm the edge function is attached on viewer-request. An unattached function
   passes the query string straight through, and every distinct URL becomes its own
   entry.
3. Check whether a consumer started hand-writing URLs off the ladder.

A drop after a client release almost always means a `sizes` change altered the
candidate set, so browsers are requesting widths nothing has generated yet. That
resolves on its own as the new set fills.

## An upload is stuck

Check the asset's `status`:

- **`pending_upload` for hours** — either the client never called complete, or the
  upload is _held_ awaiting a malware verdict. If `UPLOAD_MALWARE_SCAN_ENABLED` is
  true but no scanner is provisioned, **every** upload is held forever and looks like
  a broken uploader. Verify GuardDuty is actually attached to the staging prefix.
- **`rejected`** — terminal, with a `failureReason`. Retrying identical bytes cannot
  help.
- **`failed`** — recoverable; use reprocess.
- **`stored` but never `ready`** — the optimize job did not complete, or was never
  queued at all. A failed enqueue cannot fail an upload (the bytes are already
  durable), so the job is simply lost. The daily maintenance run re-enqueues anything
  left in `stored` past `STALLED_OPTIMIZE_HOURS`, capped at `MAX_REENQUEUES_PER_RUN`
  per run — so the first question is whether that run is happening at all. Check the
  `maintenance-stalled` alarm before investigating the optimizer.

## Cost review

Bandwidth is ~75% of the bill, so start there.

| Question                               | Where                                                      |
| -------------------------------------- | ---------------------------------------------------------- |
| Modern-format share                    | `BytesServed` by `Format` on the dashboard                 |
| Is compute tracking assets or traffic? | `OnDemandGenerations` — must decay                         |
| What is stored, and as what            | maintenance run report (originals / masters / derivatives) |
| Is the warm set earning its keep?      | `GenerationCount` by `Source` — warm versus ondemand       |

Levers, roughly in order of effect:

1. **Modern-format adoption.** If AVIF's share of `BytesServed` is low, check that the
   edge sees a real `Accept` header — an intermediary that strips or rewrites it forces
   the JPEG branch for everyone.
2. **`PriceClass`.** Edge coverage is directly billed; `PriceClass_100` is materially
   cheaper if your traffic is US/EU.
3. **Warm set width.** Each additional warm width is one more object per asset,
   generated whether or not anyone views it. On a UGC archive where most images are
   never viewed, this is pure waste; on a product catalog it is a latency win.
4. **Originals tiering.** They are read rarely once the warm set exists.

`pnpm --filter @imgopt/infra load-test -- --env staging --assets <ids>` measures hit
ratio, generations per asset, and cost per thousand images. It fails the run when
generations exceed distinct variants, which is the bounded-variant-space claim stated
as an assertion.

## Reclaiming storage

The maintenance Lambda runs daily. To run it now, or to see what it _would_ do:

```bash
aws lambda invoke --function-name imgopt-<env>-maintenance /dev/stdout
```

The response is the report: what was examined, what was reclaimed, and how much is
stored.

**Run it with `MAINTENANCE_DRY_RUN=true` the first time after any change to the
windows.** Every deletion is irreversible and the objects include originals.

If `orphans.unparsed` is non-zero, investigate before doing anything else — it means
objects exist whose keys this code does not recognize, which usually means the code is
out of date rather than that the objects are junk. They are deliberately left in place.

## Deleting an asset

`DELETE /v1/images/:id` soft-deletes the row, removes objects under its prefixes, and
issues a wildcard CDN invalidation scoped to that asset's delivery path.

**This is the only situation that warrants invalidation.** Routine content changes go
through a new version, which is a new URL and needs none. Invalidating for a content
change is a sign someone has misunderstood the version segment.

## Rotating an API key

```bash
curl -X POST https://api/v1/keys -H "x-api-key: $ADMIN" \
  -d '{"name":"replacement","permissions":["upload"]}'
# store the plaintext now — only a hash is kept
curl -X DELETE https://api/v1/keys/<oldKeyId> -H "x-api-key: $ADMIN"
```

Revocation takes effect on the next request. It is a soft delete: the row carries the
per-key usage counters and is referenced by the assets that key uploaded, and
destroying that history during an incident is the last thing anyone wants.

Revoking a key does **not** return its storage to the tenant's allowance, and should
not: the bytes are still stored. The tenant's `used_bytes`/`used_assets` are the
accounting unit, and they fall when assets are deleted, not when keys are.

## Running SQL, or anything else, against the database

The database lives in isolated subnets: nothing reaches it from outside the VPC, and
there is no bastion. That is deliberate, and it means "just connect and run a query"
is not available. The sanctioned path is the migration task definition, which already
carries the connection parts and the password secret — override its command instead of
opening a shell:

```bash
aws ecs run-task \
  --cluster "$(aws cloudformation describe-stacks --stack-name Imgopt-staging-Compute \
      --query "Stacks[0].Outputs[?OutputKey=='ClusterName'].OutputValue" --output text)" \
  --task-definition "$(aws cloudformation describe-stacks --stack-name Imgopt-staging-Compute \
      --query "Stacks[0].Outputs[?OutputKey=='MigrationTaskDefinition'].OutputValue" --output text)" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"migrate","command":["node","packages/db/scripts/migrate.mjs"]}]}'
```

`$SUBNETS` and `$SG` are the `MigrationSubnetIds` and `MigrationSecurityGroupId`
outputs of the same stack — they are emitted precisely because finding them by hand is
where this procedure stalls.

Swap the `command` for any script the image ships. The image contains no `psql`, so
this is a Node entry point, not a SQL prompt; write the one-off as a script rather than
reaching for a shell.

## A malware verdict arrives after promotion

Scanning is asynchronous, so a `THREATS_FOUND` verdict can land after an upload has
already been promoted — the fail-open path admits exactly this, and it is the reason
fail-closed is the default.

The quarantine handler covers `staging/` only. Once bytes are under `original/`,
removing them is an operator action:

```bash
curl -X DELETE "https://$API/v1/images/$ASSET_ID" -H "x-api-key: $ADMIN"
# then purge the noncurrent versions, or the bytes remain for the recovery window
aws s3api list-object-versions --bucket "$BUCKET" --prefix "original/$ASSET_ID/"
aws s3api delete-object --bucket "$BUCKET" --key "$KEY" --version-id "$VERSION_ID"
```

**Viewers were never exposed to the file itself.** Delivered bytes are always
re-encoded pipeline output, so a polyglot or an embedded payload does not survive into
a derivative — that is a structural property, not a detection result. What is at stake
is the object at rest and anything that later reads originals directly.

## The certificate is about to expire, or DNS looks wrong

Both live outside the CDK; nothing in a redeploy touches them.

**Certificates.** ACM renews automatically _provided its validation CNAME is still in
Cloudflare_. That record is permanent by design, and deleting it after issuance is the
one failure mode here: renewal fails quietly and the certificate expires roughly eleven
months later, on a date nobody is watching.

```bash
aws acm describe-certificate --certificate-arn "$CDN_CERTIFICATE_ARN"   --region us-east-1 --query 'Certificate.[Status,NotAfter,RenewalSummary]'
```

`RenewalEligibility: INELIGIBLE` or a `PENDING_VALIDATION` renewal means the record is
gone — recreate it from `DomainValidationOptions.ResourceRecord` in the same output.

**Records.** The distribution and load balancer hostnames change if a stack is ever
replaced, so DNS is reconciled from stack outputs rather than remembered:

```bash
pnpm --filter @imgopt/cloudflare dns
```

Prints a plan; `--apply` writes it. If images are broken for _some_ viewers and fine
for others, check the proxy status first — an orange-clouded record caches one image
format and serves it to everyone, and that is invisible in CloudFront's metrics
because those requests never reach CloudFront.

## Restore and disaster recovery

Read this before you need it. The recovery story differs per store, and only one of
them is a restore in the usual sense.

**S3 is the authority, and it is versioned.** Every derivative can be regenerated from
its original, so the only irreplaceable bytes are under `original/`. The bucket keeps
noncurrent versions, so a delete — by a defect, a bad reclamation run, or a mistaken
`DELETE /v1/images/:id` — leaves a delete marker with the object beneath it:

```bash
# What versions exist for one key
aws s3api list-object-versions --bucket "$BUCKET" --prefix "original/$ASSET_ID/"

# Undo a delete: remove the marker, and the previous version becomes current again
aws s3api delete-object --bucket "$BUCKET" --key "$KEY" --version-id "$DELETE_MARKER_ID"
```

The recovery window is `noncurrentVersionExpiryDays` (30 by default), and one day for
`staging/`. Past that the bytes are gone. **A legal takedown therefore needs both
steps** — delete the object, then delete its noncurrent versions by id — or the bytes
remain in the bucket for the retention window.

**PostgreSQL restores by point in time.** Automated backups retain 3 days in staging
and 14 in production (`infra/cdk/lib/config.ts`). RDS restores to a _new instance_, so
a restore is a cutover:

1. `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier <id> --target-db-instance-identifier <id>-restored --restore-time <iso8601>`
2. Point the compute stack at the restored instance and redeploy, or rename the
   instances during a maintenance window.
3. Reconcile. This is the part that is unusually forgiving here: the registry is
   _bookkeeping_, not the authority. Objects the restored registry has never heard of
   are not orphans to be deleted — the maintenance job's safety window and
   fail-toward-keeping posture handle exactly this case, and the generator rewrites
   missing derivative rows on the next miss for each key. Run the maintenance job in
   dry-run first (`MAINTENANCE_DRY_RUN=true`) and read the report before letting it
   delete anything after a restore.

**What a database restore cannot recover** is an asset whose row was created after the
restore point: its objects exist, and nothing references them. They are collected as
orphans once they age past the safety window, which is the correct outcome.

**Practise it on staging.** None of the above has been executed against a real AWS
account — see the deployment-verification items in the release checklist.

## Migrating off Lightsail

Both migrations are reversals of _hosting_, not of architecture. Neither touches domain
logic, and that is a property the code pays for deliberately: the application reads one
database variable and holds no state on local disk (design.md L5, L7).

Do them separately. Moving the database and the compute in one change means a failure
you cannot attribute.

### Lightsail PostgreSQL → Amazon RDS

**Triggers.** Any one of: needing Multi-AZ, needing a read replica, outgrowing the
largest Lightsail database plan, or wanting the database back inside a VPC you control.

```text
Lightsail PostgreSQL → pg_dump → RDS → restore → DATABASE_URL → migrate → verify → cut over
```

1. **Provision RDS** in the deployment's region, PostgreSQL 16, in private subnets, with
   a security group admitting only the control plane. Note the endpoint.

2. **Dump.** From the control-plane instance, which is the only host that can reach the
   Lightsail database:

   ```bash
   docker compose exec -T api pg_dump "$DATABASE_URL" --no-owner --no-acl -Fc > /tmp/imgopt.dump
   ```

   `-Fc` (custom format) rather than plain SQL: it restores in parallel and it lets you
   restore selectively if something goes wrong halfway.

3. **Stop writes.** `docker compose stop api` — reclamation is cron-driven, so also
   comment out its crontab entry for the duration. The delivery plane keeps serving
   throughout; this is an outage for uploads and the admin API only.

   Take the dump _again_ after stopping. The first one told you how long it takes and
   whether it works; this one is the one you restore.

4. **Restore.**

   ```bash
   pg_restore --no-owner --no-acl -d "postgresql://imgopt:PASSWORD@NEW-ENDPOINT:5432/imgopt?sslmode=require" /tmp/imgopt.dump
   ```

5. **Point at it.** Edit `DATABASE_URL` in `/opt/imgopt/.env`. That is the whole of the
   application-side change — there is no other place the database is named.

6. **Migrate.** `docker compose run --rm migrate`. Expect "No pending migrations": the
   dump carried the schema. A pending migration here means the dump predates a deploy,
   and it is applied now rather than discovered later.

7. **Verify before cutting over.**

   ```bash
   docker compose up -d api
   curl -s localhost:3000/readyz          # database: ok
   curl -s localhost:3000/v1/images?limit=1 -H "x-api-key: $KEY"
   ```

   Compare row counts against the old database — `assets`, `asset_versions`,
   `derivatives`, `api_keys`, `tenants` — before deleting anything.

8. **Restore the cron entry.** Reclamation deletes objects; leaving it disabled is safe,
   and leaving it disabled _by accident_ is how storage quietly doubles.

**Keep the Lightsail database for a week.** It costs $15 and it is the only rollback:
put the old `DATABASE_URL` back and restart. Writes made against RDS in the interim are
lost by that rollback, which is the reason to decide quickly rather than to keep the
option open indefinitely.

### Lightsail instance → ECS / EC2 / App Runner

**Triggers.** Any one of: needing more than one replica, needing zero-downtime deploys,
the instance becoming the thing you are paged about, or wanting the static AWS
credential gone.

**The credential is the strongest of those.** A Lightsail instance cannot assume an IAM
role, so the control plane authenticates with a long-lived access key on disk. Every
compute service in this list supports task or instance roles, and moving deletes the
key rather than rotating it.

**What moves:** the same image, the same environment file, a different scheduler. The
API is stateless — no local disk, no sticky sessions, no in-process cache — so nothing
contends when a second replica starts.

**What must change with it**, and would be a silent regression if it did not:

| Concern           | On one instance                    | With more than one                                                                                                                                                |
| ----------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate limiting     | in-process, correct at one replica | **becomes per-replica** — an attacker's budget multiplies by replica count. Move it back to a WAF on the load balancer, or to a shared counter. See design.md L4. |
| `x-forwarded-for` | trusted, Caddy is the only way in  | trust only the load balancer, and only its right-most hop                                                                                                         |
| TLS               | Caddy, self-renewing               | ACM on the load balancer; `pnpm --filter @imgopt/cloudflare certs` issues the regional certificate again                                                          |
| DNS               | `A` record → static IP             | `CNAME` → the load balancer's hostname; set `API_STATIC_IP` aside                                                                                                 |
| Reclamation       | cron on the host                   | a scheduled task, and **exactly one** — the run lock is per-host, so two hosts running it concurrently is not something the lock prevents                         |
| Migrations        | `docker compose run --rm migrate`  | a one-off task before the new version takes traffic, never an entrypoint                                                                                          |
| Credentials       | access key in `.env`               | a task role; delete the IAM user the compute stack creates                                                                                                        |

Reclamation is the one that bites quietly: two hosts each running it on a schedule would
each delete up to `MAX_DELETIONS_PER_RUN`, and the per-run cap exists precisely to bound
how much one mistake destroys.
