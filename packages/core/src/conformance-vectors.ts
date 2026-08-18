/**
 * Shared conformance vectors.
 *
 * Two jobs, and it matters that they are different:
 *
 * 1. **Oracle.** Every `expected` value below is written by hand, not computed by
 *    the code under test. These verify that the normalization rules are implemented
 *    correctly at all.
 *
 * 2. **Drift detection.** The same vectors are replayed against the generated
 *    CloudFront Function (task 8.4). If the edge and the core ever disagree,
 *    CloudFront caches one key while the generator writes another — a permanent
 *    100% miss on that variant, invisible in error rates. This suite is the cheapest
 *    structural defense against that. See design.md D4.
 *
 * Do not compute expectations from `packages/core` functions. A vector that calls
 * the implementation to derive its own expectation tests nothing.
 */

export interface ConformanceVector {
  /** Raw query string, without the leading `?`. */
  query: string;
  /** Viewer Accept header. Omitted means a legacy client. */
  accept?: string;
  /** Expected variant filename, or `ERROR:<code>` when the request must be rejected. */
  expected: string;
}

const ACCEPT_AVIF = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';
const ACCEPT_WEBP = 'image/webp,image/apng,image/*,*/*;q=0.8';
const ACCEPT_LEGACY = 'image/*,*/*;q=0.8';

/**
 * Ladder boundaries. For each rung: the value itself lands on it, and one pixel
 * past it snaps to the next rung up. Expectations transcribed from the ladder in
 * design.md D3, not generated.
 */
const WIDTH_BOUNDARIES: ReadonlyArray<[input: number, expectedWidth: number]> = [
  [1, 16],
  [16, 16],
  [17, 32],
  [32, 32],
  [33, 48],
  [48, 48],
  [49, 64],
  [64, 64],
  [65, 96],
  [96, 96],
  [97, 128],
  [128, 128],
  [129, 192],
  [192, 192],
  [193, 256],
  [256, 256],
  [257, 320],
  [320, 320],
  [321, 480],
  [480, 480],
  [481, 640],
  [640, 640],
  [641, 750],
  [750, 750],
  [751, 828],
  [828, 828],
  [829, 960],
  [960, 960],
  [961, 1080],
  [1080, 1080],
  [1081, 1200],
  [1200, 1200],
  [1201, 1440],
  [1440, 1440],
  [1441, 1920],
  [1920, 1920],
  [1921, 2560],
  [2560, 2560],
  [2561, 3840],
  [3840, 3840],
  // Above the ladder maximum, clamped rather than rejected.
  [3841, 3840],
  [99999, 3840],
];

const widthVectors: ConformanceVector[] = WIDTH_BOUNDARIES.map(([input, expectedWidth]) => ({
  query: `w=${input}`,
  accept: ACCEPT_AVIF,
  expected: `w${expectedWidth}_q75.avif`,
}));

