# @imgopt/client

URL builder, `srcset`, React components, a Next.js loader, and upload helpers.

Three entry points, so a non-React consumer never pulls in a UI framework:

| Import                 | Contains                                | Dependencies |
| ---------------------- | --------------------------------------- | ------------ |
| `@imgopt/client`       | URLs, `srcset`, `sizes`, upload helpers | none         |
| `@imgopt/client/react` | `<Image>`, `<Picture>`, preload helpers | React        |
| `@imgopt/client/next`  | `next/image` loader and config sizes    | none         |

## Configuration

```ts
import { createImageClient } from '@imgopt/client';

export const imgopt = createImageClient({
  cdnHost: 'images.example.com',
  encoderEpoch: 1,
});
```

`encoderEpoch` must match `ENCODER_EPOCH` on the deployment. It is half of the
version segment, so a wrong value produces URLs that resolve to nothing — every
image breaks at once. It is required rather than defaulted for exactly that reason.

When you already hold an asset's `urls.base` from the API, prefer `fromBase()`: that
value carries the deployment's own epoch and cannot drift.

## Rendering

```tsx
import { Image } from '@imgopt/client/react';

<Image client={imgopt} asset={asset} sizes="100vw" priority />;
```

`asset` is the envelope from `GET /v1/images/:id`. The component reads the intrinsic
dimensions, the placeholder, and the dominant colour off it.

Nothing here uses state or effects, so it renders on a server and ships no client
JavaScript — including the blur-up, which works because an `<img>` paints its content
over its own background.

## Why `sizes` matters more than it looks

`sizes` is not only forwarded to the element. It selects the _candidate set_:

- **Viewport-scaled** (`100vw`, `33vw`, or absent) — the image can render at any
  width, so the device rungs apply and the icon rungs never could be chosen.
- **Fixed** (`48px`) — the render width is known, so only two candidates are useful:
  the rung covering 1× and the one covering 2×. This is where the icon rungs earn
  their place; a 48px avatar gets 48 and 96 rather than a 320px floor.

Getting this wrong is not just wasted markup. Every candidate offered is a width some
browser may actually request, and each distinct width becomes its own generated,
stored object — so offering `16w` on a full-bleed hero eventually causes a 16-pixel
hero to be rendered and kept forever.

## Cropping across breakpoints

When both `width` and `height` are given, the height scales with each candidate so
every one keeps the intended ratio. Passing a height without a width has no ratio to
preserve and is left alone — pair a candidate set with both, since candidates vary
the very dimension a height-only transform did not constrain.

## Next.js

```ts
// lib/loader.ts
'use client';
import { createNextLoader } from '@imgopt/client/next';
export default createNextLoader({ cdnHost: '…', encoderEpoch: 1 });
```

```ts
// next.config.ts
import { nextImageSizes } from '@imgopt/client/next';

export default {
  images: { loader: 'custom', loaderFile: './lib/loader.ts', ...nextImageSizes },
};
```

`deviceSizes` and `imageSizes` come from the ladder. Next's own defaults include
widths like 384 and 1200, which are not buckets; nothing breaks when they differ —
the edge snaps them — but the `srcset` descriptor then advertises a width the stored
object does not have, so the browser chooses using a wrong number.

## Uploads

```ts
const uploads = new UploadClient({ apiUrl: 'https://api.example.com', apiKey });
const { asset, mode } = await uploads.upload(file, { contentType: file.type });
```

`upload()` picks the ingest mode by size: a small file goes through the control plane
in one request, a large one goes straight to storage with a presigned target and never
transits the application server. Pass `onProgress` for the presigned path.

## Example

`examples/nextjs` exercises the hero, gallery, and avatar cases end to end and
prerenders statically, so the generated markup can be inspected directly.
