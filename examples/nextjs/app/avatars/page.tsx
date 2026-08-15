import { Image } from '@imgopt/client/react';
import { avatarAssets, imgopt } from '../../lib/imgopt';

/**
 * Avatars: the case the icon ladder exists for.
 *
 * A single ladder starting at 320 would snap a 48px avatar up to 320 and ship about
 * sixty times the necessary bytes — on the most numerous images on a typical page.
 * The icon rungs (16 through 256) are why this page is cheap.
 *
 * `sizes` is a fixed pixel value rather than a viewport fraction, because these
 * render at a constant size. That is what lets the browser choose a 48 or 96 rung
 * rather than something viewport-sized.
 */
const AVATAR_PX = 48;

export default function AvatarsPage() {
  return (
    <main>
      <h1>Avatars</h1>
      <p>
        Rendered at {AVATAR_PX}px, cropped square. <code>sizes</code> is a fixed{' '}
        <code>{AVATAR_PX}px</code>, so the browser picks an icon rung instead of a device one.
      </p>

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
        {avatarAssets.map((asset) => (
          <Image
            key={asset.id}
            client={imgopt}
            asset={asset}
            sizes={`${AVATAR_PX}px`}
            transform={{ width: AVATAR_PX * 2, height: AVATAR_PX * 2, fit: 'cover' }}
            alt={`Avatar ${asset.id}`}
            style={{
              width: AVATAR_PX,
              height: AVATAR_PX,
              borderRadius: '50%',
              display: 'block',
            }}
          />
        ))}
      </div>

      <h2>What to check</h2>
      <ul>
        <li>
          Candidates come from the icon rungs — 16, 32, 48, 64, 96, 128, 192, 256 — not the device
          ladder.
        </li>
        <li>
          The last avatar has a 12px source, narrower than every rung. Its candidate set collapses
          to its own width rather than offering an upscale the pipeline would refuse to perform
          anyway.
        </li>
        <li>
          Each has a flat dominant-colour background behind it, which is what the component falls
          back to when an asset has no stored placeholder.
        </li>
      </ul>
    </main>
  );
}