/** The worked examples from design.md D3, restated as vectors. */
const workedExamples: ConformanceVector[] = [
  { query: 'w=602', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  { query: 'w=980', accept: ACCEPT_AVIF, expected: 'w1080_q75.avif' },
  { query: 'w=640', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  { query: 'w=641', accept: ACCEPT_AVIF, expected: 'w750_q75.avif' },
  { query: 'w=400&dpr=2', accept: ACCEPT_AVIF, expected: 'w828_q75.avif' },
  { query: 'w=40', accept: ACCEPT_AVIF, expected: 'w48_q75.avif' },
];

/** DPR folds into width before snapping and never becomes its own key axis. */
const dprVectors: ConformanceVector[] = [
  { query: 'w=828&dpr=1', accept: ACCEPT_AVIF, expected: 'w828_q75.avif' },
  { query: 'w=414&dpr=2', accept: ACCEPT_AVIF, expected: 'w828_q75.avif' },
  { query: 'w=276&dpr=3', accept: ACCEPT_AVIF, expected: 'w828_q75.avif' },
  { query: 'w=213&dpr=3', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  // 214 * 3 = 642, one pixel past the 640 rung.
  { query: 'w=214&dpr=3', accept: ACCEPT_AVIF, expected: 'w750_q75.avif' },
  { query: 'w=320&dpr=2', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  { query: 'w=640', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  // Out of range clamps to 3 rather than rejecting.
  { query: 'w=100&dpr=9', accept: ACCEPT_AVIF, expected: 'w320_q75.avif' },
  { query: 'w=100&dpr=0.1', accept: ACCEPT_AVIF, expected: 'w128_q75.avif' },
];

/** Quality snaps to the nearest level; defaults are per format, not global. */
const qualityVectors: ConformanceVector[] = [
  { query: 'w=640&q=50', accept: ACCEPT_AVIF, expected: 'w640_q50.avif' },
  { query: 'w=640&q=57', accept: ACCEPT_AVIF, expected: 'w640_q50.avif' },
  { query: 'w=640&q=58', accept: ACCEPT_AVIF, expected: 'w640_q65.avif' },
  { query: 'w=640&q=65', accept: ACCEPT_AVIF, expected: 'w640_q65.avif' },
  { query: 'w=640&q=70', accept: ACCEPT_AVIF, expected: 'w640_q65.avif' },
  { query: 'w=640&q=71', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  { query: 'w=640&q=75', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  { query: 'w=640&q=82', accept: ACCEPT_AVIF, expected: 'w640_q85.avif' },
  { query: 'w=640&q=85', accept: ACCEPT_AVIF, expected: 'w640_q85.avif' },
  { query: 'w=640&q=95', accept: ACCEPT_AVIF, expected: 'w640_q95.avif' },
  // Out of range clamps rather than rejecting: a slightly wrong URL keeps working.
  { query: 'w=640&q=250', accept: ACCEPT_AVIF, expected: 'w640_q95.avif' },
  { query: 'w=640&q=0', accept: ACCEPT_AVIF, expected: 'w640_q50.avif' },
  // Per-format defaults when q is omitted.
  { query: 'w=640', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  { query: 'w=640', accept: ACCEPT_WEBP, expected: 'w640_q75.webp' },
  { query: 'w=640', accept: ACCEPT_LEGACY, expected: 'w640_q75.jpg' },
];

/** Format negotiation resolves at the edge and is baked into the path. */
const formatVectors: ConformanceVector[] = [
  { query: 'w=640', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  { query: 'w=640', accept: ACCEPT_WEBP, expected: 'w640_q75.webp' },
  { query: 'w=640', accept: ACCEPT_LEGACY, expected: 'w640_q75.jpg' },
  { query: 'w=640', expected: 'w640_q75.jpg' },
  { query: 'w=640&format=auto', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  // An explicit format ignores Accept entirely.
  { query: 'w=640&format=jpeg', accept: ACCEPT_AVIF, expected: 'w640_q75.jpg' },
  { query: 'w=640&format=webp', accept: ACCEPT_AVIF, expected: 'w640_q75.webp' },
  { query: 'w=640&format=png', accept: ACCEPT_AVIF, expected: 'w640_q75.png' },
  { query: 'w=640&format=avif', accept: ACCEPT_LEGACY, expected: 'w640_q75.avif' },
  // Varied Accept strings that all advertise AVIF collapse to one key.
  { query: 'w=640', accept: 'image/avif', expected: 'w640_q75.avif' },
  { query: 'w=640', accept: 'text/html,image/avif;q=0.9', expected: 'w640_q75.avif' },
  { query: 'w=640', accept: 'image/webp,image/avif', expected: 'w640_q75.avif' },
];

/** Height is not snapped to the ladder; the aspect ratio is quantized. */
const ratioVectors: ConformanceVector[] = [
  { query: 'w=640&h=360', accept: ACCEPT_AVIF, expected: 'w640_h360_cover_q75.avif' },
  // Within the 3% tolerance, so it shares a key with the exact 16:9 request.
  { query: 'w=640&h=362', accept: ACCEPT_AVIF, expected: 'w640_h360_cover_q75.avif' },
  { query: 'w=640&h=355', accept: ACCEPT_AVIF, expected: 'w640_h360_cover_q75.avif' },
  { query: 'w=640&h=640', accept: ACCEPT_AVIF, expected: 'w640_h640_cover_q75.avif' },
  { query: 'w=640&h=480', accept: ACCEPT_AVIF, expected: 'w640_h480_cover_q75.avif' },
  { query: 'w=640&h=427', accept: ACCEPT_AVIF, expected: 'w640_h427_cover_q75.avif' },
  { query: 'w=640&h=853', accept: ACCEPT_AVIF, expected: 'w640_h853_cover_q75.avif' },
  { query: 'w=640&h=1138', accept: ACCEPT_AVIF, expected: 'w640_h1138_cover_q75.avif' },
  // Width snaps first, then the height follows the quantized ratio.
  { query: 'w=602&h=339', accept: ACCEPT_AVIF, expected: 'w640_h360_cover_q75.avif' },
  // Height alone snaps on the ladder; width follows the source.
  { query: 'h=480', accept: ACCEPT_AVIF, expected: 'h480_q75.avif' },
  { query: 'h=481', accept: ACCEPT_AVIF, expected: 'h640_q75.avif' },
];

/** Inert parameters are elided, so identical pixels give identical keys. */
const elisionVectors: ConformanceVector[] = [
  // fit cannot matter without a height constraint.
  { query: 'w=640', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  { query: 'w=640&fit=cover', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  { query: 'w=640&fit=contain', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  { query: 'w=640&fit=inside', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  // background only survives on fits that leave empty area.
  {
    query: 'w=640&h=640&fit=cover&background=ff0000',
    accept: ACCEPT_AVIF,
    expected: 'w640_h640_cover_q75.avif',
  },
  // gravity only survives on cropping fits, and only when non-default.
  {
    query: 'w=640&h=640&fit=cover&crop=center',
    accept: ACCEPT_AVIF,
    expected: 'w640_h640_cover_q75.avif',
  },
  {
    query: 'w=640&h=640&fit=contain&crop=attention',
    accept: ACCEPT_AVIF,
    expected: 'w640_h640_contain_q75.avif',
  },
  // identity-level effects leave no trace.
  { query: 'w=640&blur=0', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  { query: 'w=640&sharpen=0', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  // dpr never appears in the key.
  { query: 'w=640&dpr=1', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  // unknown parameters are ignored.
  { query: 'w=640&utm_source=newsletter', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  { query: 'w=640&nonsense=1&other=2', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  // order and case are irrelevant.
  { query: 'q=75&w=640', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  { query: 'w=640&q=75', accept: ACCEPT_AVIF, expected: 'w640_q75.avif' },
  { query: 'w=640&h=360&fit=COVER', accept: ACCEPT_AVIF, expected: 'w640_h360_cover_q75.avif' },
  // Enum *values* are case-insensitive; parameter *names* are not, per HTTP
  // convention. An uppercase name is simply an unrecognized parameter, and
  // unrecognized parameters are ignored.
  { query: 'W=640', accept: ACCEPT_AVIF, expected: 'full_q75.avif' },
  // no parameters at all -> source dimensions.
  { query: '', accept: ACCEPT_AVIF, expected: 'full_q75.avif' },
  { query: 'q=85', accept: ACCEPT_AVIF, expected: 'full_q85.avif' },
];

/**
 * Fit modes, all requiring a height constraint to appear at all.
 *
 * `pad` is an accepted spelling that resolves to `contain`: sharp receives the same
 * call for both, so two keys would mean two objects holding identical bytes.
 */
const fitVectors: ConformanceVector[] = [
  { query: 'w=640&h=360&fit=cover', accept: ACCEPT_AVIF, expected: 'w640_h360_cover_q75.avif' },
  { query: 'w=640&h=360&fit=contain', accept: ACCEPT_AVIF, expected: 'w640_h360_contain_q75.avif' },
  { query: 'w=640&h=360&fit=inside', accept: ACCEPT_AVIF, expected: 'w640_h360_inside_q75.avif' },
  { query: 'w=640&h=360&fit=outside', accept: ACCEPT_AVIF, expected: 'w640_h360_outside_q75.avif' },
  { query: 'w=640&h=360&fit=fill', accept: ACCEPT_AVIF, expected: 'w640_h360_fill_q75.avif' },
  { query: 'w=640&h=360&fit=pad', accept: ACCEPT_AVIF, expected: 'w640_h360_contain_q75.avif' },
  // Enum values are case-insensitive on both sides. Asserted as a vector, not only as
  // an equivalence group: a group proves each implementation is self-consistent, and
  // this is the only gate that proves the two agree on *which* key.
  { query: 'w=640&h=360&fit=PAD', accept: ACCEPT_AVIF, expected: 'w640_h360_contain_q75.avif' },
  { query: 'w=640&h=360&fit=Contain', accept: ACCEPT_AVIF, expected: 'w640_h360_contain_q75.avif' },
  {
    query: 'w=640&h=360&fit=pad&background=ff0000',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_contain_q75_bgff0000.avif',
  },
  // cover is the default when a height is constrained.
  { query: 'w=640&h=360', accept: ACCEPT_AVIF, expected: 'w640_h360_cover_q75.avif' },
];

/**
 * Gravity survives only where a crop actually happens.
 *
 * `outside` resizes so the result covers the requested box and hands the whole thing
 * back — sharp never crops it, so every gravity produces the same pixels. Keeping
 * gravity in those keys multiplies one variant by the gravity enum, each copy
 * byte-identical to the others.
 */
const gravityElisionVectors: ConformanceVector[] = [
  {
    query: 'w=640&h=360&fit=outside&crop=attention',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_outside_q75.avif',
  },
  {
    query: 'w=640&h=360&fit=outside&crop=top',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_outside_q75.avif',
  },
  {
    query: 'w=640&h=360&fit=inside&crop=entropy',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_inside_q75.avif',
  },
  {
    query: 'w=640&h=360&fit=fill&crop=left',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_fill_q75.avif',
  },
  // cover is the one fit that discards pixels, so gravity is real there.
  {
    query: 'w=640&h=360&fit=cover&crop=top',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_cover_q75_gtop.avif',
  },
];

/**
 * Zero dimensions clamp rather than producing NaN.
 *
 * `?w=0&h=0` divided zero by zero, which carried NaN through the ratio and emitted an
 * `hNaN` key: a path the edge produced happily and the generator then refused
 * forever — a permanently broken URL from a merely silly one.
 */
const zeroDimensionVectors: ConformanceVector[] = [
  { query: 'w=0', accept: ACCEPT_AVIF, expected: 'w16_q75.avif' },
  { query: 'h=0', accept: ACCEPT_AVIF, expected: 'h16_q75.avif' },
  { query: 'w=0&h=0', accept: ACCEPT_AVIF, expected: 'w16_h16_cover_q75.avif' },
  { query: 'w=0&h=360', accept: ACCEPT_AVIF, expected: 'w16_h320_cover_q75.avif' },
  { query: 'w=640&h=0', accept: ACCEPT_AVIF, expected: 'w640_h32_cover_q75.avif' },
];

/** Rejections. The edge must refuse these before any origin cost is incurred. */
const errorVectors: ConformanceVector[] = [
  { query: 'w=640&fit=squish', expected: 'ERROR:invalid_enum' },
  { query: 'w=640&format=bmp', expected: 'ERROR:invalid_enum' },
  { query: 'w=640&h=360&crop=nowhere', expected: 'ERROR:invalid_enum' },
  // `focal` left the grammar: the delivery plane never reads the registry, so a
  // stored focal point could not reach the render, and the key it minted held bytes
  // identical to the elided centre key.
  { query: 'w=640&h=360&crop=focal', expected: 'ERROR:invalid_enum' },
  { query: 'w=640&h=360&fit=cover&crop=focal', expected: 'ERROR:invalid_enum' },
  // Absolute pixel crops would reintroduce an unbounded key space.
  { query: 'w=640&crop=100,200,300,400', expected: 'ERROR:unsupported_crop' },
  { query: 'w=640&crop=10,20', expected: 'ERROR:unsupported_crop' },
  // Unparseable numerics are rejected; out-of-range ones are clamped.
  { query: 'w=abc', expected: 'ERROR:invalid_number' },
  { query: 'w=-5', expected: 'ERROR:invalid_number' },
  { query: 'w=1e5', expected: 'ERROR:invalid_number' },
  { query: 'w=640&q=high', expected: 'ERROR:invalid_number' },
  { query: 'w=640&dpr=two', expected: 'ERROR:invalid_number' },
  { query: 'w=640&blur=lots', expected: 'ERROR:invalid_number' },
  { query: 'h=NaN', expected: 'ERROR:invalid_number' },
];

/**
 * Effects. Rare parameters are spelled out rather than hashed, in a fixed order, so
 * these expectations pin the exact tail — the generator parses it back to decide
 * what to render, which makes the encoding part of the contract rather than an
 * implementation detail of the key.
 */
const effectVectors: ConformanceVector[] = [
  { query: 'w=640&blur=5', accept: ACCEPT_AVIF, expected: 'w640_q75_bl5.avif' },
  { query: 'w=640&blur=4', accept: ACCEPT_AVIF, expected: 'w640_q75_bl5.avif' },
  { query: 'w=640&sharpen=1', accept: ACCEPT_AVIF, expected: 'w640_q75_sh1.avif' },
  { query: 'w=640&blur=10&sharpen=2', accept: ACCEPT_AVIF, expected: 'w640_q75_bl10_sh2.avif' },
  {
    query: 'w=640&h=360&fit=pad&background=ff0000',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_contain_q75_bgff0000.avif',
  },
  {
    query: 'w=640&h=360&fit=pad&background=fa0',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_contain_q75_bgffaa00.avif',
  },
  // Channels snap to the 4-bit grid. Left unquantized, a background is 2^24 keys per
  // box — the width hole again, spelled in hex — and every one of them is a render
  // and a permanent object reachable from an ordinary URL.
  {
    query: 'w=640&h=360&fit=contain&background=ff0001',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_contain_q75_bgff0000.avif',
  },
  {
    query: 'w=640&h=360&fit=contain&background=808080',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_contain_q75_bg888888.avif',
  },
  {
    query: 'w=640&h=360&fit=contain&background=7f7f7f',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_contain_q75_bg777777.avif',
  },
  {
    query: 'w=640&h=360&fit=contain&background=12345678',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_contain_q75_bg11335577.avif',
  },
  {
    query: 'w=640&h=360&fit=contain&background=ff0000',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_contain_q75_bgff0000.avif',
  },
  {
    query: 'w=640&h=360&fit=cover&crop=attention',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_cover_q75_gattention.avif',
  },
  {
    query: 'w=640&h=360&fit=cover&crop=center',
    accept: ACCEPT_AVIF,
    expected: 'w640_h360_cover_q75.avif',
  },
];

/**
 * Every ladder rung against every explicit format.
 *
 * The extension and default-quality tables are restated literally here rather than
 * imported from `formats.ts` / `quality.ts` — a vector that derives its expectation
 * from the code under test asserts nothing.
 */
const LADDER_RUNGS = [
  16, 32, 48, 64, 96, 128, 192, 256, 320, 480, 640, 750, 828, 960, 1080, 1200, 1440, 1920, 2560,
  3840,
] as const;

const FORMAT_TABLE: ReadonlyArray<[format: string, extension: string, defaultQuality: number]> = [
  ['avif', 'avif', 75],
  ['webp', 'webp', 75],
  ['jpeg', 'jpg', 75],
  ['png', 'png', 75],
];

const formatMatrixVectors: ConformanceVector[] = LADDER_RUNGS.flatMap((width) =>
  FORMAT_TABLE.map(([format, extension, defaultQuality]) => ({
    query: `w=${width}&format=${format}`,
    accept: ACCEPT_AVIF,
    expected: `w${width}_q${defaultQuality}.${extension}`,
  })),
);

export const CONFORMANCE_VECTORS: readonly ConformanceVector[] = [
  ...widthVectors,
  ...formatMatrixVectors,
  ...workedExamples,
  ...dprVectors,
  ...qualityVectors,
  ...formatVectors,
  ...ratioVectors,
  ...elisionVectors,
  ...fitVectors,
  ...gravityElisionVectors,
  ...zeroDimensionVectors,
  ...errorVectors,
  ...effectVectors,
];

/**
 * Groups of requests that must collapse onto a single cache key. Distinct from the
 * vectors above: these assert *equivalence*, which is the property bucketing exists
 * to deliver, without pinning the exact key.
 */
export const EQUIVALENCE_GROUPS: ReadonlyArray<{
  name: string;
  accept?: string;
  queries: readonly string[];
}> = [
  {
    name: 'widths inside one bucket',
    accept: ACCEPT_AVIF,
    queries: ['w=481', 'w=500', 'w=602', 'w=639', 'w=640'],
  },
  {
    name: 'dpr folded into width',
    accept: ACCEPT_AVIF,
    queries: ['w=640', 'w=320&dpr=2', 'w=213&dpr=3'],
  },
  {
    name: 'parameter order and case',
    accept: ACCEPT_AVIF,
    queries: ['w=640&q=75', 'q=75&w=640', 'w=640&q=75&utm_campaign=x'],
  },
  {
    name: 'inert fit with only a height constrained',
    accept: ACCEPT_AVIF,
    queries: ['h=480', 'h=480&fit=cover', 'h=480&fit=pad&background=ff0000'],
  },
  {
    name: 'inert fit without a height constraint',
    accept: ACCEPT_AVIF,
    queries: ['w=640', 'w=640&fit=cover', 'w=640&fit=inside', 'w=640&fit=fill'],
  },
  {
    name: 'quality inside one level',
    accept: ACCEPT_AVIF,
    queries: ['w=640&q=71', 'w=640&q=75', 'w=640&q=78'],
  },
  {
    name: 'ratio inside tolerance',
    accept: ACCEPT_AVIF,
    queries: ['w=640&h=360', 'w=640&h=362', 'w=640&h=356'],
  },
  {
    name: 'background normalization',
    accept: ACCEPT_AVIF,
    queries: [
      'w=640&h=360&fit=pad&background=ffaa00',
      'w=640&h=360&fit=pad&background=FFAA00',
      'w=640&h=360&fit=pad&background=%23ffaa00',
      'w=640&h=360&fit=pad&background=fa0',
    ],
  },
  {
    name: 'blur inside one level',
    accept: ACCEPT_AVIF,
    queries: ['w=640&blur=4', 'w=640&blur=5', 'w=640&blur=6'],
  },
  {
    name: 'pad is a spelling of contain',
    accept: ACCEPT_AVIF,
    queries: [
      'w=640&h=360&fit=pad',
      'w=640&h=360&fit=contain',
      'w=640&h=360&fit=PAD',
      'w=640&h=360&fit=pad&crop=attention',
    ],
  },
  {
    name: 'gravity on fits that never crop',
    accept: ACCEPT_AVIF,
    queries: [
      'w=640&h=360&fit=outside',
      'w=640&h=360&fit=outside&crop=top',
      'w=640&h=360&fit=outside&crop=attention',
      'w=640&h=360&fit=outside&crop=center',
    ],
  },
];
