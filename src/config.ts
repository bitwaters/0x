import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import { stableJsonStringify } from './domain/json.js';
import { DISCOVERY_POLICY } from './discovery/policy.js';
import { EVALUATION_POLICY } from './evaluation/policy.js';
import { QUALIFICATION_POLICY } from './qualification/policy.js';
import { TELEGRAM_DELIVERY_POLICY } from './telegram/policy.js';
import {
  GMGN_TRENDING_FILTERS,
  PROVIDER_CONTRACT_VERSION
} from './providers/sourcePolicy.js';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
const PLACEHOLDER_VALUE = /^(?:replace_me|changeme|<[^>]+>)$/i;

function booleanValue(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (TRUE_VALUES.has(normalized)) return true;
      if (FALSE_VALUES.has(normalized)) return false;
    }
    return value;
  }, z.boolean());
}

function finiteNumber(defaultValue: number) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') return defaultValue;
    if (typeof value === 'string') return Number(value);
    return value;
  }, z.number().finite());
}

function positiveNumber(defaultValue: number) {
  return finiteNumber(defaultValue).pipe(z.number().positive());
}

function integerInRange(defaultValue: number, minimum: number, maximum: number) {
  return finiteNumber(defaultValue).pipe(
    z.number().int().min(minimum).max(maximum)
  );
}

function ratio(defaultValue: number) {
  return finiteNumber(defaultValue).pipe(z.number().min(0).max(1));
}

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    DATABASE_PATH: z.string().trim().min(1).default('./data/meme-signal.db'),
    GMGN_API_KEY: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !PLACEHOLDER_VALUE.test(value), {
        message: 'must not use a placeholder value'
      }),
    COINGECKO_PRO_API_KEY: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !PLACEHOLDER_VALUE.test(value), {
        message: 'must not use a placeholder value'
      }),
    SOL_ENABLED: booleanValue(true),
    BSC_ENABLED: booleanValue(true),
    TELEGRAM_ENABLED: booleanValue(false),
    TELEGRAM_BOT_TOKEN: z.string().trim().optional(),
    TELEGRAM_RADAR_CHAT_ID: z.string().trim().optional(),
    TELEGRAM_VALIDATION_CHAT_ID: z.string().trim().optional(),
    TELEGRAM_FORMAL_CHAT_ID: z.string().trim().optional(),
    GMGN_POLL_1M_MS: integerInRange(3_000, 1_000, 5_000),
    GMGN_POLL_5M_MS: integerInRange(10_000, 6_000, 12_000),
    MARKET_CAP_MIN_USD: positiveNumber(20_000),
    MARKET_CAP_MAX_USD: positiveNumber(500_000),
    LIQUIDITY_MIN_USD: positiveNumber(10_000),
    POOL_AGE_MAX_SECONDS: integerInRange(21_600, 60, 604_800),
    QUALIFICATION_WINDOW_SECONDS: integerInRange(120, 30, 600),
    MAX_OBSERVED_GAIN_RATIO: ratio(0.8),
    TOP10_MAX_RATIO: ratio(0.25),
    INSIDER_MAX_RATIO: ratio(0.2),
    BUNDLER_MAX_RATIO: ratio(0.2),
    DEV_TEAM_MAX_RATIO: ratio(0.2),
    RUG_MAX_RATIO: ratio(0.3),
    TAX_MAX_RATIO: ratio(0.05),
    GMGN_REST_RPM: finiteNumber(120).pipe(z.number().int().min(1).max(120)),
    COINGECKO_REST_RPM: finiteNumber(450).pipe(z.number().int().min(1).max(450))
  })
  .superRefine((value, context) => {
    if (!value.SOL_ENABLED && !value.BSC_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['SOL_ENABLED'],
        message: 'at least one chain must be enabled'
      });
    }

    if (value.MARKET_CAP_MIN_USD >= value.MARKET_CAP_MAX_USD) {
      context.addIssue({
        code: 'custom',
        path: ['MARKET_CAP_MAX_USD'],
        message: 'must be greater than MARKET_CAP_MIN_USD'
      });
    }

    if (value.GMGN_POLL_1M_MS >= value.GMGN_POLL_5M_MS) {
      context.addIssue({
        code: 'custom',
        path: ['GMGN_POLL_5M_MS'],
        message: 'must be greater than GMGN_POLL_1M_MS'
      });
    }

    if (value.TELEGRAM_ENABLED) {
      const requiredFields = [
        'TELEGRAM_BOT_TOKEN',
        'TELEGRAM_RADAR_CHAT_ID',
        'TELEGRAM_VALIDATION_CHAT_ID',
        'TELEGRAM_FORMAL_CHAT_ID'
      ] as const;

      for (const field of requiredFields) {
        if (!value[field]) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'is required when TELEGRAM_ENABLED=true'
          });
        } else if (PLACEHOLDER_VALUE.test(value[field]!)) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'must not use a placeholder value'
          });
        }
      }

      for (const field of [
        'TELEGRAM_RADAR_CHAT_ID',
        'TELEGRAM_VALIDATION_CHAT_ID',
        'TELEGRAM_FORMAL_CHAT_ID'
      ] as const) {
        const chatId = value[field];
        if (chatId && !PLACEHOLDER_VALUE.test(chatId) && !/^-100\d+$/.test(chatId)) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'must be a Telegram channel ID beginning with -100'
          });
        }
      }

      const chatIds = [
        value.TELEGRAM_RADAR_CHAT_ID,
        value.TELEGRAM_VALIDATION_CHAT_ID,
        value.TELEGRAM_FORMAL_CHAT_ID
      ].filter((item): item is string => Boolean(item));

      if (new Set(chatIds).size !== chatIds.length) {
        context.addIssue({
          code: 'custom',
          path: ['TELEGRAM_RADAR_CHAT_ID'],
          message: 'radar, validation and formal chat IDs must be distinct'
        });
      }
    }
  });

