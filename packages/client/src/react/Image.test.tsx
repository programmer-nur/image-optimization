/**
 * Rendered to static markup rather than into a DOM.
 *
 * The contract of these components *is* the markup — which attributes are present,
 * and with what values. `renderToStaticMarkup` asserts exactly that, needs no jsdom,
 * and additionally proves the components are server-renderable: none of them may use
 * state or effects, because the placeholder and priority behaviour are meant to cost
 * zero client JavaScript.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createImageClient } from '../client.js';
import type { ImageAsset } from '../types.js';
import { Image, ImagePreload, preloadLinkProps } from './Image.js';
import { Picture } from './Picture.js';

const client = createImageClient({ cdnHost: 'cdn.example.com', encoderEpoch: 1 });

const asset: ImageAsset = {
  id: 'abc123',
  status: 'ready',
  version: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  altText: 'A green field',
  tags: [],
  focalPoint: null,
  failureReason: null,
  source: {
    width: 2000,
    height: 1125,
    format: 'jpeg',
    bytes: '482915',
    hasAlpha: false,
    dominantColor: '#5a8c3c',
  },
  lqip: 'data:image/webp;base64,UklGRhoAAABXRUJQ',
  urls: { base: '', src: '', srcset: '' },
};

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(element);

describe('intrinsic dimensions', () => {
  it('always emits width and height when the source has been measured', () => {
    // Their absence is the usual cause of layout shift, which is a Core Web Vital.
    const html = render(<Image client={client} asset={asset} />);

    expect(html).toContain('width="2000"');
    expect(html).toContain('height="1125"');
  });

  it('falls back to an aspect ratio while the source is still unmeasured', () => {
    const processing = { ...asset, source: null };
    const html = render(<Image client={client} asset={processing} aspectRatio={16 / 9} />);

    expect(html).toContain('aspect-ratio');
    expect(html).not.toContain('width="');
  });

  it('renders nothing at all for an asset with no delivery URLs', () => {
    expect(render(<Image client={client} asset={{ ...asset, urls: null }} />)).toBe('');
  });
});

describe('loading behaviour', () => {
  it('defers and decodes asynchronously by default', () => {
    const html = render(<Image client={client} asset={asset} />);

    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    // React emits the attribute camelCased; HTML attribute names are
    // case-insensitive, so the browser reads it as `fetchpriority` either way.
    expect(html).toMatch(/fetchpriority="auto"/i);
  });

  it('loads a priority image eagerly with a high fetch priority', () => {
    const html = render(<Image client={client} asset={asset} priority />);

    expect(html).toContain('loading="eager"');
    expect(html).toMatch(/fetchpriority="high"/i);
  });

  it('gets a preload link for free from React 19 on a priority image', () => {
    // React 19 emits <link rel="preload" as="image"> itself for a high-priority
    // image, carrying the same srcset. Worth knowing before adding <ImagePreload>
    // next to a priority image on React 19 and shipping the hint twice.
    const priority = render(<Image client={client} asset={asset} priority sizes="50vw" />);
    const lazy = render(<Image client={client} asset={asset} sizes="50vw" />);

    expect(priority).toContain('rel="preload"');
    expect(lazy).not.toContain('rel="preload"');
  });
});

describe('placeholders', () => {
  it('inlines the stored placeholder, issuing no extra request', () => {
    const html = render(<Image client={client} asset={asset} />);

    // A data URL, so the bytes arrived with the asset metadata.
    expect(html).toContain('background-image:url(data:image/webp;base64,');
    expect(html).toContain('background-size:cover');
  });

  it('falls back to the dominant colour when no placeholder exists', () => {
    const html = render(<Image client={client} asset={{ ...asset, lqip: null }} />);

    expect(html).toContain('background-color:#5a8c3c');
  });

  it('renders no background when the caller opts out', () => {
    const html = render(<Image client={client} asset={asset} placeholder="none" />);

    expect(html).not.toContain('background');
  });

  it('uses a flat colour when asked, even though a placeholder exists', () => {
    const html = render(<Image client={client} asset={asset} placeholder="color" />);

    expect(html).toContain('background-color:#5a8c3c');
    expect(html).not.toContain('background-image');
  });
});

describe('markup shape', () => {
  it('emits a bare img, because format negotiation happens server-side', () => {
    const html = render(<Image client={client} asset={asset} sizes="50vw" />);

    // No <source> elements: one URL serves AVIF, WebP, or JPEG from the Accept
    // header, and a browser that later gains AVIF support needs no code change.
    expect(html).not.toContain('<source');
    expect(html).not.toContain('<picture');
    expect(html.startsWith('<img')).toBe(true);
  });

  it('carries sizes through, without which the browser assumes 100vw', () => {
    expect(render(<Image client={client} asset={asset} sizes="50vw" />)).toContain('sizes="50vw"');
  });

  it('uses the asset alt text unless the caller overrides it', () => {
    expect(render(<Image client={client} asset={asset} />)).toContain('alt="A green field"');
    expect(render(<Image client={client} asset={asset} alt="Override" />)).toContain(
      'alt="Override"',
    );
  });

  it('passes arbitrary img attributes through', () => {
    expect(render(<Image client={client} asset={asset} className="hero" id="x" />)).toContain(
      'class="hero"',
    );
  });
});

describe('preload hint', () => {
  it('includes the candidate set and sizes, so the preload is not wasted', () => {
    // Without imagesrcset the browser preloads href, then the img picks a different
    // candidate — the preload becomes extra bytes rather than a saving.
    const props = preloadLinkProps({ client, asset, sizes: '50vw' })!;

    expect(props.rel).toBe('preload');
    expect(props.as).toBe('image');
    expect(props.imageSrcSet).toContain('640w');
    expect(props.imageSizes).toBe('50vw');
  });

  it('preloads the same URL the image will request', () => {
    const props = preloadLinkProps({ client, asset })!;
    const html = render(<Image client={client} asset={asset} priority />);

    expect(html).toContain(`src="${props.href.replace(/&/g, '&amp;')}"`);
  });

  it('renders as a link element', () => {
    expect(render(<ImagePreload client={client} asset={asset} sizes="100vw" />)).toContain(
      'rel="preload"',
    );
  });

  it('returns null for an unrenderable asset', () => {
    expect(preloadLinkProps({ client, asset: { ...asset, urls: null } })).toBeNull();
  });
});

describe('art direction', () => {
  it('emits a source per breakpoint with a fallback img', () => {
    const html = render(
      <Picture
        client={client}
        asset={asset}
        sources={[
          { media: '(max-width: 768px)', transform: { width: 640, height: 640, fit: 'cover' } },
        ]}
        fallback={{ width: 1200, height: 675, fit: 'cover' }}
      />,
    );

    expect(html).toContain('<picture>');
    expect(html).toContain('media="(max-width: 768px)"');
    expect(html).toContain('<img');
  });

  it('gives each breakpoint its own crop', () => {
    const html = render(
      <Picture
        client={client}
        asset={asset}
        sources={[
          { media: '(max-width: 768px)', transform: { width: 640, height: 640, fit: 'cover' } },
        ]}
      />,
    );

    // The square crop only makes sense as a genuinely different image, which is the
    // case picture exists for.
    expect(html).toContain('h=640');
  });
});
