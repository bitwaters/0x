import type { Chain } from '../config.js';
import type { CoinGeckoPoolDetail } from '../providers/coingecko.js';
import type { LiquidityDecision, TradeWindowDecision } from './rules.js';

export type ActivationReason = 'DUAL_RANK' | 'THREE_RISING_1M' | 'RADAR_OPENED';

export function activationReasonFromCode(code: string | undefined): ActivationReason | undefined {
  if (code?.startsWith('DUAL_RANK_')) return 'DUAL_RANK';
  if (code?.startsWith('THREE_RISING_1M_')) return 'THREE_RISING_1M';
  if (code?.startsWith('RADAR_OPENED_')) return 'RADAR_OPENED';
  return undefined;
}

export interface TokenPresentationSnapshot {
  readonly name: string;
  readonly symbol: string;
  readonly marketCapUsd: number;
  readonly rank: number;
  readonly currentGain: number;
  readonly activationReason: ActivationReason;
}

export interface SendEligibilitySnapshot {
  readonly chain: Chain;
  readonly tokenAddress: string;
  readonly pool: CoinGeckoPoolDetail;
  readonly decisionPriceUsd: number;
  readonly decisionTradeAtMs: number;
  readonly firstSeenAtMs: number;
  readonly sampledMaxGain: number;
  readonly opportunityType: 'new_pool' | 'revival';
  readonly security: Readonly<Record<string, number | boolean>>;
  readonly trades: TradeWindowDecision;
  readonly liquidity: LiquidityDecision;
  readonly ruleVersion: string;
  readonly qualifiedAtMs: number;
  readonly validUntilMs: number;
  readonly presentation?: TokenPresentationSnapshot;
}
