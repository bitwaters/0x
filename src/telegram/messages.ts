import type { Chain } from '../config.js';
import type { SignalDisplayState } from '../db/repositories.js';
import type {
  ActivationReason,
  SendEligibilitySnapshot,
  TokenPresentationSnapshot
} from '../qualification/snapshot.js';
import { gmgnTokenPageUrl } from '../providers/sourcePolicy.js';
import type { TelegramMessageOptions } from './transport.js';

const TELEGRAM_TEXT_LIMIT = 4_096;

export interface RadarMessageSnapshot {
  readonly chain: Chain;
  readonly tokenAddress: string;
  readonly firstSeenAtMs: number;
  readonly marketCapUsd: number;
  readonly sampledMaxGain: number;
  readonly stage:
    | 'bonding'
    | 'real_pool'
    | 'heat_wait'
    | 'qualified'
    | 'expired'
    | 'rejected';
  readonly waitReason?: 'outside_public_range';
  readonly presentation?: TokenPresentationSnapshot;
}

export interface DeliveredSignalSnapshot {
  readonly eligibility: SendEligibilitySnapshot;
  readonly channelRole: 'validation' | 'formal';
  readonly sendRequestedAtMs: number;
  readonly preSendPriceUsd: number;
  readonly preSendTradeAtMs: number;
}

export interface TelegramCard {
  readonly text: string;
  readonly options: TelegramMessageOptions;
}

