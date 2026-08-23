export const TELEGRAM_DELIVERY_POLICY = Object.freeze({
  preSendDeadlineMs: 5_000,
  preSendLatestTradeMaxAgeMs: 5_000,
  preSendMinDriftRatio: -0.05,
  preSendMaxDriftRatio: 0.08,
  preSendCounterLiquidityMaxDeclineRatio: 0.2,
  dontChaseDriftRatio: 0.08,
  expireDriftRatio: 0.15,
  activeSeconds: 90,
  securityRecheckSeconds: [30, 60] as const,
  recheckRetryDelayMs: 3_000,
  recheckMaximumAttempts: 2
} as const);
