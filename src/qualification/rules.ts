import type { CoinGeckoPoolDetail, CoinGeckoTrade } from '../providers/coingecko.js';
import { QUALIFICATION_POLICY } from './policy.js';

export interface TradeWindowDecision {
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly trades: readonly CoinGeckoTrade[];
  readonly latestTradeAtMs: number | null;
  readonly decisionPriceUsd: number | null;
  readonly buyCountRatio: number;
  readonly totalUsd: number;
  readonly buyUsdRatio: number;
  readonly netBuyUsd: number;
  readonly largestTradeRatio: number;
}

export function evaluateTradeWindow(
  input: readonly CoinGeckoTrade[],
  nowMs: number
): TradeWindowDecision {
  const byId = new Map<string, CoinGeckoTrade>();
  let duplicateConflict = false;
  const windowTrades = input.filter(
    (trade) =>
      trade.blockTimestampMs <= nowMs &&
      trade.blockTimestampMs >= nowMs - QUALIFICATION_POLICY.tradeWindowMs
  );
  for (const trade of [...windowTrades].sort((a, b) => b.blockTimestampMs - a.blockTimestampMs)) {
    const existing = byId.get(trade.id);
    if (existing === undefined) {
      byId.set(trade.id, trade);
    } else if (!sameTradeFacts(existing, trade)) {
      duplicateConflict = true;
    }
  }
  const trades = [...byId.values()]
    .sort((a, b) => b.blockTimestampMs - a.blockTimestampMs)
    .slice(0, QUALIFICATION_POLICY.tradeMaxCount);
  const latest = trades[0];
  const totalUsd = trades.reduce((sum, trade) => sum + trade.volumeUsd, 0);
  const buyCount = trades.filter((trade) => trade.kind === 'buy').length;
  const buyUsd = trades
    .filter((trade) => trade.kind === 'buy')
    .reduce((sum, trade) => sum + trade.volumeUsd, 0);
  const sellUsd = totalUsd - buyUsd;
  const buyCountRatio = trades.length === 0 ? 0 : buyCount / trades.length;
  const buyUsdRatio = totalUsd === 0 ? 0 : buyUsd / totalUsd;
  const largestTradeRatio =
    totalUsd === 0 ? 1 : Math.max(0, ...trades.map((trade) => trade.volumeUsd)) / totalUsd;
  const reasons: string[] = [];
  if (duplicateConflict) reasons.push('TRADE_ID_CONFLICT');
  if (trades.length < QUALIFICATION_POLICY.tradeMinCount) reasons.push('TRADE_COUNT_LOW');
  if (totalUsd < QUALIFICATION_POLICY.tradeVolumeMinUsd) reasons.push('TRADE_VOLUME_LOW');
  if (
    latest === undefined ||
    nowMs - latest.blockTimestampMs > QUALIFICATION_POLICY.latestTradeMaxAgeMs
  ) {
    reasons.push('LATEST_TRADE_STALE');
  }
  if (buyCountRatio < QUALIFICATION_POLICY.buyCountMinRatio) {
    reasons.push('BUY_COUNT_RATIO_LOW');
  }
  if (buyUsdRatio < QUALIFICATION_POLICY.buyUsdMinRatio) {
    reasons.push('BUY_USD_RATIO_LOW');
  }
  if (largestTradeRatio > QUALIFICATION_POLICY.largestTradeMaxRatio) {
    reasons.push('LARGEST_TRADE_TOO_HIGH');
  }
  return {
    passed: reasons.length === 0,
    reasons,
    trades,
    latestTradeAtMs: latest?.blockTimestampMs ?? null,
    decisionPriceUsd: latest?.candidatePriceUsd ?? null,
    buyCountRatio,
    totalUsd,
    buyUsdRatio,
    netBuyUsd: buyUsd - sellUsd,
    largestTradeRatio
  };
}

function sameTradeFacts(left: CoinGeckoTrade, right: CoinGeckoTrade): boolean {
  return (
    left.kind === right.kind &&
    left.blockTimestampMs === right.blockTimestampMs &&
    left.volumeUsd === right.volumeUsd &&
    left.candidatePriceUsd === right.candidatePriceUsd &&
    left.fromTokenAddress === right.fromTokenAddress &&
    left.toTokenAddress === right.toTokenAddress &&
    left.fromTokenAmount === right.fromTokenAmount &&
    left.toTokenAmount === right.toTokenAmount
  );
}

