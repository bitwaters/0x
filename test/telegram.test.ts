import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import {
  CandidateRepository,
  OutboxRepository,
  PoolBindingRepository,
  RuleVersionRepository,
  SignalFollowupRepository,
  SignalRecheckRepository
} from '../src/db/repositories.js';
import type { SendEligibilitySnapshot } from '../src/qualification/snapshot.js';
import { evaluateLiquidityStability, evaluateTradeWindow } from '../src/qualification/rules.js';
import type { CoinGeckoPoolDetail, CoinGeckoTrade } from '../src/providers/coingecko.js';
import type { GmgnTokenSecurity, GmgnTrendingSnapshot } from '../src/providers/gmgn.js';
import { ProviderRequestError } from '../src/providers/http.js';
import { EvaluationRepository } from '../src/evaluation/repository.js';
import { TelegramDeliveryService } from '../src/telegram/service.js';
import {
  renderRadarCard,
  renderSignalCard,
  renderSignalEditCard,
  telegramCardOptions,
  type DeliveredSignalSnapshot
} from '../src/telegram/messages.js';
import {
  TelegramExplicitError,
  TelegramTransport,
  TelegramUnknownResultError,
  type TelegramMessageOptions,
  type TelegramReceipt,
  type TelegramTransportLike
} from '../src/telegram/transport.js';

const TOKEN = '0xabcdef0000000000000000000000000000000001';
const POOL = '0xabcdef0000000000000000000000000000000002';
const COUNTER = '0xabcdef0000000000000000000000000000000003';

function pool(atMs: number, reserveUsd = 12_000): CoinGeckoPoolDetail {
  return Object.freeze({
    chain: 'bsc',
    network: 'bsc',
    poolAddress: POOL,
    candidateTokenAddress: TOKEN,
    candidateSide: 'base',
    counterTokenAddress: COUNTER,
    baseTokenAddress: TOKEN,
    quoteTokenAddress: COUNTER,
    reserveUsd,
    baseLiquidityUsd: 6_000,
    quoteLiquidityUsd: 6_000,
    poolCreatedAtMs: atMs - 60_000,
    fetchedAtMs: atMs,
    raw: { reserve_in_usd: String(reserveUsd) }
  });
}

function trade(
  id: string,
  kind: 'buy' | 'sell',
  volumeUsd: number,
  priceUsd: number,
  atMs: number
): CoinGeckoTrade {
  return {
    id,
    kind,
    blockTimestampMs: atMs,
    volumeUsd: volumeUsd * 5,
    candidatePriceUsd: priceUsd,
    fromTokenAddress: kind === 'buy' ? COUNTER : TOKEN,
    toTokenAddress: kind === 'buy' ? TOKEN : COUNTER,
    fromTokenAmount: 1,
    toTokenAmount: 1,
    raw: { id, kind, volumeUsd: volumeUsd * 5, priceUsd }
  };
}

function trades(nowMs: number, priceUsd: number): readonly CoinGeckoTrade[] {
  return [
    trade('a', 'buy', 40, priceUsd, nowMs),
    trade('b', 'buy', 20, priceUsd, nowMs - 1_000),
    trade('c', 'buy', 20, priceUsd, nowMs - 2_000),
    trade('d', 'sell', 10, priceUsd, nowMs - 3_000),
    trade('e', 'sell', 10, priceUsd, nowMs - 4_000)
  ];
}

function gmgn(nowMs: number, top10 = '0.20') {
  const trending: GmgnTrendingSnapshot = {
    chain: 'bsc',
    interval: '1m',
    fetchedAtMs: nowMs,
    filters: ['not_honeypot', 'verified', 'renounced'],
    items: [{
      chain: 'bsc',
      tokenAddress: TOKEN,
      name: 'Test Meme',
      symbol: 'TME',
      rank: 1,
      priceUsd: 100,
      marketCapUsd: 100_000,
      liquidityUsd: 15_000,
      openAtMs: nowMs - 60_000,
      createdAtMs: nowMs - 120_000,
      raw: {
        dev_team_hold_rate: 0.1,
        rug_ratio: 0.1,
        is_wash_trading: false,
        rat_trader_amount_rate: 0.1,
        bundler_rate: 0.1
      }
    }]
  };
  const security: GmgnTokenSecurity = {
    chain: 'bsc',
    tokenAddress: TOKEN,
    fetchedAtMs: nowMs,
    raw: {
      top_10_holder_rate: top10,
      is_honeypot: false,
      is_open_source: true,
      is_renounced: true,
      buy_tax: '0.01',
      sell_tax: '0.01'
    }
  };
  return { trending, security };
}

