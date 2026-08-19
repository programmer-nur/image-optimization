## Context

Nothing has been deployed. The infrastructure was designed against the workload the system is meant to reach, not the one it starts with, and the gap between those is the entire content of this change.

The costed floor in `docs/tuning.md` is ≈$237/month for the production tier and ≈$127 for staging, before any traffic. Broken down, the money is in: RDS Multi-AZ ($46.72 + $23 storage), two Fargate tasks ($72.08), an ALB ($16.43), a NAT gateway ($32.85), and six interface VPC endpoints ($43.80). That is $235 of the $237. **S3, SQS, CloudFront, and all three Lambdas contribute nothing at zero traffic** — they are already the shape this change is trying to make the rest of the system.

So the question is not "how do we make this cheaper", it is "what is the VPC for". The answer turns out to be a single thing.

## Goals / Non-Goals

**Goals.** A production-safe first deployment at roughly a tenth of the current fixed cost. Keep the delivery plane byte-identical. Make both the compute host and the database replaceable without touching domain logic.

**Non-Goals.** High availability for the control plane. Zero-downtime deploys of the API. Horizontal scaling of the API. Each of those is a reason to move off Lightsail later, and the migration path is written down rather than pre-built.

## Decisions

### L1 — The VPC exists only because Lambda talks to RDS

**Decision:** cut the database connection from the Lambdas, and the VPC, NAT gateway, interface endpoints, and every security group become unnecessary at once.

**Why:** this is the load-bearing observation. The three Lambdas are attached to `PRIVATE_WITH_EGRESS` subnets for exactly one reason — RDS is in `PRIVATE_ISOLATED` subnets and nothing outside the VPC can reach it. Everything else those functions touch (S3, SQS, CloudWatch, Secrets Manager) is a public AWS endpoint that a VPC-less Lambda reaches natively. The NAT gateway and the interface endpoints exist _because_ the functions are in a VPC; they are not independently useful.

`natGateways: 1` + three interface endpoints × two AZs is **$76.65/month, 32% of the entire floor, spent on making a database connection possible.** Remove the connection and all of it goes, along with the cold-start penalty of VPC-attached Lambda and an entire CDK stack.

**What it costs:** the optimizer and generator need another way to record what they did. See L2.

**Rejected — Lightsail PostgreSQL in public mode.** Would have achieved the same saving with almost no code change: the workers keep their repository and only the connection string changes. Rejected because Lightsail managed databases have **no IP allowlist** — public mode means reachable from every address on the internet, with a password as the only control. For a database holding every asset record and every API key hash, that is not a trade worth $0.

**Rejected — Lightsail VPC peering.** Peering connects the Lightsail network to the region's _default_ VPC, and is documented for Lightsail **instances**. Whether a managed database is reachable across it is not something this repository can verify without an account, and an architecture resting on an unverified networking claim is worse than one resting on a stated code change.

### L2 — Workers reach the registry through the control plane

**Decision:** the optimizer and generator call an authenticated internal route on the API instead of opening their own database connection. The maintenance worker moves off Lambda entirely.

**Why:** the three workers are not alike, and treating them alike is what made this look hard.

The **generator** already treats its write as best-effort — `generator.ts` swallows its failure by design, because bookkeeping must never fail a viewer's request. It makes one call. Turning that into an HTTP POST changes nothing about its semantics.

The **optimizer** makes four calls that collapse naturally into two: fetch the job's context, then complete it. Completion — record the version metadata and mark the asset ready — is one transaction on the API side, which is a better boundary than four independent writes issued from a queue consumer.

The **maintenance worker** is the one that does not fit, and it should not be forced to. It walks the whole registry (`liveVersionKeys`, `aggregateStorage`), issues deployment-wide deletes, and **decodes no images** — it carries no sharp layer precisely because it never touches a pixel. It is batch database work with a bucket scan attached. Its natural home is the machine next to the database, not a function that has to be given a remote interface to do it. It runs as a scheduled container on the Lightsail instance.

**What it costs:** a new internal HTTP surface, which is new attack surface. It is authenticated by a shared secret compared in constant time, bound to a route prefix that carries no user-facing functionality, and it is the only place in `apps/api` permitted to import `UnscopedAssetRepository` — enforced by narrowing the existing lint rule to that directory rather than to the whole app.

**A consequence worth stating:** the optimizer now fails when the control plane is down, where before it failed when the database was down. Those are the same failure in this topology — the API and the database live and die together on one instance — so nothing was actually traded away. The delivery plane still reads neither.

### L3 — One Lightsail instance, Docker, Caddy for TLS

**Decision:** the same image Fargate ran, started by `docker compose` with a restart policy, behind Caddy.

**Why:** the image is the artifact that already exists and is already verified — it builds, it runs, `/healthz` answers 200, it runs its own migrations. Reusing it keeps the immutable-tag rollback story exactly as it was: `docker compose pull && up -d` against a new tag, `down` and back to the old tag to roll back. PM2 would mean installing Node, pnpm, and a build toolchain on the instance and re-verifying an artifact that is already verified.

Caddy rather than nginx + certbot because certificate renewal is the part of this that fails silently eleven months later. Caddy obtains and renews automatically with the hostname as its entire configuration; there is no cron to forget and no reload to miss.