export interface LiquiditySampleDecision {
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly counterSideLiquidityUsd: number;
  readonly depthRatio: number;
}

export function evaluateLiquiditySample(
  detail: CoinGeckoPoolDetail,
  liquidityMinUsd: number
): LiquiditySampleDecision {
  const counterSideLiquidityUsd =
    detail.candidateSide === 'base' ? detail.quoteLiquidityUsd : detail.baseLiquidityUsd;
  const depthRatio =
    counterSideLiquidityUsd > 0
      ? QUALIFICATION_POLICY.referenceBuyUsd / counterSideLiquidityUsd
      : Number.MAX_VALUE;
  const reasons: string[] = [];
  if (detail.reserveUsd < liquidityMinUsd) reasons.push('POOL_LIQUIDITY_LOW');
  if (counterSideLiquidityUsd <= 0) reasons.push('COUNTER_LIQUIDITY_INVALID');
  if (depthRatio > QUALIFICATION_POLICY.depthMaxRatio) reasons.push('DEPTH_RATIO_HIGH');
  return {
    passed: reasons.length === 0,
    reasons,
    counterSideLiquidityUsd,
    depthRatio
  };
}

export interface LiquidityDecision {
  readonly outcome: 'PASS' | 'WAIT' | 'REJECT';
  readonly reasons: readonly string[];
  readonly intervalMs: number;
  readonly reserveDeclineRatio: number;
  readonly counterSideLiquidityUsd: number;
  readonly depthRatio: number;
}

export function evaluateLiquidityStability(input: {
  readonly first: CoinGeckoPoolDetail;
  readonly second: CoinGeckoPoolDetail;
  readonly liquidityMinUsd: number;
}): LiquidityDecision {
  const { first, second } = input;
  if (
    first.chain !== second.chain ||
    first.poolAddress !== second.poolAddress ||
    first.candidateTokenAddress !== second.candidateTokenAddress ||
    first.candidateSide !== second.candidateSide ||
    first.counterTokenAddress !== second.counterTokenAddress
  ) {
    return rejectedLiquidity('POOL_COMPOSITION_CHANGED');
  }
  const intervalMs = second.fetchedAtMs - first.fetchedAtMs;
  if (intervalMs < 0) {
    return rejectedLiquidity('DETAIL_TIME_INVALID');
  }
  const firstSample = evaluateLiquiditySample(first, input.liquidityMinUsd);
  const secondSample = evaluateLiquiditySample(second, input.liquidityMinUsd);
  const secondCounter = secondSample.counterSideLiquidityUsd;
  const reserveDeclineRatio =
    first.reserveUsd > 0
      ? (first.reserveUsd - second.reserveUsd) / first.reserveUsd
      : Number.MAX_VALUE;
  const sampleReasons = [...new Set([...firstSample.reasons, ...secondSample.reasons])];
  if (sampleReasons.length > 0) {
    return {
      outcome: 'WAIT',
      reasons: sampleReasons,
      intervalMs,
      reserveDeclineRatio,
      counterSideLiquidityUsd: secondCounter,
      depthRatio: secondSample.depthRatio
    };
  }
  if (intervalMs < QUALIFICATION_POLICY.detailMinIntervalMs) {
    return {
      outcome: 'WAIT',
      reasons: ['DETAIL_INTERVAL_SHORT'],
      intervalMs,
      reserveDeclineRatio,
      counterSideLiquidityUsd: secondCounter,
      depthRatio: secondSample.depthRatio
    };
  }
  const reasons: string[] = [];
  if (reserveDeclineRatio > QUALIFICATION_POLICY.liquidityMaxDeclineRatio) {
    reasons.push('POOL_LIQUIDITY_DECLINE');
  }
  return {
    outcome: reasons.length === 0 ? 'PASS' : 'WAIT',
    reasons,
    intervalMs,
    reserveDeclineRatio,
    counterSideLiquidityUsd: secondCounter,
    depthRatio: secondSample.depthRatio
  };
}

function rejectedLiquidity(reason: string): LiquidityDecision {
  return {
    outcome: 'REJECT',
    reasons: [reason],
    intervalMs: 0,
    reserveDeclineRatio: Number.MAX_VALUE,
    counterSideLiquidityUsd: 0,
    depthRatio: Number.MAX_VALUE
  };
}