function setup(now: { value: number }) {
  const database = openDatabase(':memory:');
  const config = parseConfig({
    NODE_ENV: 'test',
    GMGN_API_KEY: 'gmgn-test',
    COINGECKO_PRO_API_KEY: 'cg-test',
    TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: 'telegram-test',
    TELEGRAM_RADAR_CHAT_ID: '-1001',
    TELEGRAM_VALIDATION_CHAT_ID: '-1002',
    TELEGRAM_FORMAL_CHAT_ID: '-1003'
  });
  new RuleVersionRepository(database).save(config.ruleVersion, {
    thresholds: config.thresholds,
    discoveryPolicy: config.discoveryPolicy,
    sourcePolicy: config.sourcePolicy,
    qualificationPolicy: config.qualificationPolicy,
    telegramDeliveryPolicy: config.telegramDeliveryPolicy
  });
  const candidates = new CandidateRepository(database);
  candidates.findOrCreate({
    chain: 'bsc',
    tokenAddress: TOKEN,
    firstSeenAtMs: now.value - 20_000,
    firstSeenPriceUsd: 50,
    firstSeenRank: 5,
    firstSeenMarketCapUsd: 80_000,
    firstSeenLiquidityUsd: 12_000,
    discoveryRuleVersion: config.ruleVersion
  });
  candidates.activate({
    chain: 'bsc',
    tokenAddress: TOKEN,
    opportunityType: 'new_pool',
    priceUsd: 100,
    ruleVersion: config.ruleVersion,
    atMs: now.value - 12_000
  });
  candidates.transition('bsc', TOKEN, 'PREHEAT', { atMs: now.value - 11_000 });
  const bindings = new PoolBindingRepository(database);
  bindings.bind({
    chain: 'bsc',
    tokenAddress: TOKEN,
    poolAddress: POOL,
    candidateSide: 'base',
    counterTokenAddress: COUNTER,
    boundAtMs: now.value - 10_000
  });
  bindings.setQualificationReference({
    chain: 'bsc', tokenAddress: TOKEN, priceUsd: 100, atMs: now.value
  });
  candidates.setDecisionRuleVersion('bsc', TOKEN, config.ruleVersion, now.value);
  candidates.transition('bsc', TOKEN, 'MONITORING', { atMs: now.value });
  const first = pool(now.value - 10_000);
  const second = pool(now.value);
  const eligibility: SendEligibilitySnapshot = {
    chain: 'bsc',
    tokenAddress: TOKEN,
    pool: second,
    decisionPriceUsd: 100,
    decisionTradeAtMs: now.value,
    firstSeenAtMs: now.value - 20_000,
    sampledMaxGain: 0.5,
    opportunityType: 'new_pool',
    security: {
      top10Ratio: 0.2,
      insiderRatio: 0.1,
      bundlerRatio: 0.08,
      devTeamRatio: 0.05,
      rugRatio: 0.1,
      washTrading: false,
      honeypot: false,
      openSource: true,
      ownerRenounced: true,
      buyTaxRatio: 0.01,
      sellTaxRatio: 0.01
    },
    trades: evaluateTradeWindow(trades(now.value, 100), now.value),
    liquidity: evaluateLiquidityStability({ first, second, liquidityMinUsd: 10_000 }),
    ruleVersion: config.ruleVersion,
    qualifiedAtMs: now.value,
    validUntilMs: now.value + 15_000,
    presentation: {
      name: 'Test Meme',
      symbol: 'TME',
      marketCapUsd: 100_000,
      rank: 1,
      currentGain: 1,
      activationReason: 'DUAL_RANK'
    }
  };
  return { database, config, candidates, eligibility };
}

class FakeTelegram implements TelegramTransportLike {
  readonly sends: Array<{ chatId: string; text: string; options?: TelegramMessageOptions }> = [];
  readonly edits: Array<{ chatId: string; messageId: string; text: string; options?: TelegramMessageOptions }> = [];
  sendErrors: unknown[] = [];
  editErrors: unknown[] = [];

  async sendMessage(
    chatId: string,
    text: string,
    _signal?: AbortSignal,
    options?: TelegramMessageOptions
  ): Promise<TelegramReceipt> {
    this.sends.push({ chatId, text, ...(options === undefined ? {} : { options }) });
    const error = this.sendErrors.shift();
    if (error !== undefined) throw error;
    return { messageId: String(100 + this.sends.length) };
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    _signal?: AbortSignal,
    options?: TelegramMessageOptions
  ): Promise<void> {
    this.edits.push({
      chatId,
      messageId,
      text,
      ...(options === undefined ? {} : { options })
    });
    const error = this.editErrors.shift();
    if (error !== undefined) throw error;
  }
}

test('Telegram transport parses confirmed success and classifies explicit versus unknown results', async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const success = new TelegramTransport(
    'bot-secret',
    (async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch
  );
  assert.deepEqual(await success.sendMessage('-1002', 'hello'), { messageId: '42' });
  assert.match(requests[0]!.url, /\/sendMessage$/);
  assert.deepEqual(requests[0]!.body, { chat_id: '-1002', text: 'hello' });
  const options = telegramCardOptions('bsc', TOKEN);
  await success.sendMessage('-1002', 'card', undefined, options);
  await success.editMessage('-1002', '42', 'edited', undefined, options);
  assert.deepEqual(requests[1]!.body, {
    chat_id: '-1002',
    text: 'card',
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [[{
        text: '🟡 GMGN · BSC',
        url: `https://gmgn.ai/bsc/token/${TOKEN}`
      }]]
    }
  });
  assert.deepEqual(requests[2]!.body, {
    chat_id: '-1002',
    message_id: '42',
    text: 'edited',
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [[{
        text: '🟡 GMGN · BSC',
        url: `https://gmgn.ai/bsc/token/${TOKEN}`
      }]]
    }
  });

  const explicit = new TelegramTransport(
    'bot-secret',
    (async () =>
      new Response(JSON.stringify({ ok: false, error_code: 400, description: 'bad' }), {
        status: 400
      })) as typeof fetch
  );
  await assert.rejects(() => explicit.sendMessage('-1', 'x'), TelegramExplicitError);
  const unknown = new TelegramTransport(
    'bot-secret',
    (async () => new Response('not-json', { status: 200 })) as typeof fetch
  );
  await assert.rejects(() => unknown.sendMessage('-1', 'x'), TelegramUnknownResultError);
  const unknownGatewayFailure = new TelegramTransport(
    'bot-secret',
    (async () => new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch
  );
  await assert.rejects(
    () => unknownGatewayFailure.sendMessage('-1', 'x'),
    TelegramUnknownResultError
  );
  const unknownJsonGatewayFailure = new TelegramTransport(
    'bot-secret',
    (async () =>
      new Response(JSON.stringify({ error: 'bad gateway' }), { status: 502 })) as typeof fetch
  );
  await assert.rejects(
    () => unknownJsonGatewayFailure.sendMessage('-1', 'x'),
    TelegramUnknownResultError
  );
});

