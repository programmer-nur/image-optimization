/**
 * How a derivative came to exist, without importing the registry.
 *
 * `DerivativeOrigin` is a value export of `@imgopt/db`, and importing a value from
 * that package pulls its whole module graph — including `PrismaClient` — into the
 * bundle. The workers hold no database connection (design.md L2), so shipping the
 * driver is dead weight in the init path of a function on the viewer's critical path,
 * and it is a credential-shaped dependency in a function that should not have one.
 *
 * Declared locally as the two string literals the column accepts. The control plane
 * validates what arrives against the real enum, so a drift here is refused there
 * rather than written.
 */
export const DERIVATIVE_ORIGIN = {
  warm: 'warm',
  ondemand: 'ondemand',
} as const;

export type DerivativeOrigin = (typeof DERIVATIVE_ORIGIN)[keyof typeof DERIVATIVE_ORIGIN];
