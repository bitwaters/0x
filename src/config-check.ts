import {
  getSafeConfigSummary,
  loadConfigFile
} from './config.js';
import { formatSafeError } from './security/redaction.js';

try {
  const config = loadConfigFile();
  const safe = getSafeConfigSummary(config);
  process.stdout.write(
    `${JSON.stringify({
      event: 'configuration_valid',
      configurationSource: 'env_file',
      environment: safe.environment,
      databasePath: safe.databasePath,
      chains: safe.chains,
      telegramEnabled: safe.telegramEnabled,
      telegramRolesConfigured: config.telegram.enabled
        ? { radar: true, validation: true, formal: true, distinct: true }
        : { radar: false, validation: false, formal: false, distinct: false },
      polling: safe.polling,
      thresholds: safe.thresholds,
      limits: safe.limits,
      ruleVersion: safe.ruleVersion
    })}\n`
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ event: 'configuration_invalid', error: formatSafeError(error) })}\n`
  );
  process.exitCode = 1;
}
