import type { CoinGeckoOhlcvBar, CoinGeckoTrade } from '../providers/coingecko.js';

export type ThresholdOrder = 'NONE' | 'UP_FIRST' | 'DOWN_FIRST' | 'AMBIGUOUS';

export interface PathMetrics {
  readonly priceUsd: number;
  readonly grossReturn: number;
  readonly mfe: number;
  readonly mae: number;
  readonly path30_15: ThresholdOrder;
  readonly path2x_30: ThresholdOrder;
  readonly ambiguous: boolean;
}

interface PriceRange {
  readonly atMs: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

function uniqueTrades(trades: readonly CoinGeckoTrade[]): readonly CoinGeckoTrade[] {
  const byId = new Map<string, CoinGeckoTrade>();
  for (const trade of trades) {
    const previous = byId.get(trade.id);
    if (previous === undefined) {
      byId.set(trade.id, trade);
      continue;
    }
    if (
      previous.kind !== trade.kind ||
      previous.blockTimestampMs !== trade.blockTimestampMs ||
      previous.volumeUsd !== trade.volumeUsd ||
      previous.candidatePriceUsd !== trade.candidatePriceUsd ||
      previous.fromTokenAddress !== trade.fromTokenAddress ||
      previous.toTokenAddress !== trade.toTokenAddress
    ) {
      throw new Error(`conflicting CoinGecko trade id: ${trade.id}`);
    }
  }
  return [...byId.values()];
}

function thresholdOrder(
  ranges: readonly PriceRange[],
  entryPriceUsd: number,
  upRatio: number,
  downRatio: number
): ThresholdOrder {
  const upper = entryPriceUsd * upRatio;
  const lower = entryPriceUsd * downRatio;
  for (const range of ranges) {
    const hitUp = range.high >= upper;
    const hitDown = range.low <= lower;
    if (hitUp && hitDown) return 'AMBIGUOUS';
    if (hitUp) return 'UP_FIRST';
    if (hitDown) return 'DOWN_FIRST';
  }
  return 'NONE';
}

function metrics(ranges: readonly PriceRange[], entryPriceUsd: number): PathMetrics | undefined {
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0 || ranges.length === 0) {
    return undefined;
  }
  const high = Math.max(entryPriceUsd, ...ranges.map((range) => range.high));
  const low = Math.min(entryPriceUsd, ...ranges.map((range) => range.low));
  const priceUsd = ranges.at(-1)!.close;
  const path30_15 = thresholdOrder(ranges, entryPriceUsd, 1.3, 0.85);
  const path2x_30 = thresholdOrder(ranges, entryPriceUsd, 2, 0.7);
  return {
    priceUsd,
    grossReturn: priceUsd / entryPriceUsd - 1,
    mfe: high / entryPriceUsd - 1,
    mae: low / entryPriceUsd - 1,
    path30_15,
    path2x_30,
    ambiguous: path30_15 === 'AMBIGUOUS' || path2x_30 === 'AMBIGUOUS'
  };
}

export function selectEntryTrade(
  trades: readonly CoinGeckoTrade[],
  targetAtMs: number,
  maximumDelayMs: number
): CoinGeckoTrade | undefined {
  return uniqueTrades(trades)
    .filter(
      (trade) =>
        trade.blockTimestampMs >= targetAtMs &&
        trade.blockTimestampMs <= targetAtMs + maximumDelayMs
    )
    .sort((left, right) =>
      left.blockTimestampMs - right.blockTimestampMs || left.id.localeCompare(right.id)
    )
    .at(0);
}

export function isEntryWindowCovered(
  trades: readonly CoinGeckoTrade[],
  targetAtMs: number,
  pageSize: number
): boolean {
  if (trades.length < pageSize) return true;
  const earliestTradeAtMs = Math.min(
    ...uniqueTrades(trades).map((trade) => trade.blockTimestampMs)
  );
  return earliestTradeAtMs <= targetAtMs;
}

export function firstSellTradeAt(
  trades: readonly CoinGeckoTrade[],
  receiptAtMs: number,
  targetAtMs: number
): number | undefined {
  return uniqueTrades(trades)
    .filter(
      (trade) =>
        trade.kind === 'sell' &&
        trade.blockTimestampMs >= receiptAtMs &&
        trade.blockTimestampMs <= targetAtMs
    )
    .reduce<number | undefined>(
      (earliest, trade) =>
        earliest === undefined ? trade.blockTimestampMs : Math.min(earliest, trade.blockTimestampMs),
      undefined
    );
}

export function evaluateTradePath(
  trades: readonly CoinGeckoTrade[],
  entryPriceUsd: number,
  entryAtMs: number,
  targetAtMs: number
): PathMetrics | undefined {
  const grouped = new Map<number, CoinGeckoTrade[]>();
  for (const trade of uniqueTrades(trades)) {
    if (trade.blockTimestampMs < entryAtMs || trade.blockTimestampMs > targetAtMs) continue;
    const atTimestamp = grouped.get(trade.blockTimestampMs) ?? [];
    atTimestamp.push(trade);
    grouped.set(trade.blockTimestampMs, atTimestamp);
  }
  const ranges = [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([atMs, atTimestamp]) => ({
      atMs,
      high: Math.max(...atTimestamp.map((trade) => trade.candidatePriceUsd)),
      low: Math.min(...atTimestamp.map((trade) => trade.candidatePriceUsd)),
      close: atTimestamp.at(-1)!.candidatePriceUsd
    }));
  return metrics(ranges, entryPriceUsd);
}

export function evaluateOhlcvPath(
  bars: readonly CoinGeckoOhlcvBar[],
  entryPriceUsd: number,
  entryAtMs: number,
  targetAtMs: number,
  granularityMs: number
): PathMetrics | undefined {
  const ranges = bars
    .filter(
      (bar) =>
        bar.openAtMs >= entryAtMs &&
        bar.openAtMs + granularityMs <= targetAtMs
    )
    .sort((left, right) => left.openAtMs - right.openAtMs)
    .map((bar) => ({
      atMs: bar.openAtMs,
      high: bar.high,
      low: bar.low,
      close: bar.close
    }));
  return metrics(ranges, entryPriceUsd);
}

export function mergePathMetrics(prefix: PathMetrics, suffix: PathMetrics): PathMetrics {
  const path30_15 = prefix.path30_15 === 'NONE' ? suffix.path30_15 : prefix.path30_15;
  const path2x_30 = prefix.path2x_30 === 'NONE' ? suffix.path2x_30 : prefix.path2x_30;
  return {
    priceUsd: suffix.priceUsd,
    grossReturn: suffix.grossReturn,
    mfe: Math.max(prefix.mfe, suffix.mfe),
    mae: Math.min(prefix.mae, suffix.mae),
    path30_15,
    path2x_30,
    ambiguous: path30_15 === 'AMBIGUOUS' || path2x_30 === 'AMBIGUOUS'
  };
}
