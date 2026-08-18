/**
 * Emits `normalize.generated.js` from `normalize.template.js` + `@imgopt/core`.
 *
 * Every value written here is *read out of core*, never transcribed. That is the
 * point: a transcribed ladder is a ladder that can drift, and edge/core drift is
 * silent — CloudFront caches one key while the generator writes another, producing
 * a permanent 100% miss with nothing in the error metrics. See design.md D4.
 *
 * Where core keeps something private (the padding/cropping fit sets, the DPR
 * bounds, the `full` token), it is *derived by calling core* rather than copied, so
 * the same rule holds.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BLUR_LEVELS,
  CANONICAL_FIT_MODES,
  CROP_GRAVITIES,
  DEFAULT_FIT,
  DEFAULT_GRAVITY,
  DEFAULT_QUALITY,
  DERIVED_PREFIX,
  DPR_VALUES,
  FIT_MODES,
  FORMAT_EXTENSIONS,
  LADDER,
  MAX_LADDER_WIDTH,
  MAX_RATIO,
  MIN_RATIO,
  QUALITY_LEVELS,
  RATIOS,
  RATIO_TOLERANCE,
  REQUESTED_FORMATS,
  SHARPEN_LEVELS,
  STORAGE_PREFIXES,
  VIEWER_PATH_PREFIXES,
  fitCrops,
  fitUsesBackground,
  normalizeFit,
  toVariantName,
} from '@imgopt/core';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, 'normalize.template.js');
const OUTPUT = join(here, 'normalize.generated.js');

const BEGIN = '// >>> BEGIN GENERATED TABLES';
const END = '// <<< END GENERATED TABLES';

/**
 * CloudFront Functions cap source at 10KB. Emitting past it fails at deploy time,
 * long after the change that caused it, so it is enforced here instead.
 */
const MAX_SOURCE_BYTES = 10 * 1024;

/** The token core emits when neither dimension is constrained. */
const fullWidthToken = toVariantName({ format: 'jpeg', quality: DEFAULT_QUALITY }).split('_')[0];

const tables = {
  LADDER: [...LADDER],
  MAX_LADDER_WIDTH,
  RATIOS: [...RATIOS],
  RATIO_TOLERANCE,
  MIN_RATIO,
  MAX_RATIO,
  QUALITY_LEVELS: [...QUALITY_LEVELS],
  DEFAULT_QUALITY,
  BLUR_LEVELS: [...BLUR_LEVELS],
  SHARPEN_LEVELS: [...SHARPEN_LEVELS],
  FIT_MODES: [...FIT_MODES],
  // Only the aliases, so the edge does one lookup and the table stays empty when
  // there are none. Derived by asking core, never transcribed.
  FIT_ALIASES: Object.fromEntries(
    FIT_MODES.filter((fit) => normalizeFit(fit) !== fit).map((fit) => [fit, normalizeFit(fit)]),
  ),
  DEFAULT_FIT,
  PADDING_FITS: CANONICAL_FIT_MODES.filter(fitUsesBackground),
  CROPPING_FITS: CANONICAL_FIT_MODES.filter(fitCrops),
  CROP_GRAVITIES: [...CROP_GRAVITIES],
  DEFAULT_GRAVITY,
  REQUESTED_FORMATS: [...REQUESTED_FORMATS],
  FORMAT_EXTENSIONS,
  MIN_DPR: Math.min(...DPR_VALUES),
  MAX_DPR: Math.max(...DPR_VALUES),
  DERIVED_PREFIX,
  FULL_WIDTH_TOKEN: fullWidthToken,
  VIEWER_PATH_PREFIXES: [...VIEWER_PATH_PREFIXES],
  STORAGE_PREFIXES: [...STORAGE_PREFIXES],
};

/**
 * Strips comments and blank lines.
 *
 * The template is heavily commented because it is the half a human maintains; the
 * artifact has a 10KB budget and no reader. Stripping is line-based rather than
 * token-based on purpose — a naive regex over a whole file will happily eat the `//`
 * inside `'image/avif'` — so only lines that are *entirely* comment are removed, and
 * the template is kept free of trailing comments to suit.
 */
function stripComments(source) {
  const out = [];
  let inBlock = false;

  for (const line of source.split('\n')) {
    const trimmed = line.trim();

    if (inBlock) {
      if (trimmed.endsWith('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.endsWith('*/')) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed === '') continue;

    out.push(line);
  }

  return out.join('\n');
}

function renderTables() {
  const lines = Object.entries(tables).map(
    ([name, value]) => `var ${name} = ${JSON.stringify(value)};`,
  );

  return [
    BEGIN,
    '// Generated from @imgopt/core by infra/cloudfront/generate.mjs. Do not edit.',
    ...lines,
    END,
  ].join('\n');
}

export function generate() {
  const template = readFileSync(TEMPLATE, 'utf8');

  const start = template.indexOf(BEGIN);
  const end = template.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error(`Missing table markers in ${TEMPLATE}`);
  }

  const header = [
    '// GENERATED FILE — DO NOT EDIT.',
    '// Source: infra/cloudfront/normalize.template.js + @imgopt/core',
    '// Regenerate with: pnpm --filter @imgopt/edge generate',
    '',
  ].join('\n');

  const body = stripComments(
    template.slice(0, start) + renderTables() + template.slice(end + END.length),
  );
  const source = `${header}${body}\n`;

  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_SOURCE_BYTES) {
    throw new Error(
      `Generated function is ${bytes} bytes, over the ${MAX_SOURCE_BYTES}-byte ` +
        'CloudFront Function limit. Shrink the template or the injected tables.',
    );
  }

  return { source, bytes };
}

export const OUTPUT_PATH = OUTPUT;

// Importable without side effects, so the drift test can regenerate in memory and
// compare against what is committed.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { source, bytes } = generate();
  writeFileSync(OUTPUT, source, 'utf8');
  console.log(
    `normalize.generated.js written (${bytes} bytes, ` +
      `${MAX_SOURCE_BYTES - bytes} under the CloudFront Function limit)`,
  );
}
