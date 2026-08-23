export const MARKET_DECISION_SOURCES = ['gmgn', 'coingecko'] as const;
export type MarketDecisionSource = (typeof MARKET_DECISION_SOURCES)[number];

export const MARKET_PROVIDER_REGISTRY = {
  gmgn: { restOrigin: 'https://openapi.gmgn.ai', webOrigin: 'https://gmgn.ai' },
  coingecko: {
    restOrigin: 'https://pro-api.coingecko.com',
    realtimeOrigin: 'wss://stream.coingecko.com'
  }
} as const;

export const PROVIDER_CONTRACT_VERSION = 'gmgn-prod-2026-08-22+cgv3-g2';
export const GMGN_TRENDING_FILTERS = {
  sol: ['renounced', 'frozen'],
  bsc: ['not_honeypot', 'verified', 'renounced']
} as const;

export const COINGECKO_REALTIME_CHANNEL = 'G2' as const;
export const COINGECKO_REALTIME_CHANNELS = [COINGECKO_REALTIME_CHANNEL] as const;
export const COINGECKO_REST_RESOURCES = [
  'fixed_pool_detail',
  'fixed_pool_trades',
  'fixed_pool_ohlcv'
] as const;

function assertAllowedMarketPath(source: MarketDecisionSource, path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error(`${source} path must be an origin-relative URL`);
  }
  const allowed =
    source === 'gmgn'
      ? ['/v1/market/rank', '/v1/token/info', '/v1/token/security'].includes(path)
      : /^\/api\/v3\/onchain\/networks\/(?:solana|bsc)\/pools\/[^/]+(?:\/trades|\/ohlcv\/(?:second|minute|hour|day))?$/.test(
          path
        );
  if (!allowed) throw new Error(`${source} market path is not allowed`);
}

export function assertMarketDecisionSource(value: string): asserts value is MarketDecisionSource {
  if (!MARKET_DECISION_SOURCES.includes(value as MarketDecisionSource)) {
    throw new Error(`market decision source is not allowed: ${value}`);
  }
}

export function marketProviderRestUrl(source: MarketDecisionSource, path: string): URL {
  assertMarketDecisionSource(source);
  assertAllowedMarketPath(source, path);
  const configuredOrigin = new URL(MARKET_PROVIDER_REGISTRY[source].restOrigin).origin;
  const url = new URL(path, configuredOrigin);
  if (url.origin !== configuredOrigin) throw new Error(`${source} origin is not allowed`);
  return url;
}

export function coinGeckoRealtimeUrl(): string {
  return new URL('/v1', MARKET_PROVIDER_REGISTRY.coingecko.realtimeOrigin).toString();
}

export function gmgnTokenPageUrl(chain: 'sol' | 'bsc', tokenAddress: string): string {
  const origin = new URL(MARKET_PROVIDER_REGISTRY.gmgn.webOrigin).origin;
  return new URL(`/${chain}/token/${encodeURIComponent(tokenAddress)}`, origin).toString();
}
