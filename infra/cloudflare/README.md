# @imgopt/cloudflare

DNS and certificate issuance for a deployment whose zone AWS cannot see.

Deliberately **outside the CDK app**. CloudFormation can only create DNS records in a
hosted zone it owns, and it can only validate an ACM certificate if it can write that
zone. With DNS in Cloudflare it can do neither — so a `Route53::RecordSet` here would
reference a zone that does not exist, and an `ACM::Certificate` with DNS validation
would make the stack sit and wait for a record only a human with a Cloudflare token
can create. A deploy that hangs is worse than one that fails. See design.md D18.

The CDK therefore publishes _targets_ as stack outputs and consumes certificates as
_ARNs_; this package produces both.

## The one rule

**Proxy stays off — grey cloud, `proxied: false`, on every record.**

Cloudflare's proxy is a second CDN in front of CloudFront, and it caches by URL while
honouring `Vary` only for `Accept-Encoding`. This service negotiates image format at
the CloudFront edge: one URL, `/i/{id}/{v}?w=640`, legitimately returns AVIF, WebP or
JPEG depending on the viewer's `Accept` header, and every response says so with
`Vary: Accept`. Orange-cloud that record and Cloudflare caches whichever format the
first visitor happened to receive, then serves it to everyone — AVIF to a browser that
cannot decode it. It looks like a broken image for a subset of users, with nothing in
any log to explain it.

The reconciler enforces this: an existing proxied record is reported as a change and
turned off, not left alone.

## Setup

A **scoped** token, never a global API key:

1. Cloudflare dashboard → My Profile → API Tokens → Create Token
2. Permissions: `Zone` → `DNS` → `Edit`
3. Zone Resources: include only the zone this deployment uses
4. Zone ID is on the zone's Overview page

```bash
export CLOUDFLARE_API_TOKEN=...   # Zone:DNS:Edit on one zone
export CLOUDFLARE_ZONE_ID=...
```

## Certificates — before the first deploy

```bash
CDN_HOST=images.example.com API_HOST=api.example.com \
  pnpm --filter @imgopt/cloudflare certs
```

Requests both certificates, writes each validation record into Cloudflare, waits for
ACM to issue, and prints the two `export` lines to feed into the deploy. Two
certificates, not one: CloudFront accepts a viewer certificate only from `us-east-1`,
an ALB only from its own region.

**Leave the validation records in place.** ACM re-checks them to renew, roughly every
eleven months. Deleting them after issuance turns renewal into a silent failure that
surfaces as an expired certificate on a date nobody has in a calendar.

If issuance fails, the two causes worth checking first are a `CAA` record on the zone
that does not permit `amazon.com`, and a validation record that was created proxied.

## DNS — after each deploy

```bash
pnpm --filter @imgopt/cloudflare dns
```

Reads `CdnDnsTarget` and `ApiDnsTarget` from the deployed stacks, diffs against the
zone, and prints a plan. Nothing is written until:

```bash
pnpm --filter @imgopt/cloudflare dns --apply
```

Re-run it after any deploy that could replace the distribution or the load balancer.
The targets are assigned by AWS, so a hand-copied value goes stale the moment a stack
is replaced — and stale here means DNS pointing at a deployment that no longer exists.

## What it will not do

- **It never deletes.** A zone holds mail, the apex, and whatever else the domain
  does. A reconciler that prunes what it does not recognize is one that takes a
  company offline the first time somebody adds a record by hand.
- **It will not convert a record type.** If `images.example.com` already exists as an
  `A` record, that is reported as a conflict and left alone. Replacing it is a
  decision, not a detail.
- **It does not manage the zone itself.** Registration, nameserver delegation, and
  anything else the domain does stay where they are.
