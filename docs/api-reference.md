# API reference

Two surfaces, and they are deliberately unalike:

- The **control plane** is an authenticated JSON API for uploads and metadata. Low
  volume, stateful, and never in the image read path.
- The **delivery API** is the URL grammar. No authentication, no JSON, and no
  database — just a path and a query string.

## Authentication

Every control-plane endpoint except `/healthz` and `/readyz` requires an API key, as
either header:

```
x-api-key: imgk_key_01J.../<secret>
authorization: Bearer imgk_key_01J.../<secret>
```

Keys carry coarse permissions — `upload`, `delete`, `admin` — and optional storage and
asset-count quotas. Only a hash is stored, so the plaintext is shown exactly once at
creation and cannot be recovered.

Errors share one envelope, so a client branches on `code` rather than parsing prose:

```json
{ "error": { "code": "content_type_mismatch", "message": "...", "correlationId": "..." } }
```

| Code                    | Status | Meaning                                           |
| ----------------------- | ------ | ------------------------------------------------- |
| `unauthorized`          | 401    | Missing, invalid, or revoked key                  |
| `forbidden`             | 403    | Key lacks the required permission                 |
| `not_found`             | 404    | No such asset                                     |
| `validation_failed`     | 400    | Malformed request                                 |
| `content_type_mismatch` | 422    | Declared type disagrees with the actual bytes     |
| `unsupported_format`    | 422    | Detected type is not an accepted image format     |
| `pixel_limit_exceeded`  | 422    | Decoded dimensions exceed the configured ceiling  |
| `empty_file`            | 400    | Zero bytes                                        |
| `malware_detected`      | 422    | Rejected by malware scanning                      |
| `payload_too_large`     | 413    | Over the proxy threshold — use the presigned flow |
| `quota_exceeded`        | 413    | Key is at its storage or asset limit              |
| `conflict`              | 409    | Upload already completed                          |

## Uploads

### `POST /v1/images` — proxied

`multipart/form-data` with a `file` part. The body streams straight into staging;
nothing is buffered in memory or written to disk. For files under the configured
proxy threshold (default 10MB) — above it, this returns 413 pointing here:

### `POST /v1/images/uploads` — presigned, step 1

```json
{ "contentType": "image/jpeg", "altText": "optional", "tags": ["optional"] }
```

Returns a presigned POST target. The bytes go **directly to storage** and never
transit the application server:

```json
{
  "assetId": "img_01J...",
  "upload": {
    "url": "https://...",
    "fields": { "...": "..." },
    "key": "staging/...",
    "expiresAt": "..."
  }
}
```

The policy carries a `content-length-range` condition, so an oversized upload is
rejected by the storage service itself before any of this service's code runs. That is
the only way to bound a direct-to-storage upload.

### `POST /v1/images/uploads/:id/complete` — presigned, step 2

Validates and promotes: head, ranged magic-byte sniff, dimension check, quota check,
then a server-side copy from `staging/` to `original/`.

**Validation happens here, not before.** A direct-to-storage upload physically cannot
be checked before it is stored — which is what the staging prefix is for.

### Upload responses

Both flows return the same envelope.

| Status | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| 201    | Stored. Processing continues asynchronously; the response does not wait |
| 202    | **Held** awaiting a malware verdict. Nothing promoted yet — see below   |
| 4xx    | Rejected, with a machine-readable `code`                                |

```json
{ "asset": { "...": "..." }, "duplicate": false, "held": { "reason": "not yet scanned" } }
```

A **202 is not success.** The asset exists and is addressable, but no bytes have been
promoted and no URL will resolve yet. Scanning is asynchronous, so "not scanned yet"
and "scanner is broken" are the same observation from here; the upload is held rather
than rejected, and its bytes stay in staging where the lifecycle rule expires them if
nothing resolves it. Treating 202 as success means linking to an image that is not
there.

`duplicate: true` means the content hash matched an existing asset; the existing one
is returned and nothing was stored.

## Assets

| Endpoint                        | Permission | Notes                                              |
| ------------------------------- | ---------- | -------------------------------------------------- |
| `GET /v1/images/:id`            | any        | Metadata, LQIP, intrinsic dimensions, URLs, srcset |
| `GET /v1/images`                | any        | List, filterable by status and tags                |
| `GET /v1/images/:id/variants`   | any        | Materialized derivatives                           |
| `PATCH /v1/images/:id`          | `upload`   | Alt text and tags; focal point triggers reprocess  |
| `PUT /v1/images/:id/source`     | `upload`   | Replace bytes — mints a new version                |
| `POST /v1/images/:id/reprocess` | `upload`   | Re-enqueue the warm set                            |
| `DELETE /v1/images/:id`         | `delete`   | Soft delete, object removal, CDN invalidation      |

The asset envelope:

```json
{
  "id": "img_01J...",
  "status": "ready",
  "version": 3,
  "altText": "A green field",
  "tags": [],
  "source": {
    "width": 2000,
    "height": 1125,
    "format": "jpeg",
    "bytes": "482915",
    "hasAlpha": false,
    "dominantColor": "#5a8c3c"
  },
  "lqip": "data:image/webp;base64,...",
  "urls": { "base": "https://cdn/i/img_01J.../v3-1", "src": "...", "srcset": "..." }
}
```

