import { Image } from '@imgopt/client/react';
import { galleryAssets, imgopt } from '../../lib/imgopt';

/**
 * Gallery: many images, none of them the LCP element.
 *
 * Everything here is lazy and asynchronously decoded, which is the default. The
 * interesting part is `sizes`: the grid is three columns on desktop and one on
 * mobile, so an image renders at roughly a third of the viewport on a wide screen.
 * Saying so lets the browser pick a ~640px candidate instead of the ~1920px one it
 * would choose under the default `100vw` assumption — the single most common way a
 * correct `srcset` still ships far too many bytes.
 *
 * Each tile is cropped to a common ratio through `transform`, so the grid stays even
 * regardless of the sources' own proportions. The ratio is quantized at the edge, so
 * these all collapse onto one cache key per width.
 */
const SIZES = imgopt.sizes([
  ['(max-width: 640px)', '100vw'],
  ['(max-width: 1100px)', '50vw'],
  ['', '33vw'],
]);

export default function GalleryPage() {
  return (
    <main>
      <h1>Gallery</h1>
      <p>
        Twelve-hundred-pixel tiles cropped to 3:2. All lazy, all decoded off the main thread.{' '}
        <code>sizes</code> is <code>{SIZES}</code>.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '1rem',
        }}
      >
        {galleryAssets.map((asset) => (
          <Image
            key={asset.id}
            client={imgopt}
            asset={asset}
            sizes={SIZES}
            transform={{ width: 1200, height: 800, fit: 'cover' }}
            alt={`Gallery item ${asset.id}`}
            style={{ width: '100%', height: 'auto', borderRadius: 6, display: 'block' }}
          />
        ))}
      </div>

      <h2>What to check</h2>
      <ul>
        <li>
          Every tile is <code>loading=&quot;lazy&quot;</code> — none of them is the LCP element, and
          marking them priority would only dilute the hero&apos;s.
        </li>
        <li>
          The requested crop is <code>?w=1200&amp;h=800&amp;fit=cover</code> on every tile, so six
          differently-shaped sources produce one variant shape and share cache behaviour.
        </li>
      </ul>
    </main>
  );
}
