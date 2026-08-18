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
quota accounting and is referenced by the assets that key uploaded, and destroying that
history during an incident is the last thing anyone wants.

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
