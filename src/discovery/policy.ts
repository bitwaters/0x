export const DISCOVERY_POLICY = {
  snapshotMaxAgeMs: { '1m': 6_000, '5m': 15_000 },
  dualSnapshotMaxDifferenceMs: 12_000,
  risingSnapshotCount: 3,
  risingMaxGapMs: 6_000,
  radarRefreshMs: 10_000,
  trendingLimit: 100
} as const;