const CHAIN_DISPLAY: Readonly<Record<Chain, { readonly title: string; readonly button: string }>> = {
  sol: { title: '🟣 SOLANA', button: '🟣 GMGN · SOL' },
  bsc: { title: '🟡 BNB CHAIN', button: '🟡 GMGN · BSC' }
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function boundedText(value: unknown, fallback: string, maximumCodePoints: number): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  if (normalized === '') return fallback;
  const codePoints = [...normalized];
  const bounded =
    codePoints.length <= maximumCodePoints
      ? normalized
      : `${codePoints.slice(0, maximumCodePoints - 1).join('')}…`;
  return escapeHtml(bounded);
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function money(value: unknown, compact = true): string {
  const number = finite(value);
  if (number === undefined) return '—';
  const absolute = Math.abs(number);
  if (compact && absolute >= 1_000_000) return `$${(number / 1_000_000).toFixed(2)}M`;
  if (compact && absolute >= 1_000) return `$${(number / 1_000).toFixed(1)}K`;
  return `$${number.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function price(value: unknown): string {
  const number = finite(value);
  if (number === undefined || number <= 0) return '—';
  if (number < 0.000001) return `$${number.toExponential(4)}`;
  return `$${number.toLocaleString('en-US', { maximumSignificantDigits: 8 })}`;
}

function percent(value: unknown): string {
  const number = finite(value);
  return number === undefined ? '—' : `${(number * 100).toFixed(1)}%`;
}

function signedPercent(value: unknown): string {
  const number = finite(value);
  if (number === undefined) return '—';
  return `${number >= 0 ? '+' : ''}${(number * 100).toFixed(1)}%`;
}

function relativeAge(timestampMs: unknown, nowMs: number): string {
  const timestamp = finite(timestampMs);
  if (timestamp === undefined || timestamp > nowMs) return '—';
  const seconds = Math.floor((nowMs - timestamp) / 1_000);
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}小时前` : `${Math.floor(hours / 24)}天前`;
}

function duration(timestampMs: unknown, nowMs: number): string {
  const timestamp = finite(timestampMs);
  if (timestamp === undefined || timestamp > nowMs) return '—';
  const seconds = Math.floor((nowMs - timestamp) / 1_000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}小时` : `${Math.floor(hours / 24)}天`;
}

function activation(reason: ActivationReason | undefined): string {
  if (reason === 'DUAL_RANK') return '1m + 5m 双榜';
  if (reason === 'THREE_RISING_1M') return '连续三次 1m 上升';
  if (reason === 'RADAR_OPENED') return '雷达后真实池开放';
  return '历史快照未记录';
}

function identity(presentation: TokenPresentationSnapshot | undefined): string {
  const name = boundedText(presentation?.name, '未知代币', 40);
  const symbol = boundedText(presentation?.symbol, 'MEME', 16);
  return `🪙 <b>${name} ($${symbol})</b>`;
}

function securityRatio(
  security: Readonly<Record<string, number | boolean>>,
  key: string
): string {
  return percent(security[key]);
}

function securityBoolean(
  security: Readonly<Record<string, number | boolean>>,
  key: string,
  goodWhenTrue: boolean
): string {
  const value = security[key];
  if (typeof value !== 'boolean') return '—';
  return value === goodWhenTrue ? '✅ 正常' : '⚠️ 风险';
}

function riskLines(
  chain: Chain,
  security: Readonly<Record<string, number | boolean>>
): readonly string[] {
  const common = [
    `👥 Top10 ${securityRatio(security, 'top10Ratio')} · Insider ${securityRatio(security, 'insiderRatio')} · Bundler ${securityRatio(security, 'bundlerRatio')}`,
    `🧑‍💻 Dev ${securityRatio(security, 'devTeamRatio')} · Rug ${securityRatio(security, 'rugRatio')} · 刷量 ${securityBoolean(security, 'washTrading', false)}`
  ];
  if (chain === 'sol') {
    return [
      ...common,
      `🔐 Mint ${securityBoolean(security, 'renouncedMint', true)} · Freeze ${securityBoolean(security, 'renouncedFreezeAccount', true)}`
    ];
  }
  return [
    ...common,
    `🍯 蜜罐 ${securityBoolean(security, 'honeypot', false)} · 开源 ${securityBoolean(security, 'openSource', true)} · 权限 ${securityBoolean(security, 'ownerRenounced', true)}`,
    `🧾 买税 ${securityRatio(security, 'buyTaxRatio')} · 卖税 ${securityRatio(security, 'sellTaxRatio')}`
  ];
}

function stateDisplay(state: SignalDisplayState): string {
  if (state === 'ACTIVE') return '🟢 有效观察 · 90 秒';
  if (state === 'DONT_CHASE') return '🟠 波动超限 · 请勿追高';
  if (state === 'EXPIRED') return '⌛ 已过期';
  return '🔴 已失效';
}

const REASON_DISPLAY: Readonly<Record<string, string>> = {
  '90秒有效期结束': '90 秒观察期结束',
  PRE_SEND_DRIFT_REJECTED: '发送前价格波动超过允许范围',
  POOL_COMPOSITION_CHANGED: '固定池组成发生变化',
  FIXED_POOL_MISSING: '固定池已不可用',
  POOL_LIQUIDITY_LOW: '固定池流动性不足',
  POOL_LIQUIDITY_DECLINE: '固定池流动性快速下降',
  COUNTER_LIQUIDITY_INVALID: '对手侧深度无法确认',
  DEPTH_RATIO_HIGH: '$100 深度占比过高',
  TOP10_HIGH: 'Top10 持仓超限',
  INSIDER_HIGH: 'Insider 持仓超限',
  BUNDLER_HIGH: 'Bundler 持仓超限',
  DEV_TEAM_HIGH: '开发团队持仓超限',
  RUG_RISK_HIGH: 'Rug 风险超限',
  WASH_TRADING: '发现刷量风险',
  MINT_NOT_RENOUNCED: 'Mint 权限未放弃',
  FREEZE_NOT_RENOUNCED: 'Freeze 权限未放弃',
  HONEYPOT: '发现蜜罐风险',
  SOURCE_NOT_OPEN: '合约未开源',
  OWNER_NOT_RENOUNCED: 'Owner 权限未放弃',
  BUY_TAX_HIGH: '买税超限',
  SELL_TAX_HIGH: '卖税超限'
};

function userReason(reason: string): string {
  const mapped = REASON_DISPLAY[reason];
  if (mapped !== undefined) return mapped;
  if (reason.startsWith('数据不可确认:')) return '最新风险数据无法确认';
  if (reason === '价格绝对漂移超过8%') return '价格涨幅已超过追高边界';
  if (reason === '价格较发送价下跌超过15%') return '价格较信号价快速下跌';
  return '最新风险数据无法确认';
}

export function telegramCardOptions(
  chain: Chain,
  tokenAddress: string
): TelegramMessageOptions {
  return {
    parseMode: 'HTML',
    disableLinkPreview: true,
    button: {
      text: CHAIN_DISPLAY[chain].button,
      url: gmgnTokenPageUrl(chain, tokenAddress)
    }
  };
}

function ensureTelegramLength(text: string): string {
  if ([...text].length > TELEGRAM_TEXT_LIMIT) {
    throw new RangeError('Telegram card exceeds the 4096-character limit');
  }
  return text;
}

export function renderRadarMessage(snapshot: RadarMessageSnapshot): string {
  const display = snapshot.presentation;
  const marketCap = display?.marketCapUsd ?? snapshot.marketCapUsd;
  const stage = {
    bonding: '⚪ 非正式 · Bonding Curve 观察中',
    real_pool: '🔵 非正式 · 真实池验证中',
    heat_wait: snapshot.waitReason === 'outside_public_range'
      ? '🟠 非正式 · 当前不在公开观察区间，保留内部观察'
      : '🟠 非正式 · 热度暂时不足，保留内部观察',
    qualified: '✅ 已通过正式资格',
    expired: '⌛ 真实池验证已超时',
    rejected: '⛔ 已停止观察'
  }[snapshot.stage];
  const footer =
    snapshot.stage === 'qualified'
      ? '⚠️ 已转入独立的验证或正式信号流程，请以对应频道卡片为准。'
      : snapshot.stage === 'expired' || snapshot.stage === 'rejected'
        ? '⚠️ 本次雷达观察已结束，不构成买入建议。'
        : '⚠️ 仅为雷达观察，尚未通过真实固定池正式资格。';
  return ensureTelegramLength([
    `🔎 ${CHAIN_DISPLAY[snapshot.chain].title} · Meme 雷达`,
    stage,
    '',
    identity(display),
    '📋 <b>CA</b>',
    `<code>${escapeHtml(snapshot.tokenAddress)}</code>`,
    '',
    `💰 市值 ${money(marketCap)} · 1m 排名 ${display === undefined ? '—' : `#${display.rank}`}`,
    `🔥 激活 ${activation(display?.activationReason)}`,
    `📈 发现后最高 ${signedPercent(snapshot.sampledMaxGain)}`,
    `🕐 首次发现 ${new Date(snapshot.firstSeenAtMs).toISOString()} (UTC)`,
    '',
    footer
  ].join('\n'));
}

export function renderRadarCard(snapshot: RadarMessageSnapshot): TelegramCard {
  return {
    text: renderRadarMessage(snapshot),
    options: telegramCardOptions(snapshot.chain, snapshot.tokenAddress)
  };
}

export function renderSignalMessage(
  snapshot: DeliveredSignalSnapshot,
  state: SignalDisplayState = 'ACTIVE',
  reason?: string
): string {
  const value = snapshot.eligibility;
  const display = value.presentation;
  const title =
    snapshot.channelRole === 'formal'
      ? `🚨 ${CHAIN_DISPLAY[value.chain].title} · 低市值 Meme 机会`
      : `🧪 ${CHAIN_DISPLAY[value.chain].title} · 私有验证`;
  const lines = [
    title,
    stateDisplay(state),
    ...(reason === undefined ? [] : [`原因：${escapeHtml(userReason(reason))}`]),
    '',
    identity(display),
    '📋 <b>CA</b>',
    `<code>${escapeHtml(value.tokenAddress)}</code>`,
    '',
    '<b>💰 市场与动量</b>',
    `价格 ${price(snapshot.preSendPriceUsd)} · 市值 ${money(display?.marketCapUsd)}`,
    `固定池流动性 ${money(value.pool.reserveUsd)} · 池龄 ${duration(value.pool.poolCreatedAtMs, snapshot.sendRequestedAtMs)}`,
    `🔥 ${activation(display?.activationReason)} · 当前 1m ${display === undefined ? '—' : `#${display.rank}`}`,
    `📈 当前 ${signedPercent(display?.currentGain)} · 发现后最高 ${signedPercent(value.sampledMaxGain)}`,
    '',
    '<b>⚡ 30 秒成交</b>',
    `${value.trades.trades.length} 笔 · 成交额 ${money(value.trades.totalUsd)} · 买入笔数 ${percent(value.trades.buyCountRatio)}`,
    `买入金额 ${percent(value.trades.buyUsdRatio)} · 净买入 ${money(value.trades.netBuyUsd)}`,
    `💧 $100 深度占比 ${percent(value.liquidity.depthRatio)}`,
    '',
    '<b>🛡 风险</b>',
    ...riskLines(value.chain, value.security),
    '',
    '<b>🔗 固定池</b>',
    `<code>${escapeHtml(value.pool.poolAddress)}</code>`,
    `🕐 信号 ${new Date(snapshot.sendRequestedAtMs).toISOString()} (UTC) · 首次发现 ${relativeAge(value.firstSeenAtMs, snapshot.sendRequestedAtMs)} · 最新成交 ${relativeAge(snapshot.preSendTradeAtMs, snapshot.sendRequestedAtMs)}`,
    '',
    '⚠️ 低市值 Meme 波动极高；仅供人工核验，不构成收益承诺。'
  ];
  return ensureTelegramLength(lines.join('\n'));
}

export function renderSignalCard(
  snapshot: DeliveredSignalSnapshot,
  state: SignalDisplayState = 'ACTIVE',
  reason?: string
): TelegramCard {
  return {
    text: renderSignalMessage(snapshot, state, reason),
    options: telegramCardOptions(
      snapshot.eligibility.chain,
      snapshot.eligibility.tokenAddress
    )
  };
}

export function renderSignalEditCard(
  original: DeliveredSignalSnapshot,
  state: Exclude<SignalDisplayState, 'ACTIVE'>,
  reason: string
): TelegramCard {
  return renderSignalCard(original, state, reason);
}
