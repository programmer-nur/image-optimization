# Tuning knobs

Every value here is a trade. This page is what each one buys and what it costs.

Two categories, and the distinction matters more than any individual setting:

- **Deployment settings** (`packages/config`, `infra/cdk/lib/config.ts`) are redeploy
  knobs. Change one, ship it, done.
- **Transform grammar** (`packages/core` constants) is baked into cached URLs.
  Changing one is an [encoder-epoch event](operations.md#changing-encoder-policy-the-epoch-procedure),
  not a redeploy. That is why the ladder and the quality levels are constants in code
  rather than environment variables — an env var invites someone to change it on a
  Friday.

## The warm set

`WARM_WIDTHS`, `WARM_FORMATS` — default `1080`, `avif`.

Generated eagerly at upload; everything else is generated lazily on first request and
persisted. Deliberately small.

| Wider warm set                                 | Narrower                                     |
| ---------------------------------------------- | -------------------------------------------- |
| First view is never slow                       | First view of an unwarmed size pays 300ms–2s |
| Pays for variants nobody views                 | Pays only for what is seen                   |
| One object per width per format, per asset     | Storage tracks actual demand                 |
| Failures surface at upload, where you see them | Failures surface at request time             |

The right answer is workload-dependent, which is exactly why it is a knob:

- **UGC archive**, where 95% of uploads are never viewed: LQIP only. A wider set is
  almost entirely waste.
- **Product catalog**, where every image is viewed: widen to the two or three widths
  your layout actually renders. The lazy path still catches the rest.

Widening is safe. Every derivative is generated at most once regardless, so the only
question is _when_ the cost is paid, not whether.

## Quality levels

`QUALITY_LEVELS` in `packages/core` — 50, 65, 75, 85, 95. Default 75.

**Grammar, not configuration.** These are a _perceptual_ scale, and
`encoder-options.ts` translates each level per codec — nominal 75 is mozjpeg 78,
WebP 72, AVIF 50.

That translation is not incidental. Passing `q` straight to the encoder would make
`?q=75` near-lossless in AVIF, producing files several times larger than needed and
forfeiting the size advantage that is the system's main cost lever — on the line item
that is ~75% of the bill.

Lowering the default is the single largest bandwidth saving available, and it is an
epoch bump. Do it deliberately, with a visual audit, not as a config tweak.

## The width ladder

`ICON_WIDTHS` and `DEVICE_WIDTHS` in `packages/core` — 20 rungs total.

**Grammar.** Changing it changes every cache key.

Two ladders, not one, and the icon range matters more than it looks: avatars,
favicons, and thumbnail grids are extremely common, and snapping a 40px avatar up to
320px would ship ~60× the necessary bytes on the most numerous images on a page.

Adding rungs makes each rendition closer to its slot and increases the object count.
Removing them does the reverse. The current spacing is roughly 20–30% between adjacent
device widths, which keeps worst-case over-delivery near 13%.

If you change this, regenerate the edge function and bump the epoch. The conformance
suite will fail loudly if you forget the first; nothing will tell you about the second.

## Master renditions

`MASTER_THRESHOLD_BYTES` (20MB), `MASTER_THRESHOLD_LONGEST_EDGE` (4000px),
`MASTER_LONGEST_EDGE` (4000px).

Above either threshold, a bounded intermediate is materialized so every later cache
miss decodes it instead of the full original.

Not always, because a master tier for a 900KB JPEG is pure overhead — extra storage, an
extra invocation, an extra failure mode, negligible saving. Not never, because with a
100MB 12000×8000 TIFF _every_ miss decodes 96 megapixels; a 4000px master converts that
to roughly 8, for the price of one object.

Lower the threshold if your sources are large and misses are frequent. Raise it if
most uploads are already web-sized.

## Generator sizing

`generatorMemoryMb` (3008), `generatorTimeout` (30s),
`generatorReservedConcurrency` (50 / 10 in staging).

Memory is the only performance dial on Lambda — CPU scales with it. These are starting
points to be replaced by measurements, not guesses to keep; see
[Lambda Power Tuning](#lambda-power-tuning) below.

Reserved concurrency is a **cost ceiling**, not a performance setting. It caps
worst-case spend when a burst of distinct uncached variants arrives — a launch, a
crawler, a crafted URL sweep. Excess requests fail fast with a short-lived error rather
than fanning out without limit. Raise it if legitimate bursts are being refused; lower
it if a runaway is plausible.

The generator gets more memory than the optimizer because its latency is user-visible:
a miss blocks a viewer, while the optimizer runs behind a queue where nobody is
waiting.

## CloudFront price class

`delivery.priceClass` — `PriceClass_100` in staging, `PriceClass_All` in production.

Directly billed, and one of the few settings with an immediate, predictable effect.
`PriceClass_100` (US/EU/Israel) is materially cheaper; the wider classes add latency
improvements for viewers elsewhere. If your audience is regional, this is free money.

## Lifecycle windows

`ORPHAN_SAFETY_WINDOW_HOURS` (24), `SUPERSEDED_RETENTION_DAYS` (30),
`PENDING_UPLOAD_TTL_HOURS` (24), `MAX_DELETIONS_PER_RUN` (10000).

**These are safety margins, not tuning knobs.** Shortening one makes reclamation race
the system it is cleaning up after, and the objects at stake include originals — the
one thing here that cannot be regenerated.

The orphan window in particular: the generator writes a derivative _before_ its
bookkeeping row, and that row is best-effort. A recent object with no row is the normal
state during generation, not an orphan. Shorten this and you will delete derivatives
that are about to be served, and the generator will regenerate them, forever.

`SUPERSEDED_RETENTION_DAYS` is how long consumer pages referencing the previous
version's URLs keep working. Lengthen it if your consumers cache HTML aggressively.

## Storage tiering

`originalsInfrequentAccessDays` (30), `originalsArchiveDays` (180).

Both targets are **instant-retrieval**. A class needing a restore step would turn a
cache miss into a failed request, so the deep-archive classes are not usable here at
any price.

Derivatives are deliberately left in Standard with no rule at all: every one of them is
a potential cache miss, and retrieval-priced classes would add a per-request charge to
exactly the path that must stay cheap.

## Upload limits

`UPLOAD_PROXY_THRESHOLD_BYTES` (10MB), `UPLOAD_MAX_FILE_BYTES` (100MB),
`UPLOAD_MAX_PIXELS` (100M).

The proxy threshold is where the client SDK switches ingest modes. Raising it puts
more bytes through the application server; lowering it pushes more clients onto the
three-round-trip presigned flow.

`UPLOAD_MAX_PIXELS` is a decompression-bomb ceiling, enforced at validation and again
inside Sharp. A ~30KB PNG can declare dimensions that decode to tens of gigabytes.
Lower it if you know your sources are modest; there is no reason to raise it.

## Lambda Power Tuning

Not yet run — it needs a deployment. When you do:

```bash
# Deploy the state machine from the serverless application repository, then:
aws stepfunctions start-execution \
  --state-machine-arn <powerTuningArn> \
  --input '{
    "lambdaARN": "<generator-arn>",
    "powerValues": [1024, 1536, 2048, 3008],
    "num": 50,
    "payload": { "rawPath": "/derived/<assetId>/v1-1/w1080_q75.avif" },
    "strategy": "balanced"
  }'
```

Record the result here — the chosen memory, the measured latency and cost at each
level, and the date. The current 3008MB is a starting guess, and this section is the
place it stops being one.

| Memory | p50 latency | p95 latency | Cost / 1M invocations | Notes   |
| ------ | ----------- | ----------- | --------------------- | ------- |
| —      | —           | —           | —                     | not run |

Use the generator, not the optimizer: it is the one whose latency a user experiences.
