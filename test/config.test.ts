import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ConfigError,
  assertSecretFileMode,
  getConfiguredSecrets,
  getSafeConfigSummary,
  loadConfigFile,
  loadRuntimeConfig,
  parseConfig
} from '../src/config.js';
import { redactSensitiveText } from '../src/security/redaction.js';

const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  GMGN_API_KEY: 'gmgn-test-secret',
  COINGECKO_PRO_API_KEY: 'coingecko-test-secret'
};

test('parses safe defaults without exposing provider secrets', () => {
  const config = parseConfig({ ...BASE_ENV });
  const summary = JSON.stringify(getSafeConfigSummary(config));

  assert.equal(config.chains.sol, true);
  assert.equal(config.chains.bsc, true);
  assert.equal(config.telegram.enabled, false);
  assert.equal(config.thresholds.marketCapMinUsd, 10_000);
  assert.equal(config.thresholds.marketCapMaxUsd, 300_000);
  assert.deepEqual(config.qualificationPolicy.marketCapUsd, { min: 20_000, max: 300_000 });
  assert.deepEqual(config.discoveryPolicy.publicRadar, {
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
  });
  assert.equal(config.limits.coinGeckoRestRpm, 450);
  assert.equal(config.qualificationPolicy.tradeMinCount, 5);
  assert.deepEqual(config.sourcePolicy.gmgnTrendingFilters.bsc, [
    'not_honeypot',
    'verified',
    'renounced'
  ]);
  assert.match(summary, /gmgn-prod-2026-08-22\+cgv3-g2/);
  assert.match(config.ruleVersion, /^rules-[a-f0-9]{12}$/);
  assert.doesNotMatch(summary, /gmgn-test-secret|coingecko-test-secret/);
});

test('changes rule version for rule changes but not secret rotation', () => {
  const initial = parseConfig({ ...BASE_ENV });
  const rotatedSecret = parseConfig({
    ...BASE_ENV,
    GMGN_API_KEY: 'different-provider-secret'
  });
  const changedRule = parseConfig({
    ...BASE_ENV,
    TOP10_MAX_RATIO: '0.2'
  });
  const movedRuntime = parseConfig({
    ...BASE_ENV,
    NODE_ENV: 'production',
    DATABASE_PATH: '/tmp/moved.db'
  });

  assert.equal(initial.ruleVersion, rotatedSecret.ruleVersion);
  assert.equal(initial.ruleVersion, movedRuntime.ruleVersion);
  assert.notEqual(initial.ruleVersion, changedRule.ruleVersion);
});

test('loads a mode-600 env file into an injected environment object', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-signal-dotenv-'));
  const file = join(directory, '.env.local');
  writeFileSync(
    file,
    ['NODE_ENV=test', 'GMGN_API_KEY=file-gmgn-key', 'COINGECKO_PRO_API_KEY=file-cg-key'].join(
      '\n'
    ),
    { mode: 0o600 }
  );
  chmodSync(file, 0o600);
  const environment: NodeJS.ProcessEnv = { ENV_FILE: file };

  const config = loadRuntimeConfig(environment);

  assert.equal(config.environment, 'test');
  assert.equal(config.providers.gmgnApiKey, 'file-gmgn-key');
  assert.equal(environment.GMGN_API_KEY, 'file-gmgn-key');
});

test('file-only validation cannot be masked by previously exported values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-signal-file-check-'));
  const file = join(directory, '.env.local');
  writeFileSync(
    file,
    [
      'GMGN_API_KEY=<your_gmgn_api_key>',
      'COINGECKO_PRO_API_KEY=<your_coingecko_analyst_api_key>',
      'TELEGRAM_ENABLED=true',
      'TELEGRAM_BOT_TOKEN=<your_botfather_token>',
      'TELEGRAM_RADAR_CHAT_ID=-1001',
      'TELEGRAM_VALIDATION_CHAT_ID=-1001',
      'TELEGRAM_FORMAL_CHAT_ID=-1003'
    ].join('\n'),
    { mode: 0o600 }
  );
  chmodSync(file, 0o600);

  assert.throws(
    () =>
      loadConfigFile({
        ENV_FILE: file,
        GMGN_API_KEY: 'previously-exported-gmgn-key',
        COINGECKO_PRO_API_KEY: 'previously-exported-cg-key',
        TELEGRAM_ENABLED: 'false'
      }),
    /placeholder value|must be distinct/
  );
});

