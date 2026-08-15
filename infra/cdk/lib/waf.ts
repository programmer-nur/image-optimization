/**
 * Rate limiting for the control plane, at the load balancer.
 *
 * Deliberately *ahead* of the application rather than inside it. A per-instance
 * limiter is not a limiter: the control plane autoscales, so an attacker's effective
 * budget would be the limit multiplied by however many tasks happen to be running,
 * and it would grow precisely when the service is already under load. WAF counts in
 * one place regardless of instance count, and rejects before a request reaches a task
 * at all — which is the only way a flood costs nothing to absorb.
 *
 * The delivery plane needs none of this: it is bounded structurally by the variant
 * space (see design.md D3), and malformed requests are already refused at the edge
 * function without an origin fetch.
 */

import { Duration } from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';

export interface RateLimitConfig {
  /** Requests per five-minute window, per source IP, on mutating paths. */
  mutatingRequestsPer5Min: number;
  /** A looser ceiling covering everything, to blunt broad scraping. */
  overallRequestsPer5Min: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  // Uploads are expensive and rare per client. A legitimate bulk importer trips this
  // and should be given its own key and its own allowance rather than a higher global
  // number, which would raise the ceiling for everyone.
  mutatingRequestsPer5Min: 300,
  overallRequestsPer5Min: 3000,
};

/**
 * A regional web ACL for the ALB.
 *
 * Regional, not CLOUDFRONT scope: this protects the control plane's load balancer.
 * The two scopes are not interchangeable and a CLOUDFRONT-scoped ACL cannot be
 * associated with an ALB at all.
 */
export function createControlPlaneWebAcl(
  scope: Construct,
  id: string,
  options: { environment: string; limits?: RateLimitConfig },
): wafv2.CfnWebACL {
  const limits = options.limits ?? DEFAULT_RATE_LIMITS;

  return new wafv2.CfnWebACL(scope, id, {
    name: `imgopt-${options.environment}-api`,
    scope: 'REGIONAL',
    defaultAction: { allow: {} },
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      metricName: `imgopt-${options.environment}-api`,
      sampledRequestsEnabled: true,
    },
    rules: [
      {
        // Mutating paths first, so the tighter budget wins when both would match.
        name: 'RateLimitMutating',
        priority: 0,
        action: { block: {} },
        statement: {
          rateBasedStatement: {
            limit: limits.mutatingRequestsPer5Min,
            aggregateKeyType: 'IP',
            scopeDownStatement: {
              notStatement: {
                statement: {
                  byteMatchStatement: {
                    fieldToMatch: { method: {} },
                    positionalConstraint: 'EXACTLY',
                    searchString: 'GET',
                    textTransformations: [{ priority: 0, type: 'UPPERCASE' }],
                  },
                },
              },
            },
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'RateLimitMutating',
          sampledRequestsEnabled: true,
        },
      },
      {
        name: 'RateLimitOverall',
        priority: 1,
        action: { block: {} },
        statement: {
          rateBasedStatement: {
            limit: limits.overallRequestsPer5Min,
            aggregateKeyType: 'IP',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'RateLimitOverall',
          sampledRequestsEnabled: true,
        },
      },
      {
        /*
         * Managed rules in COUNT mode, not BLOCK.
         *
         * The common ruleset includes body-size and generic-payload rules that flag
         * ordinary multipart image uploads. Blocking on day one would reject
         * legitimate traffic in a way that looks like a broken uploader; counting
         * first makes the false positives visible in metrics so the rules that
         * actually fire can be excluded deliberately.
         */
        name: 'AWSManagedCommon',
        priority: 2,
        overrideAction: { count: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesCommonRuleSet',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'AWSManagedCommon',
          sampledRequestsEnabled: true,
        },
      },
      {
        name: 'AWSManagedKnownBadInputs',
        priority: 3,
        // Safe to block outright: these are malformed requests no client sends.
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesKnownBadInputsRuleSet',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'AWSManagedKnownBadInputs',
          sampledRequestsEnabled: true,
        },
      },
    ],
  });
}

/** How long a blocked client stays blocked. Documented for the runbook. */
export const WAF_BLOCK_WINDOW = Duration.minutes(5);
