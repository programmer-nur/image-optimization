## Why

The deployment was sized for a service that already has traffic. It does not have any: nothing has ever been deployed, and the first production install will serve one application at low volume. The fixed floor is roughly **$237/month before a single image is served** (`docs/tuning.md`), and almost none of it is buying anything at that volume — Multi-AZ RDS, two Fargate tasks, an Application Load Balancer, a NAT gateway, and six interface VPC endpoints are all sized against load that does not exist.

The point of this change is to pay for what is currently needed without giving up the part of the architecture that is actually load-bearing. **The delivery pipeline is not the expensive part.** S3 → SQS → Lambda + sharp → S3 → CloudFront costs essentially nothing at rest and scales on its own; the expense is entirely in how the control plane and its database are hosted.

## What Changes

The image pipeline is untouched. The API and database hosting layer is replaced.

- **The NestJS control plane moves to a single Lightsail instance**, running the same Docker image that Fargate ran, behind Caddy for TLS. ECS, the Fargate service, the Application Load Balancer, the regional WAF, and the ECR repository all go.
- **PostgreSQL moves to Lightsail managed PostgreSQL**, private-only — not reachable from the internet. RDS goes.
- **The Lambdas stop talking to PostgreSQL.** The optimizer and generator post their bookkeeping to an authenticated internal route on the control plane; the maintenance worker, which does whole-registry batch work and decodes no images, moves off Lambda entirely and runs next to the database on the Lightsail instance.
- **Every remaining Lambda leaves the VPC**, which is what lets the entire network stack go: no VPC, no NAT gateway, no interface endpoints, no security groups.
- **`DATABASE_URL` is the only database configuration the application sees.** It already was; this change removes the Secrets Manager hydration path that existed only because Lambda could not be given an RDS-injected secret.
- **NOT changing:** `packages/core`, `infra/cloudfront`, the canonical key, the transform grammar, the edge normalizer, the storage layout, the queue, the CDN stack, the client SDK, or any domain logic in `apps/api`. Zero diff in the generated edge artifact.

## Capabilities

### New Capabilities

- `control-plane-hosting`: what the control plane runs on, what that hosting must guarantee, and what must remain true so the host can be replaced without touching business logic.

### Modified Capabilities

- `image-asset-registry`: workers reach the registry through the control plane rather than through their own database connection.
- `platform-security`: the internal worker surface and its authentication; the loss of the regional WAF and what replaces it.

## Impact

**Cost.** The fixed floor falls from ≈$237/month to ≈$32/month for a production-shaped deployment — a 7× reduction, with the whole saving coming out of hosting rather than out of capability.

**Reliability, honestly.** A single Lightsail instance is a single point of failure for uploads and the admin API. **It is not a single point of failure for image delivery**, which is the property the architecture was built around: the delivery plane never reads the database, so viewers keep being served from CloudFront and S3 while the control plane is down. That trade is the entire reason this is affordable, and it is the first thing to reverse when it stops being acceptable.

**Migration.** Both replacements are documented and neither touches domain logic: Lightsail PostgreSQL → RDS is a `pg_dump`/restore and a `DATABASE_URL` change; Lightsail → ECS/EC2/App Runner is redeploying the same image.