type RawEnvironment = z.infer<typeof environmentSchema>;

export type Chain = 'sol' | 'bsc';

export interface RuntimeConfig {
  readonly environment: RawEnvironment['NODE_ENV'];
  readonly databasePath: string;
  readonly providers: {
    readonly gmgnApiKey: string;
    readonly coinGeckoApiKey: string;
  };
  readonly chains: Readonly<Record<Chain, boolean>>;
  readonly telegram:
    | { readonly enabled: false }
    | {
        readonly enabled: true;
        readonly botToken: string;
        readonly radarChatId: string;
        readonly validationChatId: string;
        readonly formalChatId: string;
      };
  readonly polling: {
    readonly oneMinuteMs: number;
    readonly fiveMinuteMs: number;
  };
  readonly thresholds: {
    readonly marketCapMinUsd: number;
    readonly marketCapMaxUsd: number;
    readonly liquidityMinUsd: number;
    readonly poolAgeMaxSeconds: number;
    readonly qualificationWindowSeconds: number;
    readonly maxObservedGainRatio: number;
    readonly top10MaxRatio: number;
    readonly insiderMaxRatio: number;
    readonly bundlerMaxRatio: number;
    readonly devTeamMaxRatio: number;
    readonly rugMaxRatio: number;
    readonly taxMaxRatio: number;
  };
  readonly limits: {
    readonly gmgnRestRpm: number;
    readonly coinGeckoRestRpm: number;
  };
  readonly sourcePolicy: {
    readonly providerContractVersion: string;
    readonly gmgnTrendingFilters: typeof GMGN_TRENDING_FILTERS;
  };
  readonly discoveryPolicy: typeof DISCOVERY_POLICY;
  readonly qualificationPolicy: typeof QUALIFICATION_POLICY;
  readonly telegramDeliveryPolicy: typeof TELEGRAM_DELIVERY_POLICY;
  readonly evaluationPolicy: typeof EVALUATION_POLICY;
  readonly ruleVersion: string;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'configuration';
    return `${path}: ${issue.message}`;
  });
}

function createRuleVersion(value: unknown): string {
  const serialized = stableJsonStringify(value);
  return `rules-${createHash('sha256').update(serialized).digest('hex').slice(0, 12)}`;
}

