/**
 * CloudFront Function — viewer-request normalizer. SOURCE TEMPLATE.
 *
 * This file is the hand-written half. `generate.mjs` reads the quantization tables
 * out of `@imgopt/core` and substitutes them into the marked block below, emitting
 * `normalize.generated.js`. Edit this file; never edit the generated one.
 *
 * WHY THE SPLIT. CloudFront Functions run a restricted runtime with a 10KB source
 * budget and no module system, so the edge cannot import the shared package — which
 * normally means two implementations of one algorithm. When those disagree,
 * CloudFront computes cache key A while the generator writes object B: a permanent
 * 100% miss on that variant, every request invoking Lambda, and not one entry in any
 * error metric. That is the highest-severity failure mode in the architecture (see
 * design.md D4), so the *data* is generated rather than transcribed, and the
 * *algorithm* is pinned by replaying the shared conformance vectors against both
 * implementations in CI.
 *
 * RUNTIME CONSTRAINTS. Written to ES5.1 so it runs on both CloudFront Functions
 * runtimes: `var` only, no arrow functions, no template literals, and `indexOf`
 * rather than `includes`. There is no network, no filesystem, and no clock budget to
 * speak of — which is also why the source width cannot be consulted here, and why
 * the canonical key is derived from the URL alone.
 */

// >>> BEGIN GENERATED TABLES — replaced by generate.mjs, do not edit
var LADDER = [];
var MAX_LADDER_WIDTH = 0;
var RATIOS = [];
var RATIO_TOLERANCE = 0;
var MIN_RATIO = 0;
var MAX_RATIO = 0;
var QUALITY_LEVELS = [];
var DEFAULT_QUALITY = 0;
var BLUR_LEVELS = [];
var SHARPEN_LEVELS = [];
var FIT_MODES = [];
var FIT_ALIASES = {};
var DEFAULT_FIT = '';
var PADDING_FITS = [];
var CROPPING_FITS = [];
var CROP_GRAVITIES = [];
var DEFAULT_GRAVITY = '';
var REQUESTED_FORMATS = [];
var FORMAT_EXTENSIONS = {};
var MIN_DPR = 1;
var MAX_DPR = 1;
var DERIVED_PREFIX = '';
var FULL_WIDTH_TOKEN = '';
var VIEWER_PATH_PREFIXES = [];
var STORAGE_PREFIXES = [];
// <<< END GENERATED TABLES

/** Asset ids are ULIDs; the character class is deliberately narrow. */
var ASSET_ID = /^[0-9A-Za-z_-]+$/;
var VERSION_SEGMENT = /^v[0-9]+-[0-9]+$/;
var NUMERIC = /^[0-9]+(\.[0-9]+)?$/;
var HEX = /^[0-9a-f]+$/;

/** Short, so a corrected URL recovers quickly. See design.md D8. */
var ERROR_CACHE_CONTROL = 'public, max-age=60';

function has(list, value) {
  return list.indexOf(value) !== -1;
}

// --- quantizers, mirroring packages/core -----------------------------------

function snapUp(width) {
  for (var i = 0; i < LADDER.length; i++) {
    if (LADDER[i] >= width) return LADDER[i];
  }
  return MAX_LADDER_WIDTH;
}

/**
 * DPR folds into the width here and never becomes a cache dimension of its own.
 * The source-width cap is deliberately absent: the edge has no asset metadata, so
 * the key is derived from the URL alone and the pipeline caps the pixels instead.
 *
 * The one-pixel floor also covers `w=0`, which would otherwise reach the ratio math
 * as a zero denominator and emit an `hNaN` key the generator refuses forever.
 */
function snapWidth(requested, dpr) {
  var effective = Math.ceil(Math.max(requested, 1) * dpr);
  if (effective > MAX_LADDER_WIDTH) effective = MAX_LADDER_WIDTH;
  return snapUp(effective);
}

