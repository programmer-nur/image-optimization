# Integration guide

`@imgopt/client` has three entry points, so a non-React consumer never pulls in a UI
framework:

| Import                 | Contains                                | Dependencies |
| ---------------------- | --------------------------------------- | ------------ |
| `@imgopt/client`       | URLs, `srcset`, `sizes`, upload helpers | none         |
| `@imgopt/client/react` | `<Image>`, `<Picture>`, preload helpers | React        |
| `@imgopt/client/next`  | `next/image` loader and config sizes    | none         |

## Configure once

```ts
import { createImageClient } from '@imgopt/client';

export const imgopt = createImageClient({
  cdnHost: 'images.example.com',
  encoderEpoch: 1,
});
```

`encoderEpoch` must match `ENCODER_EPOCH` on the deployment. It is half of the version
segment, so a wrong value produces URLs that resolve to nothing — every image on the
page breaks at once. It is **required rather than defaulted** for exactly that reason:
a silent default of 1 against a deployment on epoch 2 would look like a working
configuration.

When you already hold an asset's `urls.base` from the API, prefer `fromBase()`. That
value carries the deployment's own epoch and cannot drift.

## React

```tsx
import { Image } from '@imgopt/client/react';

<Image client={imgopt} asset={asset} sizes="100vw" priority alt="A wide landscape" />;
```

`asset` is the envelope from `GET /v1/images/:id`. The component reads intrinsic
dimensions, the placeholder, and the dominant colour off it.

Nothing in these components uses state or effects, so they render on a server and ship
**no client JavaScript** — including the blur-up, which works because an `<img>` paints
its content over its own background, so the placeholder disappears on its own.

What you get by default:

- `width` and `height` from the stored intrinsic dimensions, so the browser reserves
  layout space. Their absence is the usual cause of layout shift, which is a Core Web
  Vital rather than a nicety.
- `loading="lazy"` and `decoding="async"`.
- A blur-up placeholder from the stored LQIP, inlined — no extra request.
- A `srcset` whose every candidate is a ladder rung at or below the source width.

With `priority`: eager loading and `fetchpriority="high"`. Use it for the LCP element
and essentially nothing else — marking everything priority is the same as marking
nothing. On React 19 that also produces a matching `<link rel="preload">`
automatically, so adding `<ImagePreload>` beside it ships the hint twice.

### `sizes` does more than you think

It is not only forwarded to the element; it **selects the candidate set**:

- **Viewport-scaled** (`100vw`, `33vw`, or absent) — the image can render at any width,
  so device rungs apply and the icon rungs could never be chosen.
- **Fixed** (`48px`) — the render width is known, so only two candidates are useful:
  the rung covering 1× and the one covering 2×. This is where the icon ladder earns
  its place; a 48px avatar gets 48 and 96 rather than a 320px floor.

Getting this wrong is not just wasted markup. **Every candidate offered is a width some
browser may actually request, and each distinct width becomes its own generated,
stored object.** Offering `16w` on a full-bleed hero eventually causes a 16-pixel hero
to be rendered and kept forever.

```ts
const SIZES = imgopt.sizes([
  ['(max-width: 640px)', '100vw'],
  ['(max-width: 1100px)', '50vw'],
  ['', '33vw'],
]);
```

### Cropping across breakpoints

When both `width` and `height` are given, the height scales with each candidate so
every one keeps the intended ratio. Passing a height _without_ a width has no ratio to
preserve — pair a candidate set with both, since candidates vary the very dimension a
height-only transform did not constrain.

### Art direction

`<picture>` is **not** how this service does AVIF/WebP fallback — that happens
server-side from `Accept`, on one URL, with no markup branching. A browser that later
gains AVIF support starts receiving AVIF with no code change.

`<Picture>` is for genuinely different _crops_ per breakpoint, which is the case the
element actually exists for:

```tsx
<Picture
  client={imgopt}
  asset={asset}
  sources={[{ media: '(max-width: 768px)', transform: { width: 640, height: 640, fit: 'cover' } }]}
  fallback={{ width: 1200, height: 675, fit: 'cover' }}
/>
```

## Next.js

```ts
// lib/loader.ts
'use client';
import { createNextLoader } from '@imgopt/client/next';
export default createNextLoader({ cdnHost: 'images.example.com', encoderEpoch: 1 });
```

```ts
// next.config.ts
import { nextImageSizes } from '@imgopt/client/next';

export default {
  images: { loader: 'custom', loaderFile: './lib/loader.ts', ...nextImageSizes },
};
```

`loader: 'custom'` takes image optimization out of the application entirely. Without
it, `next/image` runs its own optimizer inside the Next.js server — per request, on a
serverless deployment — which is precisely the work this service exists to do once and
cache forever.

`nextImageSizes` matters. Next's defaults include widths like 384 and 1200, which are
not buckets. Nothing breaks when they differ — the edge snaps them — but the `srcset`
descriptor then advertises a width the stored object does not have, so the browser
chooses using a wrong number.

`examples/nextjs` exercises hero, gallery, and avatar cases and prerenders statically,
so the emitted markup can be inspected directly.

## Non-React

The root entry point is plain functions:

```ts
const src = imgopt.url({ id, version }, { width: 1080 });
const srcset = imgopt.srcset({ id, version }, { sourceWidth: 2400, sizes: '50vw' });
const sizes = imgopt.sizes('50vw');
```

Everything the React components do is available here; they add no capability, only
convenience.

## Uploads

```ts
const uploads = new UploadClient({ apiUrl: 'https://api.example.com', apiKey });
const { asset, mode, held } = await uploads.upload(file, { contentType: file.type });
```

`upload()` picks the ingest mode by size: a small file goes through the control plane
in one request, a large one goes straight to storage with a presigned target and never
transits the application server. Pass `onProgress` for the presigned path — it uses
`XMLHttpRequest` there, solely because `fetch` still has no portable way to observe
request-body progress.

Only pass `apiKey` in a browser if the key is scoped to uploads and you accept that it
is public. The presigned flow exists partly so a server can hold the key and hand out
short-lived targets instead.

**Check `held`.** A held upload is a 202: the asset exists but nothing is promoted, and
no URL will resolve yet.

## Things worth not doing

**Do not hand-write delivery URLs.** A hand-written `?w=602` works — the edge snaps it
to 640 — but it costs a normalization round trip and drifts off the ladder the moment
someone edits it.

**Do not omit `sizes` on a responsive image.** The browser assumes `100vw` and
routinely downloads a candidate several times larger than needed. This is the single
most common way a correct `srcset` still ships too many bytes.

**Do not mark more than one image `priority` per page.** The browser can only
prioritise relative to something.

**Do not use `<picture>` for format fallback.** It freezes the format choice into every
page's HTML and gives up the server-side negotiation entirely.