function service(input: {
  now: { value: number };
  setup: ReturnType<typeof setup>;
  config?: ReturnType<typeof parseConfig>;
  telegram: TelegramTransportLike;
  price: { value: number };
  trades?: () => readonly CoinGeckoTrade[];
  security?: () => Promise<GmgnTokenSecurity>;
  trending?: () => Promise<GmgnTrendingSnapshot>;
  reserve?: { value: number };
  detail?: () => Promise<CoinGeckoPoolDetail>;
  retain?: (chain: 'sol' | 'bsc', token: string, poolAddress: string) => void;
  release?: (chain: 'sol' | 'bsc', token: string) => void;
}) {
  return new TelegramDeliveryService(
    input.setup.database,
    input.config ?? input.setup.config,
    {
      async getPoolDetail() {
        return input.detail?.() ?? pool(input.now.value, input.reserve?.value ?? 12_000);
      },
      async getPoolTrades() {
        return input.trades?.() ?? trades(input.now.value, input.price.value);
      }
    },
    {
      async getTokenSecurity() {
        return input.security?.() ?? gmgn(input.now.value).security;
      },
      async getTrending() {
        return input.trending?.() ?? gmgn(input.now.value).trending;
      }
    },
    input.telegram,
    () => input.now.value,
    input.retain,
    input.release
  );
}

test('routes radar only to the radar channel and labels it non-formal', async () => {
  const now = { value: 9_500_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  const delivery = service({ now, setup: state, telegram, price: { value: 100 } });
  const result = await delivery.sendRadar({
    chain: 'bsc',
    tokenAddress: TOKEN,
    firstSeenAtMs: now.value - 20_000,
    marketCapUsd: 80_000,
    sampledMaxGain: 0.5,
    stage: 'real_pool'
  });
  assert.equal(result.outcome, 'SENT');
  assert.equal(telegram.sends[0]!.chatId, '-1001');
  assert.match(telegram.sends[0]!.text, /非正式/);
  assert.deepEqual(telegram.sends[0]!.options, telegramCardOptions('bsc', TOKEN));
  state.database.close();
});

test('radar edits one message only for semantic changes and retries a failed edit finitely', async () => {
  const now = { value: 9_600_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  const delivery = service({ now, setup: state, telegram, price: { value: 100 } });
  const bonding = {
    chain: 'bsc' as const,
    tokenAddress: TOKEN,
    firstSeenAtMs: now.value - 20_000,
    marketCapUsd: 80_000,
    sampledMaxGain: 0.5,
    stage: 'bonding' as const
  };

  assert.equal((await delivery.sendRadar(bonding)).outcome, 'SENT');
  assert.equal((await delivery.sendRadar(bonding)).outcome, 'DUPLICATE');
  assert.equal(telegram.sends.length, 1);
  assert.equal(telegram.edits.length, 0);

  telegram.editErrors.push(new Error('temporary edit failure'));
  const upgraded = { ...bonding, stage: 'real_pool' as const };
  assert.equal((await delivery.sendRadar(upgraded)).outcome, 'RETRYABLE_FAILURE');
  assert.equal((await delivery.sendRadar(upgraded)).outcome, 'SENT');
  assert.equal(telegram.sends.length, 1);
  assert.equal(telegram.edits.length, 2);
  assert.equal(telegram.edits[1]!.messageId, telegram.edits[0]!.messageId);
  assert.match(telegram.edits[1]!.text, /真实池验证中/);
  assert.equal((await delivery.sendRadar(upgraded)).outcome, 'DUPLICATE');
  assert.equal(telegram.edits.length, 2);

  telegram.editErrors.push(new Error('one'), new Error('two'), new Error('three'));
  const waiting = { ...bonding, stage: 'heat_wait' as const };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await delivery.sendRadar(waiting)).outcome, 'RETRYABLE_FAILURE');
  }
  assert.equal((await delivery.sendRadar(waiting)).outcome, 'RETRYABLE_FAILURE');
  assert.equal(telegram.edits.length, 5);
  state.database.close();
});