export function parseConfig(environment: NodeJS.ProcessEnv): RuntimeConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) throw new ConfigError(formatIssues(parsed.error));

  const value = parsed.data;
  const telegram: RuntimeConfig['telegram'] = value.TELEGRAM_ENABLED
    ? {
        enabled: true,
        botToken: value.TELEGRAM_BOT_TOKEN!,
        radarChatId: value.TELEGRAM_RADAR_CHAT_ID!,
        validationChatId: value.TELEGRAM_VALIDATION_CHAT_ID!,
        formalChatId: value.TELEGRAM_FORMAL_CHAT_ID!
      }
    : { enabled: false };

  const publicConfig = {
    environment: value.NODE_ENV,
    databasePath: value.DATABASE_PATH,
    chains: { sol: value.SOL_ENABLED, bsc: value.BSC_ENABLED },
    polling: {
      oneMinuteMs: value.GMGN_POLL_1M_MS,
      fiveMinuteMs: value.GMGN_POLL_5M_MS
    },
    thresholds: {
      marketCapMinUsd: value.MARKET_CAP_MIN_USD,
      marketCapMaxUsd: value.MARKET_CAP_MAX_USD,
      liquidityMinUsd: value.LIQUIDITY_MIN_USD,
      poolAgeMaxSeconds: value.POOL_AGE_MAX_SECONDS,
      qualificationWindowSeconds: value.QUALIFICATION_WINDOW_SECONDS,
      maxObservedGainRatio: value.MAX_OBSERVED_GAIN_RATIO,
      top10MaxRatio: value.TOP10_MAX_RATIO,
      insiderMaxRatio: value.INSIDER_MAX_RATIO,
      bundlerMaxRatio: value.BUNDLER_MAX_RATIO,
      devTeamMaxRatio: value.DEV_TEAM_MAX_RATIO,
      rugMaxRatio: value.RUG_MAX_RATIO,
      taxMaxRatio: value.TAX_MAX_RATIO
    },
    limits: {
      gmgnRestRpm: value.GMGN_REST_RPM,
      coinGeckoRestRpm: value.COINGECKO_REST_RPM
    },
    sourcePolicy: {
      providerContractVersion: PROVIDER_CONTRACT_VERSION,
      gmgnTrendingFilters: GMGN_TRENDING_FILTERS
    },
    discoveryPolicy: DISCOVERY_POLICY,
    qualificationPolicy: QUALIFICATION_POLICY,
    telegramDeliveryPolicy: TELEGRAM_DELIVERY_POLICY,
    evaluationPolicy: EVALUATION_POLICY
  } as const;

  const ruleInputs = {
    chains: publicConfig.chains,
    polling: publicConfig.polling,
    thresholds: publicConfig.thresholds,
    sourcePolicy: publicConfig.sourcePolicy,
    discoveryPolicy: publicConfig.discoveryPolicy,
    qualificationPolicy: publicConfig.qualificationPolicy,
    telegramDeliveryPolicy: publicConfig.telegramDeliveryPolicy,
    evaluationPolicy: publicConfig.evaluationPolicy
  } as const;

  return {
    ...publicConfig,
    providers: {
      gmgnApiKey: value.GMGN_API_KEY,
      coinGeckoApiKey: value.COINGECKO_PRO_API_KEY
    },
    telegram,
    ruleVersion: createRuleVersion(ruleInputs)
  };
}

export function assertSecretFileMode(filePath: string): void {
  if (!existsSync(filePath) || process.platform === 'win32') return;
  const permissions = statSync(filePath).mode & 0o777;
  if (permissions !== 0o600) {
    throw new ConfigError([
      `${filePath}: permissions must be 600, received ${permissions.toString(8)}`
    ]);
  }
}

export function loadRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
  const envFile = resolve(environment.ENV_FILE ?? '.env.local');
  assertSecretFileMode(envFile);
  loadDotenv({
    path: envFile,
    override: false,
    quiet: true,
    processEnv: environment
  });
  return parseConfig(environment);
}

export function loadConfigFile(
  sourceEnvironment: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
  const envFile = resolve(sourceEnvironment.ENV_FILE ?? '.env.local');
  return loadRuntimeConfig({ ENV_FILE: envFile });
}

export function getSafeConfigSummary(config: RuntimeConfig) {
  return {
    environment: config.environment,
    databasePath: config.databasePath,
    chains: config.chains,
    telegramEnabled: config.telegram.enabled,
    polling: config.polling,
    thresholds: config.thresholds,
    limits: config.limits,
    sourcePolicy: config.sourcePolicy,
    discoveryPolicy: config.discoveryPolicy,
    qualificationPolicy: config.qualificationPolicy,
    telegramDeliveryPolicy: config.telegramDeliveryPolicy,
    evaluationPolicy: config.evaluationPolicy,
    ruleVersion: config.ruleVersion
  } as const;
}

export function getConfiguredSecrets(config: RuntimeConfig): string[] {
  const secrets = [config.providers.gmgnApiKey, config.providers.coinGeckoApiKey];
  if (config.telegram.enabled) {
    secrets.push(
      config.telegram.botToken,
      config.telegram.radarChatId,
      config.telegram.validationChatId,
      config.telegram.formalChatId
    );
  }
  return secrets;
}
