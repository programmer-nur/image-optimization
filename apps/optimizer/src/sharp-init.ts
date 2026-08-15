/**
 * Sharp configuration for the Lambda runtime.
 *
 * Imported for its side effects at module scope so it runs once during init — which
 * on a managed runtime is billed as free init time — rather than on every warm
 * invocation.
 *
 * Both settings matter in Lambda specifically (design.md D10):
 *
 * - `concurrency(1)`: libvips defaults its thread pool to the core count. A function
 *   processing one image at a time gets no benefit from intra-image parallelism at
 *   Lambda's low vCPU counts, and the extra threads inflate peak memory — which is
 *   how a function that passes testing OOMs a week later.
 * - `cache(false)`: libvips' operation cache holds decoded data across invocations
 *   on a warm container, steadily growing memory for no gain when each invocation is
 *   a different image.
 */

import sharp from 'sharp';

sharp.concurrency(1);
sharp.cache(false);

export { sharp };