test('renders fused SOL/BSC cards safely with front-loaded CA and one preserved GMGN button', () => {
  const now = { value: 9_750_000 };
  const state = setup(now);
  const bscSnapshot: DeliveredSignalSnapshot = {
    eligibility: state.eligibility,
    channelRole: 'formal',
    sendRequestedAtMs: now.value,
    preSendPriceUsd: 0.000123,
    preSendTradeAtMs: now.value - 2_000
  };
  const bsc = renderSignalCard(bscSnapshot);
  assert.match(bsc.text, /^🚨 🟡 BNB CHAIN · 低市值 Meme 机会/);
  assert.match(bsc.text, new RegExp(`<code>${TOKEN}</code>`));
  assert.match(bsc.text, /Test Meme \(\$TME\)/);
  assert.match(bsc.text, /1m \+ 5m 双榜/);
  assert.match(bsc.text, /固定池流动性/);
  assert.match(bsc.text, /Top10/);
  assert.doesNotMatch(bsc.text, /candidateSide|规则版本|rules-|GMGN \+ CoinGecko|\{"/);
  assert.deepEqual(bsc.options, telegramCardOptions('bsc', TOKEN));

  const solToken = 'So11111111111111111111111111111111111111112';
  const solPool = '11111111111111111111111111111111';
  const maliciousName = `<script>${'超'.repeat(80)}&`;
  const solEligibility: SendEligibilitySnapshot = {
    ...state.eligibility,
    chain: 'sol',
    tokenAddress: solToken,
    pool: {
      ...state.eligibility.pool,
      chain: 'sol',
      network: 'solana',
      poolAddress: solPool,
      candidateTokenAddress: solToken,
      counterTokenAddress: 'So11111111111111111111111111111111111111111',
      baseTokenAddress: solToken,
      quoteTokenAddress: 'So11111111111111111111111111111111111111111'
    },
    security: {
      top10Ratio: 0.2,
      insiderRatio: 0.1,
      bundlerRatio: 0.08,
      devTeamRatio: 0.05,
      rugRatio: 0.1,
      washTrading: false,
      renouncedMint: true,
      renouncedFreezeAccount: true
    },
    presentation: {
      name: maliciousName,
      symbol: '<SOL&MEME>',
      marketCapUsd: 88_000,
      rank: 7,
      currentGain: 0.25,
      activationReason: 'THREE_RISING_1M'
    }
  };
  const solSnapshot: DeliveredSignalSnapshot = {
    ...bscSnapshot,
    eligibility: solEligibility
  };
  const sol = renderSignalCard(solSnapshot);
  assert.match(sol.text, /^🚨 🟣 SOLANA · 低市值 Meme 机会/);
  assert.match(sol.text, new RegExp(`<code>${solToken}</code>`));
  assert.match(sol.text, /&lt;script&gt;/);
  assert.doesNotMatch(sol.text, /<script>/);
  assert.match(sol.text, /Mint/);
  assert.doesNotMatch(sol.text, /蜜罐/);
  assert.ok([...sol.text].length < 4_096);
  assert.deepEqual(sol.options, {
    parseMode: 'HTML',
    disableLinkPreview: true,
    button: {
      text: '🟣 GMGN · SOL',
      url: `https://gmgn.ai/sol/token/${solToken}`
    }
  });

  const edited = renderSignalEditCard(solSnapshot, 'INVALID', 'TOP10_HIGH');
  assert.match(edited.text, /^🚨 🟣 SOLANA · 低市值 Meme 机会\n🔴 已失效\n原因：Top10 持仓超限/);
  assert.deepEqual(edited.options, sol.options);

  const { presentation: legacyPresentation, ...legacyEligibility } = state.eligibility;
  assert.ok(legacyPresentation);
  const legacy = renderSignalCard({ ...bscSnapshot, eligibility: legacyEligibility });
  assert.match(legacy.text, /未知代币/);
  assert.ok([...legacy.text].length < 4_096);

  const radar = renderRadarCard({
    chain: 'sol',
    tokenAddress: solToken,
    firstSeenAtMs: now.value - 30_000,
    marketCapUsd: 88_000,
    sampledMaxGain: 0.5,
    stage: 'bonding',
    presentation: solEligibility.presentation!
  });
  assert.match(radar.text, /Bonding Curve 观察中/);
  assert.match(radar.text, new RegExp(`<code>${solToken}</code>`));
  assert.deepEqual(radar.options, sol.options);
  state.database.close();
});

test('routes one confirmed signal to validation and persists receipt plus followups atomically', async () => {
  const now = { value: 10_000_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  const price = { value: 108 };
  const delivery = service({ now, setup: state, telegram, price });
  assert.equal((await delivery.sendSignal(state.eligibility, 'formal')).outcome, 'SUPPRESSED');
  assert.equal(telegram.sends.length, 0);
  assert.equal((await delivery.sendSignal(state.eligibility, 'validation')).outcome, 'SENT');
  assert.equal(telegram.sends[0]!.chatId, '-1002');
  assert.match(telegram.sends[0]!.text, /\$100 深度占比/);
  assert.match(telegram.sends[0]!.text, /不构成收益承诺/);
  const outbox = new OutboxRepository(state.database).find('bsc', TOKEN, 'signal')!;
  assert.equal(outbox.status, 'SENT');
  assert.equal(outbox.receiptAtMs, now.value);
  const sample = new EvaluationRepository(state.database).findSampleByOutbox(outbox.id)!;
  assert.equal(sample.deliveryStage, 'validation');
  assert.equal(sample.receiptAtMs, now.value);
  assert.equal(sample.preSendPriceUsd, 108);
  assert.equal(sample.validationEpoch, 1);
  assert.equal(sample.validationSeq, 1);
  assert.equal(new SignalRecheckRepository(state.database).listDue(now.value + 30_000).length, 1);
  assert.equal(state.candidates.find('bsc', TOKEN)!.status, 'SIGNAL_SENT');
  assert.equal((await delivery.sendSignal(state.eligibility, 'formal')).outcome, 'DUPLICATE');
  assert.equal(telegram.sends.length, 1);
  state.database.close();
});

test('a confirmed validation send remains auditable if Beta is reached in flight', async () => {
  const now = { value: 10_500_000 };
  const state = setup(now);
  const telegram: TelegramTransportLike = {
    async sendMessage() {
      state.database
        .prepare("UPDATE chain_release_state SET state = 'BETA' WHERE chain = 'bsc'")
        .run();
      return { messageId: '501' };
    },
    async editMessage() {}
  };
  const delivery = service({ now, setup: state, telegram, price: { value: 100 } });
  assert.equal((await delivery.sendSignal(state.eligibility, 'validation')).outcome, 'SENT');
  const outbox = new OutboxRepository(state.database).find('bsc', TOKEN, 'signal')!;
  const sample = new EvaluationRepository(state.database).findSampleByOutbox(outbox.id)!;
  assert.equal(sample.deliveryStage, 'validation');
  assert.equal(sample.validationEpoch, 1);
  assert.equal(sample.validationSeq, 1);
  state.database.close();
});

test('suppresses a new outbox only when pre-send drift is strictly above eight percent', async () => {
  for (const [priceValue, outcome, hasOutbox] of [
    [108, 'SENT', true],
    [108.01, 'SUPPRESSED', false]
  ] as const) {
    const now = { value: 11_000_000 };
    const state = setup(now);
    const telegram = new FakeTelegram();
    const delivery = service({ now, setup: state, telegram, price: { value: priceValue } });
    assert.equal((await delivery.sendSignal(state.eligibility, 'validation')).outcome, outcome);
    assert.equal(
      new OutboxRepository(state.database).find('bsc', TOKEN, 'signal') !== undefined,
      hasOutbox
    );
    state.database.close();
  }
});

test('does not send an eligibility snapshot after its qualification window closes', async () => {
  const now = { value: 11_500_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  now.value += 110_000;
  const delivery = service({
    now,
    setup: state,
    telegram,
    price: { value: 100 }
  });
  assert.equal((await delivery.sendSignal(state.eligibility, 'validation')).outcome, 'SUPPRESSED');
  assert.equal(telegram.sends.length, 0);
  assert.equal(new OutboxRepository(state.database).find('bsc', TOKEN, 'signal'), undefined);
  state.database.close();
});

test('a pending candidate must be fully requalified under the current rule version', async () => {
  const now = { value: 11_750_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  const changedConfig = parseConfig({
    NODE_ENV: 'test',
    GMGN_API_KEY: 'gmgn-test',
    COINGECKO_PRO_API_KEY: 'cg-test',
    TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: 'telegram-test',
    TELEGRAM_RADAR_CHAT_ID: '-1001',
    TELEGRAM_VALIDATION_CHAT_ID: '-1002',
    TELEGRAM_FORMAL_CHAT_ID: '-1003',
    TOP10_MAX_RATIO: '0.24'
  });
  new RuleVersionRepository(state.database).save(changedConfig.ruleVersion, {
    thresholds: changedConfig.thresholds,
    discoveryPolicy: changedConfig.discoveryPolicy,
    sourcePolicy: changedConfig.sourcePolicy,
    qualificationPolicy: changedConfig.qualificationPolicy,
    telegramDeliveryPolicy: changedConfig.telegramDeliveryPolicy
  });
  const delivery = service({
    now,
    setup: state,
    config: changedConfig,
    telegram,
    price: { value: 100 }
  });
  assert.equal(
    (await delivery.sendSignal(state.eligibility, 'validation')).outcome,
    'SUPPRESSED'
  );
  assert.equal(telegram.sends.length, 0);
  state.candidates.setDecisionRuleVersion('bsc', TOKEN, changedConfig.ruleVersion, now.value);
  assert.equal(
    (
      await delivery.sendSignal(
        { ...state.eligibility, ruleVersion: changedConfig.ruleVersion },
        'validation'
      )
    ).outcome,
    'SENT'
  );
  assert.equal(telegram.sends.length, 1);
  state.database.close();
});

test('retries explicit send failures but quarantines an unknown result', async () => {
  const now = { value: 12_000_000 };
  const retryState = setup(now);
  const retryTelegram = new FakeTelegram();
  retryTelegram.sendErrors.push(new TelegramExplicitError(400, 400, 'bad request'));
  const retryDelivery = service({
    now,
    setup: retryState,
    telegram: retryTelegram,
    price: { value: 100 }
  });
  assert.equal((await retryDelivery.sendSignal(retryState.eligibility, 'validation')).outcome, 'RETRYABLE_FAILURE');
  assert.equal((await retryDelivery.sendSignal(retryState.eligibility, 'validation')).outcome, 'SENT');
  assert.equal(retryTelegram.sends.length, 2);
  retryState.database.close();

  const unknownState = setup(now);
  const unknownTelegram = new FakeTelegram();
  unknownTelegram.sendErrors.push(new TelegramUnknownResultError('timeout'));
  const unknownDelivery = service({
    now,
    setup: unknownState,
    telegram: unknownTelegram,
    price: { value: 100 }
  });
  assert.equal((await unknownDelivery.sendSignal(unknownState.eligibility, 'validation')).outcome, 'UNCERTAIN');
  assert.equal((await unknownDelivery.sendSignal(unknownState.eligibility, 'validation')).outcome, 'DUPLICATE');
  assert.equal(unknownTelegram.sends.length, 1);
  unknownState.database.close();
});

test('a JSON gateway failure is uncertain and cannot resend the signal', async () => {
  const now = { value: 12_500_000 };
  const state = setup(now);
  let requests = 0;
  const transport = new TelegramTransport(
    'bot-secret',
    (async () => {
      requests += 1;
      return new Response(JSON.stringify({ error: 'bad gateway' }), { status: 502 });
    }) as typeof fetch
  );
  const delivery = service({
    now,
    setup: state,
    telegram: transport,
    price: { value: 100 }
  });
  assert.equal(
    (await delivery.sendSignal(state.eligibility, 'validation')).outcome,
    'UNCERTAIN'
  );
  assert.equal(
    (await delivery.sendSignal(state.eligibility, 'validation')).outcome,
    'DUPLICATE'
  );
  assert.equal(requests, 1);
  assert.equal(
    new OutboxRepository(state.database).find('bsc', TOKEN, 'signal')!.status,
    'UNCERTAIN'
  );
  assert.equal(
    new EvaluationRepository(state.database).findSampleByOutbox(
      new OutboxRepository(state.database).find('bsc', TOKEN, 'signal')!.id
    ),
    undefined
  );
  state.database.close();
});

test('an explicitly failed validation outbox moves to formal when the chain reaches Beta', async () => {
  const now = { value: 12_750_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  telegram.sendErrors.push(new TelegramExplicitError(400, 400, 'known rejection'));
  const delivery = service({
    now,
    setup: state,
    telegram,
    price: { value: 100 }
  });
  assert.equal(
    (await delivery.sendSignal(state.eligibility, 'validation')).outcome,
    'RETRYABLE_FAILURE'
  );
  state.database
    .prepare("UPDATE chain_release_state SET state = 'BETA' WHERE chain = 'bsc'")
    .run();
  assert.equal((await delivery.sendSignal(state.eligibility, 'formal')).outcome, 'SENT');
  assert.deepEqual(telegram.sends.map((send) => send.chatId), ['-1002', '-1003']);
  const outbox = new OutboxRepository(state.database).find('bsc', TOKEN, 'signal')!;
  assert.equal(outbox.channelRole, 'formal');
  const sample = new EvaluationRepository(state.database).findSampleByOutbox(outbox.id)!;
  assert.equal(sample.deliveryStage, 'formal');
  assert.equal(sample.validationEpoch, null);
  assert.equal(sample.validationSeq, null);
  state.database.close();
});

test('post-send price edits use strict 8/15 percent boundaries and exact 90-second expiry', async () => {
  const now = { value: 13_000_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  const price = { value: 100 };
  state.database
    .prepare("UPDATE chain_release_state SET state = 'BETA' WHERE chain = 'bsc'")
    .run();
  const delivery = service({ now, setup: state, telegram, price });
  await delivery.sendSignal(state.eligibility, 'formal');
  assert.equal(telegram.sends[0]!.chatId, '-1003');
  assert.match(telegram.sends[0]!.text, /低市值 Meme 机会/);
  price.value = 108;
  await delivery.refreshPrice('bsc', TOKEN);
  assert.equal(telegram.edits.length, 0);
  price.value = 108.01;
  await delivery.refreshPrice('bsc', TOKEN);
  assert.match(telegram.edits.at(-1)!.text, /勿追/);
  price.value = 115;
  await delivery.refreshPrice('bsc', TOKEN);
  assert.equal(telegram.edits.length, 1);
  price.value = 115.01;
  await delivery.refreshPrice('bsc', TOKEN);
  assert.match(telegram.edits.at(-1)!.text, /已过期/);
  assert.doesNotMatch(telegram.edits.at(-1)!.text, /当前状态: 90秒有效观察期/);

  const expiryNow = { value: 14_000_000 };
  const expiryState = setup(expiryNow);
  const expiryTelegram = new FakeTelegram();
  const expiry = service({
    now: expiryNow,
    setup: expiryState,
    telegram: expiryTelegram,
    price: { value: 100 }
  });
  await expiry.sendSignal(expiryState.eligibility, 'validation');
  expiryNow.value += 90_000;
  await expiry.tick();
  assert.match(expiryTelegram.edits.at(-1)!.text, /90 秒观察期结束/);
  assert.doesNotMatch(expiryTelegram.edits.at(-1)!.text, /当前状态: 90秒有效观察期/);
  state.database.close();
  expiryState.database.close();
});

test('post-send sell pressure can expire a signal without passing entry momentum', async () => {
  const now = { value: 14_250_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  let currentTrades = trades(now.value, 100);
  const delivery = service({
    now,
    setup: state,
    telegram,
    price: { value: 100 },
    trades: () => currentTrades
  });
  await delivery.sendSignal(state.eligibility, 'validation');
  currentTrades = [
    trade('drop-a', 'sell', 40, 84.99, now.value),
    trade('drop-b', 'sell', 30, 84.99, now.value - 1_000),
    trade('drop-c', 'sell', 20, 84.99, now.value - 2_000)
  ];
  await delivery.refreshPrice('bsc', TOKEN);
  assert.match(telegram.edits.at(-1)!.text, /已过期/);
  state.database.close();
});

test('restart restores the signal-period pool reference and terminal edit releases it', async () => {
  const now = { value: 14_500_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  const retained: string[] = [];
  const released: string[] = [];
  const delivery = service({
    now,
    setup: state,
    telegram,
    price: { value: 100 },
    retain: (_chain, token, poolAddress) => retained.push(`${token}:${poolAddress}`),
    release: (_chain, token) => released.push(token)
  });
  await delivery.sendSignal(state.eligibility, 'validation');
  const restarted = service({
    now,
    setup: state,
    telegram,
    price: { value: 100 },
    retain: (_chain, token, poolAddress) => retained.push(`${token}:${poolAddress}`),
    release: (_chain, token) => released.push(token)
  });
  restarted.start();
  assert.equal(retained.length, 2);
  now.value += 90_000;
  await restarted.tick();
  assert.deepEqual(released, [TOKEN]);
  state.database.close();
});

test('30-second recheck retries once, accepts off-rank security, and recovers an edit failure', async () => {
  const now = { value: 15_000_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  const price = { value: 100 };
  let securityCalls = 0;
  const delivery = service({
    now,
    setup: state,
    telegram,
    price,
    security: async () => {
      securityCalls += 1;
      if (securityCalls === 1) throw new Error('temporary gmgn failure');
      return gmgn(now.value).security;
    },
    trending: async () => ({ ...gmgn(now.value).trending, items: [] })
  });
  await delivery.sendSignal(state.eligibility, 'validation');
  now.value += 30_000;
  await delivery.tick();
  assert.equal(telegram.edits.length, 0);
  now.value += 2_999;
  await delivery.tick();
  assert.equal(securityCalls, 1);
  now.value += 1;
  await delivery.tick();
  assert.equal(securityCalls, 2);
  assert.equal(new SignalFollowupRepository(state.database).find('bsc', TOKEN)!.desiredState, 'ACTIVE');

  price.value = 108.01;
  telegram.editErrors.push(new TelegramExplicitError(500, 500, 'temporary edit failure'));
  await delivery.refreshPrice('bsc', TOKEN);
  assert.equal(
    new SignalFollowupRepository(state.database).find('bsc', TOKEN)!.appliedState,
    'ACTIVE'
  );
  const restarted = service({ now, setup: state, telegram, price });
  await restarted.tick();
  assert.equal(
    new SignalFollowupRepository(state.database).find('bsc', TOKEN)!.appliedState,
    'DONT_CHASE'
  );
  state.database.close();
});

test('a failed trending recheck retries instead of being treated as off-rank', async () => {
  const now = { value: 15_250_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  let trendingCalls = 0;
  const delivery = service({
    now,
    setup: state,
    telegram,
    price: { value: 100 },
    trending: async () => {
      trendingCalls += 1;
      throw new Error('trending unavailable');
    }
  });
  await delivery.sendSignal(state.eligibility, 'validation');
  now.value += 30_000;
  await delivery.tick();
  assert.equal(trendingCalls, 1);
  assert.equal(telegram.edits.length, 0);
  now.value += 3_000;
  await delivery.tick();
  assert.equal(trendingCalls, 2);
  assert.match(telegram.edits.at(-1)!.text, /最新风险数据无法确认/);
  state.database.close();
});

test('a price refresh arriving during a recheck runs immediately after it', async () => {
  const now = { value: 15_300_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  const price = { value: 100 };
  let releaseSecurity!: (value: GmgnTokenSecurity) => void;
  const blockedSecurity = new Promise<GmgnTokenSecurity>((resolve) => {
    releaseSecurity = resolve;
  });
  let markSecurityStarted!: () => void;
  const securityStarted = new Promise<void>((resolve) => {
    markSecurityStarted = resolve;
  });
  const delivery = service({
    now,
    setup: state,
    telegram,
    price,
    security: async () => {
      markSecurityStarted();
      return blockedSecurity;
    }
  });
  await delivery.sendSignal(state.eligibility, 'validation');
  now.value += 30_000;
  price.value = 115.01;
  const recheck = delivery.tick();
  await securityStarted;
  const refresh = delivery.refreshPrice('bsc', TOKEN);
  releaseSecurity(gmgn(now.value).security);
  await Promise.all([recheck, refresh]);
  assert.match(telegram.edits.at(-1)!.text, /已过期/);
  state.database.close();
});

test('only a CoinGecko pool-detail 404 is terminal pool disappearance', async () => {
  const gmgnNow = { value: 15_350_000 };
  const gmgnState = setup(gmgnNow);
  const gmgnTelegram = new FakeTelegram();
  const gmgnDelivery = service({
    now: gmgnNow,
    setup: gmgnState,
    telegram: gmgnTelegram,
    price: { value: 100 },
    security: async () => {
      throw new ProviderRequestError('gmgn', 'token_security', 'http', 404);
    }
  });
  await gmgnDelivery.sendSignal(gmgnState.eligibility, 'validation');
  gmgnNow.value += 30_000;
  await gmgnDelivery.tick();
  assert.equal(gmgnTelegram.edits.length, 0);
  gmgnNow.value += 3_000;
  await gmgnDelivery.tick();
  assert.match(gmgnTelegram.edits.at(-1)!.text, /最新风险数据无法确认/);
  assert.doesNotMatch(gmgnTelegram.edits.at(-1)!.text, /FIXED_POOL_MISSING/);
  gmgnState.database.close();

  const poolNow = { value: 15_375_000 };
  const poolState = setup(poolNow);
  const poolTelegram = new FakeTelegram();
  let detailCalls = 0;
  const poolDelivery = service({
    now: poolNow,
    setup: poolState,
    telegram: poolTelegram,
    price: { value: 100 },
    detail: async () => {
      detailCalls += 1;
      if (detailCalls > 1) {
        throw new ProviderRequestError('coingecko', 'pool_detail', 'http', 404);
      }
      return pool(poolNow.value);
    }
  });
  await poolDelivery.sendSignal(poolState.eligibility, 'validation');
  poolNow.value += 30_000;
  await poolDelivery.tick();
  assert.match(poolTelegram.edits.at(-1)!.text, /固定池已不可用/);
  assert.equal(new SignalRecheckRepository(poolState.database).listDue(poolNow.value + 3_000).length, 0);
  poolState.database.close();
});

test('a price refresh invalidates immediately when the fixed pool disappears', async () => {
  const now = { value: 15_390_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  let detailCalls = 0;
  const delivery = service({
    now,
    setup: state,
    telegram,
    price: { value: 100 },
    detail: async () => {
      detailCalls += 1;
      if (detailCalls > 1) {
        throw new ProviderRequestError('coingecko', 'pool_detail', 'http', 404);
      }
      return pool(now.value);
    }
  });
  await delivery.sendSignal(state.eligibility, 'validation');
  await delivery.refreshPrice('bsc', TOKEN);
  assert.match(telegram.edits.at(-1)!.text, /固定池已不可用/);
  assert.equal(
    new SignalFollowupRepository(state.database).find('bsc', TOKEN)!.desiredState,
    'INVALID'
  );
  state.database.close();
});

test('a terminal followup state cannot be downgraded by a later price update', () => {
  const now = { value: 15_400_000 };
  const state = setup(now);
  const followups = new SignalFollowupRepository(state.database);
  const outbox = new OutboxRepository(state.database).createOrGet({
    chain: 'bsc',
    tokenAddress: TOKEN,
    messageKind: 'signal',
    channelRole: 'validation',
    payload: {},
    createdAtMs: now.value
  }).record;
  followups.create({
    chain: 'bsc',
    tokenAddress: TOKEN,
    outboxId: outbox.id,
    preSendPriceUsd: 100,
    preSendTradeAtMs: now.value,
    receiptAtMs: now.value,
    snapshot: {}
  });
  followups.setDesired('bsc', TOKEN, 'INVALID', 'risk', now.value + 1);
  followups.setDesired('bsc', TOKEN, 'DONT_CHASE', 'price', now.value + 2);
  assert.equal(followups.find('bsc', TOKEN)!.desiredState, 'INVALID');
  assert.equal(followups.find('bsc', TOKEN)!.desiredReason, 'risk');
  state.database.close();
});

test('a post-send reserve decline above ten percent invalidates on the scheduled recheck', async () => {
  const now = { value: 15_500_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  const reserve = { value: 12_000 };
  const delivery = service({
    now,
    setup: state,
    telegram,
    price: { value: 100 },
    reserve
  });
  await delivery.sendSignal(state.eligibility, 'validation');
  reserve.value = 10_799;
  now.value += 30_000;
  await delivery.tick();
  assert.match(telegram.edits.at(-1)!.text, /固定池流动性快速下降/);
  state.database.close();
});

test('two failed 60-second checks invalidate as data-unconfirmed while a hard risk fails immediately', async () => {
  const now = { value: 16_000_000 };
  const state = setup(now);
  const telegram = new FakeTelegram();
  const delivery = service({
    now,
    setup: state,
    telegram,
    price: { value: 100 },
    security: async () => { throw new Error('security unavailable'); }
  });
  await delivery.sendSignal(state.eligibility, 'validation');
  now.value += 30_000;
  await delivery.tick();
  now.value += 3_000;
  await delivery.tick();
  assert.match(telegram.edits.at(-1)!.text, /最新风险数据无法确认/);
  state.database.close();

  const riskNow = { value: 17_000_000 };
  const riskState = setup(riskNow);
  const riskTelegram = new FakeTelegram();
  const riskDelivery = service({
    now: riskNow,
    setup: riskState,
    telegram: riskTelegram,
    price: { value: 100 },
    security: async () => gmgn(riskNow.value, '0.26').security
  });
  await riskDelivery.sendSignal(riskState.eligibility, 'validation');
  riskNow.value += 30_000;
  await riskDelivery.tick();
  assert.match(riskTelegram.edits.at(-1)!.text, /Top10 持仓超限/);
  assert.equal(new SignalRecheckRepository(riskState.database).listDue(riskNow.value + 3_000).length, 0);
  riskState.database.close();
});