/** Nearest level, first match winning a tie — the order core resolves ties in. */
function nearest(levels, requested) {
  var best = levels[0];
  var bestDelta = Infinity;
  for (var i = 0; i < levels.length; i++) {
    var delta = Math.abs(requested - levels[i]);
    if (delta < bestDelta) {
      best = levels[i];
      bestDelta = delta;
    }
  }
  return best;
}

function quantizeRatio(ratio) {
  var clamped = Math.min(Math.max(ratio, MIN_RATIO), MAX_RATIO);

  var best;
  var bestDelta = Infinity;
  for (var i = 0; i < RATIOS.length; i++) {
    var delta = Math.abs(clamped - RATIOS[i]) / RATIOS[i];
    if (delta <= RATIO_TOLERANCE && delta < bestDelta) {
      best = RATIOS[i];
      bestDelta = delta;
    }
  }
  if (best !== undefined) return best;

  return Math.round(clamped * 100) / 100;
}

function quantizeQuality(requested) {
  var clamped = Math.min(
    Math.max(requested, QUALITY_LEVELS[0]),
    QUALITY_LEVELS[QUALITY_LEVELS.length - 1],
  );
  return nearest(QUALITY_LEVELS, clamped);
}

/**
 * The one quantizer written by hand on both sides rather than generated.
 *
 * The tables above come from core, but this arithmetic does not — so this is the
 * single place in the edge function where a change to `normalizeBackground` in
 * `packages/core/src/effects.ts` has to be mirrored deliberately. The conformance
 * vectors are what catch it if it is not.
 *
 * Channels snap to the 4-bit grid (steps of 17: 00, 11, … ff) because a background is
 * otherwise 2^24 keys per box, every one of them a render and a permanent object
 * reachable from an ordinary URL. Padding bars are flat colour, so the grid is
 * invisible where the parameter applies at all.
 */