test('rejects unchanged example placeholders and unsafe polling intervals', () => {
  assert.throws(
    () =>
      parseConfig({
        ...BASE_ENV,
        GMGN_API_KEY: 'replace_me',
        COINGECKO_PRO_API_KEY: 'changeme',
        GMGN_POLL_1M_MS: '7000',
        GMGN_POLL_5M_MS: '15000'
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /placeholder value/);
      assert.match(error.message, /GMGN_POLL_1M_MS/);
      assert.match(error.message, /GMGN_POLL_5M_MS/);
      return true;
    }
  );
});

test('requires all distinct Telegram channel roles when enabled', () => {
  assert.throws(
    () => parseConfig({ ...BASE_ENV, TELEGRAM_ENABLED: 'true' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /TELEGRAM_BOT_TOKEN/);
      assert.match(error.message, /TELEGRAM_VALIDATION_CHAT_ID/);
      return true;
    }
  );

  assert.throws(
    () =>
      parseConfig({
        ...BASE_ENV,
        TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: 'telegram-test-secret',
        TELEGRAM_RADAR_CHAT_ID: '-1001',
        TELEGRAM_VALIDATION_CHAT_ID: '-1001',
        TELEGRAM_FORMAL_CHAT_ID: '-1003'
      }),
    /must be distinct/
  );

  assert.throws(
    () =>
      parseConfig({
        ...BASE_ENV,
        TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: '<your_botfather_token>',
        TELEGRAM_RADAR_CHAT_ID: '<radar_channel_id>',
        TELEGRAM_VALIDATION_CHAT_ID: '-2002',
        TELEGRAM_FORMAL_CHAT_ID: '-1003'
      }),
    /placeholder value|beginning with -100/
  );
});

test('rejects unsafe ranges and disabling both chains', () => {
  assert.throws(
    () =>
      parseConfig({
        ...BASE_ENV,
        SOL_ENABLED: 'false',
        BSC_ENABLED: 'false',
        TOP10_MAX_RATIO: '1.2'
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /at least one chain/);
      assert.match(error.message, /TOP10_MAX_RATIO/);
      return true;
    }
  );
});

test('redacts configured secrets, headers, query values and chat IDs', () => {
  const config = parseConfig({
    ...BASE_ENV,
    TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: 'telegram-test-secret',
    TELEGRAM_RADAR_CHAT_ID: '-1001',
    TELEGRAM_VALIDATION_CHAT_ID: '-1002',
    TELEGRAM_FORMAL_CHAT_ID: '-1003'
  });
  const input = [
    'Authorization: Bearer raw-bearer-token',
    'api_key=raw-api-key',
    'https://example.test?q=1&x_cg_pro_api_key=raw-query-key',
    'gmgn-test-secret -1001'
  ].join(' ');
  const redacted = redactSensitiveText(input, getConfiguredSecrets(config));

  assert.doesNotMatch(
    redacted,
    /raw-bearer-token|raw-api-key|raw-query-key|gmgn-test-secret|-1001/
  );
  assert.match(redacted, /\[REDACTED\]/);
});

test('requires an existing secret file to use mode 600', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-signal-config-'));
  const file = join(directory, '.env.local');
  writeFileSync(file, 'GMGN_API_KEY=not-a-real-key\n', { mode: 0o644 });
  chmodSync(file, 0o644);

  assert.throws(() => assertSecretFileMode(file), /permissions must be 600/);

  chmodSync(file, 0o600);
  assert.doesNotThrow(() => assertSecretFileMode(file));
});
