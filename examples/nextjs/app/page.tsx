import { Image } from '@imgopt/client/react';
import { heroAsset, imgopt } from '../lib/imgopt';

/**
 * Hero: the LCP element.
 *
 * This is the one image on the page that should carry `priority`. It loads eagerly,
 * hints high fetch priority, and on React 19 gets a matching `<link rel="preload">`
 * emitted automatically. Marking more than one image priority defeats the purpose —
 * the browser can only prioritise relative to something.
 *
 * `sizes` says the image spans the full viewport. Without it the browser assumes
 * exactly that anyway, but stating it keeps the intent explicit and makes the value
 * easy to correct when the layout changes.
 */
export default function HeroPage() {
  return (
    <main>
      <h1>Hero</h1>
      <p>
        Full-bleed, above the fold, marked <code>priority</code>. Inspect the element:{' '}
        <code>loading=&quot;eager&quot;</code>, <code>fetchpriority=&quot;high&quot;</code>, and a{' '}
        <code>srcset</code> whose candidates stop at the source&apos;s 3000px width.
      </p>

      <Image
        client={imgopt}
        asset={heroAsset}
        priority
        sizes="100vw"
        alt="A wide landscape"
        style={{ width: '100%', height: 'auto', borderRadius: 8 }}
      />

      <h2>What to check</h2>
      <ul>
        <li>
          Every <code>srcset</code> candidate is a ladder rung — 320, 480, 640, 750, 828, 960, 1080,
          1200, 1440, 1920, 2560 — and none exceeds 3000.
        </li>
        <li>
          <code>width</code> and <code>height</code> are present, so the browser reserves layout
          space and nothing shifts when the image arrives.
        </li>
        <li>
          There is no <code>&lt;picture&gt;</code> and no per-format <code>&lt;source&gt;</code>:
          AVIF and WebP are negotiated server-side from <code>Accept</code>, on one URL.
        </li>
      </ul>
    </main>
  );
}