function normalizeBackground(raw) {
  // A viewer may send `#ffaa00` percent-encoded. CloudFront decodes query values,
  // but stripping the encoded form too costs one branch and removes any dependence
  // on that behaviour.
  var hex = raw.replace(/^%23/, '').replace(/^#/, '');
  if (!HEX.test(hex)) return undefined;

  var expanded = hex;
  if (hex.length === 3 || hex.length === 4) {
    expanded = '';
    for (var i = 0; i < hex.length; i++) expanded += hex.charAt(i) + hex.charAt(i);
  }
  if (expanded.length !== 6 && expanded.length !== 8) return undefined;

  var quantized = '';
  for (var j = 0; j < expanded.length; j += 2) {
    var level = Math.round(parseInt(expanded.substr(j, 2), 16) / 17) * 17;
    var digits = level.toString(16);
    quantized += digits.length === 1 ? '0' + digits : digits;
  }
  return quantized;
}

/**
 * Resolves `format=auto` against Accept.
 *
 * Alpha is unknowable here, so `auto` on a legacy client resolves to JPEG rather
 * than PNG. Both modern formats carry alpha, so this only affects clients that
 * support neither — and the pipeline still flattens onto the background colour.
 */
function resolveAutoFormat(accept) {
  if (accept.indexOf('image/avif') !== -1) return 'avif';
  if (accept.indexOf('image/webp') !== -1) return 'webp';
  return 'jpeg';
}

// --- request parsing --------------------------------------------------------

function reject(code, parameter) {
  return {
    statusCode: 400,
    statusDescription: 'Bad Request',
    headers: {
      'content-type': { value: 'application/json' },
      'cache-control': { value: ERROR_CACHE_CONTROL },
      'x-imgopt-error': { value: code },
    },
    body: JSON.stringify({ error: { code: code, parameter: parameter } }),
  };
}

function raw(query, key) {
  var entry = query[key];
  if (!entry || entry.value === undefined || entry.value === '') return undefined;
  return entry.value.trim().toLowerCase();
}

/** Returns a number, undefined, or the string 'ERROR' — mirroring core's policy. */
function numeric(query, key) {
  var value = raw(query, key);
  if (value === undefined) return undefined;
  if (!NUMERIC.test(value)) return 'ERROR';
  var parsed = Number(value);
  return isFinite(parsed) ? parsed : 'ERROR';
}

function buildVariantName(spec) {
  var parts = [];

  if (spec.width !== undefined) parts.push('w' + spec.width);
  if (spec.height !== undefined) parts.push('h' + spec.height);
  if (parts.length === 0) parts.push(FULL_WIDTH_TOKEN);

  if (spec.fit !== undefined) parts.push(spec.fit);
  parts.push('q' + spec.quality);

  // Rare parameters are spelled out, in this fixed order, because the generator
  // reconstructs the render from the key alone. See design.md D3.
  if (spec.gravity !== undefined) parts.push('g' + spec.gravity);
  if (spec.background !== undefined) parts.push('bg' + spec.background);
  if (spec.blur !== undefined) parts.push('bl' + spec.blur);
  if (spec.sharpen !== undefined) parts.push('sh' + spec.sharpen);

  return parts.join('_') + '.' + FORMAT_EXTENSIONS[spec.format];
}

/**
 * Normalizes a query into a variant filename.
 *
 * Policy, identical to `parseTransform`: numerics out of range are clamped so a
 * slightly wrong URL keeps working, unparseable numbers and unknown enums are
 * rejected because silently substituting one would deliver a visually wrong image,
 * and unrecognized parameters are ignored so they never reach the cache key.
 */
function normalize(query, accept) {
  var w = numeric(query, 'w');
  if (w === 'ERROR') return { error: reject('invalid_number', 'w') };
  var h = numeric(query, 'h');
  if (h === 'ERROR') return { error: reject('invalid_number', 'h') };
  var q = numeric(query, 'q');
  if (q === 'ERROR') return { error: reject('invalid_number', 'q') };
  var blurRaw = numeric(query, 'blur');
  if (blurRaw === 'ERROR') return { error: reject('invalid_number', 'blur') };
  var sharpenRaw = numeric(query, 'sharpen');
  if (sharpenRaw === 'ERROR') return { error: reject('invalid_number', 'sharpen') };
  var dprRaw = numeric(query, 'dpr');
  if (dprRaw === 'ERROR') return { error: reject('invalid_number', 'dpr') };

  var fitRaw = raw(query, 'fit');
  if (fitRaw !== undefined && !has(FIT_MODES, fitRaw)) {
    return { error: reject('invalid_enum', 'fit') };
  }

  var formatRaw = raw(query, 'format');
  if (formatRaw !== undefined && !has(REQUESTED_FORMATS, formatRaw)) {
    return { error: reject('invalid_enum', 'format') };
  }

  var cropRaw = raw(query, 'crop');
  if (cropRaw !== undefined && !has(CROP_GRAVITIES, cropRaw)) {
    // Absolute rectangles are the case worth naming: they are the one parameter
    // that would reintroduce an unbounded key space.
    var looksLikeRect = /^[0-9]+(,[0-9]+){1,3}$/.test(cropRaw);
    return { error: reject(looksLikeRect ? 'unsupported_crop' : 'invalid_enum', 'crop') };
  }

  var dpr = dprRaw === undefined ? 1 : Math.min(Math.max(dprRaw, MIN_DPR), MAX_DPR);

  var width;
  var height;
  if (w !== undefined && h !== undefined) {
    // Both floored at one pixel before the ratio, matching resolveDimensions: `w=0`
    // would otherwise divide by zero and carry NaN into the key.
    width = snapWidth(w, dpr);
    height = Math.round(width * quantizeRatio(Math.max(h, 1) / Math.max(w, 1)));
  } else if (w !== undefined) {
    width = snapWidth(w, dpr);
  } else if (h !== undefined) {
    height = snapWidth(h, dpr);
  }

  var spec = {
    format: formatRaw === undefined || formatRaw === 'auto' ? resolveAutoFormat(accept) : formatRaw,
    quality: q === undefined ? DEFAULT_QUALITY : quantizeQuality(q),
  };
  if (width !== undefined) spec.width = width;
  if (height !== undefined) spec.height = height;

  // Everything below is elided when it cannot affect the output. An inert parameter
  // left in the key fragments the cache exactly as badly as an unquantized one.
  //
  // `pad` is an accepted spelling of `contain`, not a mode of its own: both reach
  // sharp as the same call, so both must reach the same key.
  var boxConstrained = width !== undefined && height !== undefined;
  var fit = fitRaw === undefined ? DEFAULT_FIT : fitRaw;
  if (FIT_ALIASES[fit] !== undefined) fit = FIT_ALIASES[fit];

  if (boxConstrained) {
    spec.fit = fit;

    var gravity = cropRaw === undefined ? DEFAULT_GRAVITY : cropRaw;
    if (has(CROPPING_FITS, fit) && gravity !== DEFAULT_GRAVITY) spec.gravity = gravity;

    if (has(PADDING_FITS, fit)) {
      var bgRaw = raw(query, 'background');
      var background = bgRaw === undefined ? undefined : normalizeBackground(bgRaw);
      if (background !== undefined) spec.background = background;
    }
  }

  var blur = blurRaw === undefined ? 0 : nearest(BLUR_LEVELS, Math.max(blurRaw, 0));
  if (blur > 0) spec.blur = blur;

  var sharpen = sharpenRaw === undefined ? 0 : nearest(SHARPEN_LEVELS, Math.max(sharpenRaw, 0));
  if (sharpen > 0) spec.sharpen = sharpen;

  return { variant: buildVariantName(spec) };
}

// --- entry point ------------------------------------------------------------

// CloudFront invokes this by name from the global scope; nothing in-file calls it.
function handler(event) {
  var request = event.request;

  // `/i/{assetId}/{version}/{slug}` for public delivery, `/p/...` for the
  // signature-required behavior. Both normalize into the same derived key space: a
  // private asset is bucketed exactly like a public one, and the signature is
  // checked by CloudFront against the URL the viewer sent, before this runs.
  //
  // The slug is decoration and never affects which bytes are returned, so it is
  // simply dropped.
  var segments = request.uri.split('/');

  // A raw storage path is the one way to reach the generator without passing through
  // the quantizers above — `/derived/{id}/{v}/w641_q75.avif` names a width no ladder
  // contains. The default behavior routes every path to the same origin group, so
  // that has to be refused here rather than left to the origin. See design.md D3.
  if (has(STORAGE_PREFIXES, segments[1])) {
    return reject('unsupported_path', 'path');
  }

  if (segments.length < 4 || segments.length > 5 || !has(VIEWER_PATH_PREFIXES, segments[1])) {
    return request;
  }

  var assetId = segments[2];
  var version = segments[3];
  if (!ASSET_ID.test(assetId)) return reject('invalid_asset_id', 'path');
  if (!VERSION_SEGMENT.test(version)) return reject('invalid_version', 'path');

  var accept = request.headers.accept ? request.headers.accept.value : '';
  var result = normalize(request.querystring || {}, accept);
  if (result.error) return result.error;

  request.uri = '/' + DERIVED_PREFIX + '/' + assetId + '/' + version + '/' + result.variant;
  // The rewritten path IS the cache key. Anything left in the query string would
  // either fragment it or be ignored; dropping it makes that explicit.
  //
  // That includes a signed URL's Key-Pair-Id, Signature and Expires. Safe only
  // because CloudFront validates a trusted key group before it invokes a
  // viewer-request function — if that order were reversed, every correctly signed
  // `/p/` URL would be refused while carrying a valid signature. Unverified against
  // a real distribution; task 11.6 is not done until a signed URL returns 200.
  request.querystring = {};

  return request;
}
