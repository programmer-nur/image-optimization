// GENERATED FILE — DO NOT EDIT.
// Source: infra/cloudfront/normalize.template.js + @imgopt/core
// Regenerate with: pnpm --filter @imgopt/edge generate
var LADDER = [16,32,48,64,96,128,192,256,320,480,640,750,828,960,1080,1200,1440,1920,2560,3840];
var MAX_LADDER_WIDTH = 3840;
var RATIOS = [0.42857142857142855,0.5625,0.6666666666666666,0.75,1,1.3333333333333333,1.5,1.7777777777777777,2.3333333333333335];
var RATIO_TOLERANCE = 0.03;
var MIN_RATIO = 0.05;
var MAX_RATIO = 20;
var QUALITY_LEVELS = [50,65,75,85,95];
var DEFAULT_QUALITY = 75;
var BLUR_LEVELS = [0,2,5,10,20,40];
var SHARPEN_LEVELS = [0,1,2];
var FIT_MODES = ["cover","contain","inside","outside","fill","pad"];
var FIT_ALIASES = {"pad":"contain"};
var DEFAULT_FIT = "cover";
var PADDING_FITS = ["contain"];
var CROPPING_FITS = ["cover"];
var CROP_GRAVITIES = ["center","top","bottom","left","right","entropy","attention"];
var DEFAULT_GRAVITY = "center";
var REQUESTED_FORMATS = ["auto","avif","webp","jpeg","png"];
var FORMAT_EXTENSIONS = {"avif":"avif","webp":"webp","jpeg":"jpg","png":"png"};
var MIN_DPR = 1;
var MAX_DPR = 3;
var DERIVED_PREFIX = "derived";
var FULL_WIDTH_TOKEN = "full";
var VIEWER_PATH_PREFIXES = ["i","p"];
var STORAGE_PREFIXES = ["derived","original","master","staging"];
var ASSET_ID = /^[0-9A-Za-z_-]+$/;
var VERSION_SEGMENT = /^v[0-9]+-[0-9]+$/;
var NUMERIC = /^[0-9]+(\.[0-9]+)?$/;
var HEX = /^[0-9a-f]+$/;
var ERROR_CACHE_CONTROL = 'public, max-age=60';
function has(list, value) {
  return list.indexOf(value) !== -1;
}
function snapUp(width) {
  for (var i = 0; i < LADDER.length; i++) {
    if (LADDER[i] >= width) return LADDER[i];
  }
  return MAX_LADDER_WIDTH;
}
function snapWidth(requested, dpr) {
  var effective = Math.ceil(Math.max(requested, 1) * dpr);
  if (effective > MAX_LADDER_WIDTH) effective = MAX_LADDER_WIDTH;
  return snapUp(effective);
}
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
function normalizeBackground(raw) {
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
function resolveAutoFormat(accept) {
  if (accept.indexOf('image/avif') !== -1) return 'avif';
  if (accept.indexOf('image/webp') !== -1) return 'webp';
  return 'jpeg';
}
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
  if (spec.gravity !== undefined) parts.push('g' + spec.gravity);
  if (spec.background !== undefined) parts.push('bg' + spec.background);
  if (spec.blur !== undefined) parts.push('bl' + spec.blur);
  if (spec.sharpen !== undefined) parts.push('sh' + spec.sharpen);
  return parts.join('_') + '.' + FORMAT_EXTENSIONS[spec.format];
}
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
    var looksLikeRect = /^[0-9]+(,[0-9]+){1,3}$/.test(cropRaw);
    return { error: reject(looksLikeRect ? 'unsupported_crop' : 'invalid_enum', 'crop') };
  }
  var dpr = dprRaw === undefined ? 1 : Math.min(Math.max(dprRaw, MIN_DPR), MAX_DPR);
  var width;
  var height;
  if (w !== undefined && h !== undefined) {
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
function handler(event) {
  var request = event.request;
  var segments = request.uri.split('/');
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
  request.querystring = {};
  return request;
}
