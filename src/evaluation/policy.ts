export const EVALUATION_POLICY = Object.freeze({
  entryPolicyVersion: 'target-plus-3s-first-trade-v1',
  entryTradeMaxDelayMs: 3_000,
  poolTradesPageSize: 300,
  horizonsSeconds: [10, 30, 60, 90, 300, 900, 3_600, 14_400, 86_400] as const,
  publicHorizonsSeconds: [10, 30, 60, 300, 900, 3_600, 14_400, 86_400] as const,
  tradesPathCutoffSeconds: 90,
  retryDelayMs: 3_000,
  maximumAttempts: 2,
  betaMatureSamples: 20,
  betaMaturityHorizonSeconds: 900,
  milestoneCounts: [50, 100, 200] as const,
  milestoneStepAfter200: 100,
  parameterReviewStep: 20,
  simulatedEntryUsd: 100,
  thresholdPairs: [
    { name: 'path30_15', upRatio: 1.3, downRatio: 0.85 },
    { name: 'path2x_30', upRatio: 2, downRatio: 0.7 }
  ] as const
});

export type EvaluationHorizon = (typeof EVALUATION_POLICY.horizonsSeconds)[number];

export interface OhlcvRequestPolicy {
  readonly timeframe: 'second' | 'minute';
  readonly aggregate: 1 | 5;
  readonly limit: number;
}

export function ohlcvRequestForHorizon(
  horizonSeconds: EvaluationHorizon
): OhlcvRequestPolicy {
  if (horizonSeconds <= 900) {
    return { timeframe: 'second' as const, aggregate: 1 as const, limit: horizonSeconds + 1 };
  }
  if (horizonSeconds <= 14_400) {
    return {
      timeframe: 'minute' as const,
      aggregate: 1 as const,
      limit: Math.ceil(horizonSeconds / 60) + 1
    };
  }
  return { timeframe: 'minute' as const, aggregate: 5 as const, limit: 289 };
}
