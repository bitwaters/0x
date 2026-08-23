import {
  getConfiguredSecrets,
  loadRuntimeConfig,
  type Chain
} from './config.js';
import { CoinGeckoClient } from './providers/coingecko.js';
import {
  GmgnClient,
  evaluateGmgnTokenSecurity,
  gmgnThresholds
} from './providers/gmgn.js';
import { formatSafeError } from './security/redaction.js';

async function smokeChain(
  chain: Chain,
  gmgn: GmgnClient,
  coinGecko: CoinGeckoClient,
  config: ReturnType<typeof loadRuntimeConfig>,
  signal: AbortSignal
) {
  const trending = await gmgn.getTrending(chain, '1m', 100, signal);
  const scoped = trending.items.filter(
    (item) =>
      item.marketCapUsd >= config.thresholds.marketCapMinUsd &&
      item.marketCapUsd <= config.thresholds.marketCapMaxUsd
  );
  const candidates = scoped.length > 0 ? scoped : trending.items;
  let lastError: unknown;
  for (const item of candidates.slice(0, 12)) {
    try {
      const [info, security] = await Promise.all([
        gmgn.getTokenInfo(chain, item.tokenAddress, signal),
        gmgn.getTokenSecurity(chain, item.tokenAddress, signal)
      ]);
      if (info.biggestPoolAddress === null) continue;
      const securityDecision = evaluateGmgnTokenSecurity({
        chain,
        security,
        thresholds: gmgnThresholds(config),
        nowMs: Date.now()
      });
      const pool = await coinGecko.getPoolDetail(
        chain,
        info.biggestPoolAddress,
        item.tokenAddress,
        signal
      );
      const trades = await coinGecko.getPoolTrades(pool, signal);
      return {
        event: 'live_smoke_chain_ok',
        chain,
        trendingCount: trending.items.length,
        lowCapScopedCount: scoped.length,
        selectedRank: item.rank,
        selectedMarketCapUsd: item.marketCapUsd,
        securityContractPassed: true,
        securityPolicyPassed: securityDecision.passed,
        securityReasonCount: securityDecision.reasons.length,
        poolSide: pool.candidateSide,
        reserveUsd: pool.reserveUsd,
        tradesCount: trades.length,
        latestTradeAtMs: trades.reduce(
          (latest, trade) => Math.max(latest, trade.blockTimestampMs),
          0
        )
      } as const;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `no usable fixed pool found in first ${Math.min(12, candidates.length)} candidates: ${
      lastError instanceof Error ? lastError.message : 'no candidate with biggest pool'
    }`
  );
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const secrets = getConfiguredSecrets(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('live_smoke_timeout'), 120_000);
  try {
    const gmgn = new GmgnClient(config.providers.gmgnApiKey, {
      requestsPerMinute: config.limits.gmgnRestRpm
    });
    const coinGecko = new CoinGeckoClient(config.providers.coinGeckoApiKey, {
      restRequestsPerMinute: config.limits.coinGeckoRestRpm
    });
    for (const chain of ['sol', 'bsc'] as const) {
      if (!config.chains[chain]) throw new Error(`${chain} must be enabled for two-chain smoke`);
      process.stdout.write(
        `${JSON.stringify(await smokeChain(chain, gmgn, coinGecko, config, controller.signal))}\n`
      );
    }
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: 'live_smoke_failed', error: formatSafeError(error, secrets) })}\n`
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

void main();