Notes that matter:

- **`bytes` is a string.** JSON has no BigInt, and narrowing would corrupt large values.
- **`source.width`/`height` are _displayed_ dimensions** with EXIF orientation already
  applied. Orientations 5–8 transpose the axes; passing stored dimensions through
  would give a transposed aspect ratio and layout shift.
- **`lqip` is a data URL**, inlined by the client for blur-up at no extra request.
- **`urls` is null** until the asset is servable.

### Statuses

| Status           | Meaning                                                  |
| ---------------- | -------------------------------------------------------- |
| `pending_upload` | Reserved; bytes not promoted (or held pending a verdict) |
| `stored`         | Original durable and validated. Servable                 |
| `ready`          | Metadata extracted and warm set generated                |
| `rejected`       | Validation refused the bytes. **Terminal**               |
| `failed`         | Processing failed. Recoverable via reprocess             |
| `deleted`        | Soft-deleted. Terminal                                   |

## API keys

`POST`, `GET`, and `DELETE /v1/keys`, all requiring `admin`.

Creation returns the plaintext **once**:

```json
{
  "key": { "id": "key_01J...", "...": "..." },
  "plaintext": "imgk_...",
  "warning": "Store this now..."
}
```

Only a hash is stored, so there is no code path that could return it again. Revocation
is a soft delete — the row carries quota accounting and is referenced by the assets
the key uploaded, and deleting it would destroy that history exactly when someone is
most likely reading it.

## Delivery API

```
https://cdn.example.com/i/{assetId}/{version}/{slug}?w=640&q=80
```

`{version}` is `v{assetVersion}-{encoderEpoch}`. `{slug}` is SEO decoration — dropped
during normalization, and it never affects which bytes are returned.

### Parameters

| Parameter    | Values                                                               | Normalization                       |
| ------------ | -------------------------------------------------------------------- | ----------------------------------- |
| `w`          | 1–3840                                                               | Snapped **up** to the ladder        |
| `h`          | 1–3840                                                               | Ratio quantized, not snapped        |
| `q`          | 1–100                                                                | Nearest of 50, 65, 75, 85, 95       |
| `fit`        | `cover` `contain` `inside` `outside` `fill` `pad`                    | Enum                                |
| `format`     | `auto` `avif` `webp` `jpeg` `png`                                    | `auto` resolves from `Accept`       |
| `crop`       | `center` `top` `bottom` `left` `right` `entropy` `attention` `focal` | Named gravity only                  |
| `background` | hex, 3/4/6/8 digits                                                  | Lowercase 6 or 8 digits             |
| `blur`       | 0–100                                                                | Nearest of 0, 2, 5, 10, 20, 40      |
| `sharpen`    | 0–2                                                                  | Nearest of 0, 1, 2                  |
| `dpr`        | 1–3                                                                  | Folded into width; never in the key |

The width ladder:

```
16 32 48 64 96 128 192 256          icons, avatars, thumbnails
320 480 640 750 828 960 1080 1200 1440 1920 2560 3840   device widths
```

### Policy

**Out-of-range numbers are clamped; invalid enums are rejected.** `?q=250` becomes 95,
because a slightly wrong URL should keep working. `?fit=squish` returns 400, because
silently substituting a fit mode delivers a visually wrong image.

**Unknown parameters are ignored** and never reach the cache key, so tracking
parameters cost nothing.

**Inert parameters are elided.** A parameter that cannot affect the output fragments
the cache exactly as badly as an unquantized one:

- `fit` survives only when **both** dimensions are constrained
- `background` only on padding fits (`pad`, `contain`)
- `crop` gravity only when a crop actually occurs
- `blur` and `sharpen` only above level 0
- `dpr` never — it is folded into the width

So `?w=640` and `?w=640&fit=cover` are one cache key and one object.

**Quality is a perceptual scale, not a raw codec value.** Nominal 75 becomes mozjpeg
78, WebP 72, AVIF 50. Passing `q` straight to the encoder would make `?q=75`
near-lossless in AVIF and forfeit the size advantage that is the system's main cost
lever.

**Absolute pixel crops are not expressible.** `crop=x,y,w,h` returns
`unsupported_crop`: it is the one parameter that would reintroduce an unbounded cache
key space. Named gravity covers the common cases; arbitrary rectangles mint a new
asset through the authenticated API, which is also the honest model of their cost.

### Error caching

| Response           | Cache-Control                         |
| ------------------ | ------------------------------------- |
| Derivative         | `public, max-age=31536000, immutable` |
| Invalid parameters | `public, max-age=60`                  |
| Not found          | `public, max-age=60`                  |
| Generation failure | `no-store`                            |

Errors are cached briefly so a corrected URL recovers fast. Generation failures are
never cached — one bad moment must not pin a broken image for a year.

## Health

`GET /healthz` is liveness. `GET /readyz` is readiness and checks dependencies, so the
load balancer withholds traffic from an instance that cannot serve while the
orchestrator still sees the process as alive.