**Rejected — Cloudflare proxy (orange cloud) for the API.** Would give TLS termination, DDoS absorption, and a hidden origin IP for free, and unlike the CDN host there is no `Vary: Accept` hazard on a JSON API. Rejected as the _default_ because it introduces a second DNS posture into a codebase whose one hard DNS rule is "every record is grey-clouded", and the reconciler enforces that uniformly. It is written up in the runbook as a hardening step for an operator who wants it, with the CDN-host prohibition restated so the two cannot be confused.

**Not used: ACM for the API.** ACM certificates cannot be attached to a Lightsail instance. ACM remains in use for CloudFront, which is the only place it was ever load-bearing, and `infra/cloudflare` now issues one certificate rather than two.

### L4 — The WAF goes, and rate limiting moves into the application

**Decision:** the `REGIONAL` Web ACL is removed with the load balancer it was attached
to, and its two rate-based rules are reimplemented in the control plane at the same
limits — 300 mutating and 3000 overall requests per five minutes, per source address.

**Why:** a WAF cannot attach to a Lightsail instance. The `REGIONAL` scope covers ALB,
API Gateway, and AppSync; keeping the ACL would mean keeping an ALB in front of a
single instance at $16.43/month, plus the WAF's own $5 base and $1 per rule, to protect
something that is not the delivery path.

**What it costs, precisely.** This is a downgrade in two ways and it is worth being
exact about both, because the previous version of this decision claimed the delivery
plane "keeps exactly what it had" — which was wrong. **There is no CloudFront WAF and
there never was.** The regional ACL was the only web ACL in the deployment.

1. _Refusal moves behind the connection._ WAF rejected a flooded request before an
   origin was touched. The application now accepts the connection and parses the
   request line before refusing it. At real flood volume that difference is the
   difference between absorbing an attack and being an attack's target.
2. _The limiter becomes per-instance._ The WAF module's own comment argued that a
   per-instance limiter "is not a limiter", because the control plane autoscaled and an
   attacker's budget was the limit times the running task count. That objection is
   exactly void at one instance — and comes straight back at two. It is therefore
   recorded as a **precondition of the ECS migration** in L7, not left as a comment
   that quietly stops being true.

**What still protects the delivery plane** — which is the internet-facing surface that
carries real volume, and which never had a WAF: the edge function refuses an
unbucketed width without an origin fetch, so the variant space stays bounded (D3); the
generator's reserved concurrency caps worst-case spend during a burst; and CloudFront
absorbs the volume itself. Those were the actual defences all along.

**Also removed:** the host firewall exposes only 80 and 443, and the application port
is published to the host loopback rather than to the world — which is what makes the
limiter's trust of `x-forwarded-for` sound rather than naive.

### L5 — `DATABASE_URL`, and nothing else

**Decision:** the application reads one variable. The Secrets Manager hydration path is deleted rather than kept.

**Why:** `packages/config` already prefers `DATABASE_URL` and falls back to composed `DB_*` parts, so the application layer needed no change at all — this decision is about deleting what is now dead. `hydrateDatabaseCredentials` existed for one reason: ECS can inject a Secrets Manager value into a container's environment and Lambda cannot, so the functions were given an ARN and fetched the password themselves. With no Lambda touching the database and no ECS task definition, both halves of that problem are gone.

Keeping it would leave a Secrets Manager client and an AWS call in the init path of every worker, for a code path nothing reaches — the kind of thing that survives three refactors and then breaks one.

**What this buys:** the database is replaceable by editing one string. That is the whole of the Lightsail → RDS migration on the application side, and it is why that migration is a runbook rather than a change.

### L6 — Failure domains, stated rather than discovered

**Decision:** accept that the control plane is a single instance, and be explicit about what that does and does not take down.

**Down with the instance:** uploads, the admin API, metadata reads, the optimizer's ability to complete a job (queued jobs wait; SQS retains for four days), and maintenance.

**Not down with the instance:** every image already generated, every image _not_ yet generated. Delivery is CloudFront → S3 → generator Lambda, and the generator reads no database. A first request for an unrendered variant during an outage still renders and still persists; only its bookkeeping row is missed, and the orphan collector is already written to treat a recent object with no row as normal rather than as garbage.

**Why this is acceptable now and not forever:** it is acceptable while one application uploads occasionally and viewers read constantly. It stops being acceptable when uploads become continuous or when someone else's release depends on the admin API. L7 is the exit.

### L7 — The exits, pre-decided

**Decision:** record both migrations now, while the reasoning is fresh, and build neither.

**Database — Lightsail PostgreSQL → RDS.** `pg_dump` → restore → change `DATABASE_URL` → `prisma migrate deploy` → verify → cut traffic. No domain code changes, because L5 left exactly one thing to change. The trigger is any of: needing Multi-AZ, needing read replicas, or outgrowing the largest Lightsail plan.

**Compute — Lightsail → ECS/EC2/App Runner.** The same image, a different scheduler. The API is stateless: no local disk, no sticky sessions, no in-process cache — nothing that a second replica would contend over. The trigger is any of: needing more than one replica, needing zero-downtime deploys, or the instance becoming the thing that is paged about.

Both are reversals of _hosting_, not of architecture, which is the property this change is buying.
