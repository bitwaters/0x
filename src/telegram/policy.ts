export const TELEGRAM_DELIVERY_POLICY = Object.freeze({
  preSendMaxDriftRatio: 0.08,
  dontChaseDriftRatio: 0.08,
  expireDriftRatio: 0.15,
  activeSeconds: 90,
  securityRecheckSeconds: [30, 60] as const,
  recheckRetryDelayMs: 3_000,
  recheckMaximumAttempts: 2
} as const);
