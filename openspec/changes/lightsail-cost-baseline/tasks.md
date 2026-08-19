# Lightsail cost baseline

Ordered so the application stops needing the VPC before the VPC is deleted. Doing it
the other way round leaves a window where the workers cannot reach the database.

## 1. The control plane gains an internal worker surface

- [x] 1.1 Add a `WorkerGuard` authenticating a shared secret with `timingSafeEqual`, refusing an absent or empty secret rather than treating it as a match
- [x] 1.2 Require `WORKER_CALLBACK_SECRET` in `packages/config` — startup MUST fail without it, since a control plane that serves the internal prefix unauthenticated is worse than one that does not start
- [x] 1.3 Add `GET /internal/v1/optimize/:assetId` returning the job context the optimizer needs: current version, source key, deleted state
- [x] 1.4 Add `POST /internal/v1/optimize/:assetId/complete` applying version metadata and readiness **in one transaction** — four independent writes from a queue consumer is the shape that leaves an asset half-processed
- [x] 1.5 Add `POST /internal/v1/derivatives` recording a generated derivative; idempotent, because the generator retries and CloudFront may race two misses onto one key
- [x] 1.6 Narrow the `no-restricted-imports` allowlist so `UnscopedAssetRepository` is importable in `apps/api` **only** from the internal module's directory — the exception must stay visible in review
- [x] 1.7 Assert the two credential types are not interchangeable: an API key MUST be refused on the internal prefix, and the worker secret MUST be refused on the public API

## 2. Workers stop holding a database connection

- [x] 2.1 Define a `RegistryPort` in the optimizer covering exactly the four operations it uses, and an HTTP adapter for it
- [x] 2.2 Replace the generator's `RecordDerivative` sink with an HTTP adapter — the injection point already exists in its handler, and its failure is already swallowed by design
- [x] 2.3 Delete `DB_SECRET_ARN` and `hydrateDatabaseCredentials` from both workers; remove the Secrets Manager dependency from their bundles
- [x] 2.4 Verify the bundles shrink and still initialize on arm64 with the sharp layer — a dropped dependency that breaks init fails on every invocation, not on a test
- [x] 2.5 Keep the maintenance worker's direct database access, and add a CLI entry point so it runs as a scheduled container rather than a Lambda handler
- [x] 2.6 Add an overlap guard to the maintenance run: a cron that starts a second walk while the first is still deleting is the way a per-run deletion cap gets exceeded

## 3. The Lightsail host

- [x] 3.1 Write `deploy/lightsail/docker-compose.yml`: Caddy, the API image, and a one-shot migration service ordered before the API
- [x] 3.2 Write the `Caddyfile` — hostname, automatic TLS, reverse proxy, HTTP→HTTPS redirect
- [x] 3.3 Add the host crontab entry for reclamation, invoking the maintenance container
- [x] 3.4 Write `deploy/lightsail/provision.sh` — Docker, the compose file, the firewall rules, and nothing that assumes a particular instance size
- [x] 3.5 Write `deploy/lightsail/deploy.sh` — pull an immutable tag, migrate, restart, health-check, and **roll back on a failed health check** rather than leaving a broken tag running
- [x] 3.6 Document the backup and restore procedure against Lightsail's automatic snapshots, including what a restore actually produces (a new instance, a new endpoint, a `DATABASE_URL` change)

## 4. The CDK loses everything the VPC was for

- [x] 4.1 Delete `NetworkStack` — VPC, NAT gateway, interface endpoints, every security group
- [x] 4.2 Delete `DataStack` — RDS, its secret, its isolated subnets
- [x] 4.3 Strip `ComputeStack` to the two remaining Lambdas: no ECS cluster, task definitions, service, ALB, target group, ECR repository, regional WAF, or migration task
- [x] 4.4 Take the Lambdas out of the VPC and give them `WORKER_CALLBACK_URL` and the secret
- [x] 4.5 Replace the ALB alarms in `ObservabilityStack` with something that still exists; keep every delivery-plane alarm untouched. The 5xx alarm moved to the app's own EMF metric, which is strictly better; the two host-count alarms became one Lightsail status check, which is **worse** — it cannot see a wedged-but-running process. Recorded in L4 rather than glossed
- [x] 4.6 Replace the `database` sizing block in `config.ts` with the settings a Lightsail deployment actually has
- [x] 4.7 Rewire `bin/app.ts` for four stacks, and update the stack table in `infra/cdk/README.md`
- [x] 4.8 `infra/cloudflare` issues one certificate, not two — there is no ALB to attach a regional one to
- [x] 4.9 Update the synthesis suite: the deleted stacks' assertions go, and the assertion that **no Lambda is VPC-attached** replaces them, because that is the property the whole saving rests on

## 5. Documentation

- [x] 5.1 Rewrite `docs/bootstrap.md` for the Lightsail path — provisioning, database creation, first deploy, DNS
- [x] 5.2 Rewrite the cost floor in `docs/tuning.md` from the new values, keeping the old figures visible as what was replaced
- [x] 5.3 Write the Lightsail → RDS migration runbook: `pg_dump`, restore, `DATABASE_URL`, migrate, verify, cut over
- [x] 5.4 Write the Lightsail → ECS/EC2/App Runner migration runbook, and state the triggers for both rather than leaving them to judgement
- [x] 5.5 Update `docs/operations.md`: the API is an instance now, and half the runbook's `aws ecs` commands are wrong
- [x] 5.6 Update `docs/architecture.md` and the diagram
- [x] 5.7 Add D19 to `design.md` and reconcile D1's Fargate decision with what actually shipped
- [x] 5.8 Update `CLAUDE.md` — layout, commands, and the invariants that changed

## 6. Verification

- [x] 6.1 Full gate: typecheck, lint, format, unit, integration, synth
- [x] 6.2 Prove the edge artifact is byte-identical — this change must not touch the delivery grammar
- [x] 6.3 Run the compose stack locally end to end: migration, API, health, an upload, and a worker callback. Found two real bugs — a root-owned lock volume that made reclamation a permanent silent no-op, and `ApiKeyGuard` running globally ahead of `WorkerGuard` so every internal route 401'd
- [x] 6.4 Confirm the workers carry no database credential and no Secrets Manager client
- [x] 6.5 Cost the new floor from the real values, the way the old one was costed

## 7. Blocked on an AWS account

- [ ] 7.1 Provision the instance and the database, and confirm the database refuses a connection from outside its private network
- [ ] 7.2 Confirm Caddy obtains a certificate and that renewal is scheduled
- [ ] 7.3 Exercise a restore from an automatic snapshot, and correct the runbook where it is wrong
- [ ] 7.4 Confirm reclamation runs on schedule and that its overlap guard holds
