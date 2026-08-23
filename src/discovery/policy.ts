export const DISCOVERY_POLICY = {
  internalMarketCapUsd: { min: 10_000, max: 300_000 },
  bondingRadarMarketCapUsd: { min: 10_000, max: 100_000 },
  realPoolMarketCapUsd: { min: 20_000, max: 300_000 },
  bondingShortcutRankMax: 5,
  realPoolRankMax: 20,
  publicRadar: {
    sol: {
      bondingRank: { min: 1, max: 5 },
      realPoolRank: { min: 1, max: 20 },
      bondingTriggers: ['DUAL_RANK', 'THREE_RISING_1M'],
      directRealPool: true,
      revivalPublic: true
    },
    bsc: {
      bondingRank: { min: 6, max: 10 },
      realPoolRank: { min: 6, max: 10 },
      bondingTriggers: ['DUAL_RANK', 'THREE_RISING_1M'],
      directRealPool: true,
      revivalPublic: false
    }
  },
  consecutiveDualSnapshotCount: 2,
  newPoolMaxAgeMs: 30 * 60_000,
  snapshotMaxAgeMs: { '1m': 6_000, '5m': 15_000 },
  dualSnapshotMaxDifferenceMs: 12_000,
  risingSnapshotCount: 3,
  risingMaxGapMs: 6_000,
  radarRefreshMs: 10_000,
  trendingLimit: 100
} as const;
