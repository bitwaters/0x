import {
  getConfiguredSecrets,
  getSafeConfigSummary,
  loadRuntimeConfig
} from './config.js';
import { openDatabase } from './db/database.js';
import {
  CandidateRepository,
  OutboxRepository,
  RuleVersionRepository
} from './db/repositories.js';
import { BotRuntime } from './runtime/service.js';
import { formatSafeError } from './security/redaction.js';

async function main(): Promise<void> {
  let secrets: string[] = [];
  let database: ReturnType<typeof openDatabase> | undefined;
  let runtime: BotRuntime | undefined;

  try {
    const config = loadRuntimeConfig();
    secrets = getConfiguredSecrets(config);
    database = openDatabase(config.databasePath);
    const rules = new RuleVersionRepository(database);
    rules.save(config.ruleVersion, {
      chains: config.chains,
      polling: config.polling,
      thresholds: config.thresholds,
      sourcePolicy: config.sourcePolicy,
      discoveryPolicy: config.discoveryPolicy,
      qualificationPolicy: config.qualificationPolicy,
      telegramDeliveryPolicy: config.telegramDeliveryPolicy,
      evaluationPolicy: config.evaluationPolicy
    });
    const reopenedLegacyCandidates = new CandidateRepository(
      database
    ).reopenEligibleLegacy(config.ruleVersion);
    const recoveredInterruptedSends = new OutboxRepository(
      database
    ).recoverInterruptedSends();
    process.stdout.write(
      `${JSON.stringify({
        event: 'startup_ready',
        config: getSafeConfigSummary(config),
        recoveredInterruptedSends,
        reopenedLegacyCandidates
      })}\n`
    );
    runtime = new BotRuntime(database, config);
    runtime.start();
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: 'startup_failed',
        error: formatSafeError(error, secrets)
      })}\n`
    );
    process.exitCode = 1;
  } finally {
    await runtime?.stop();
    database?.close();
  }
}

void main();
