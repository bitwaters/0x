const SENSITIVE_ASSIGNMENT =
  /\b(api[-_]?key|authorization|bot[-_]?token|token|secret|chat[-_]?id)\b\s*[:=]\s*([^\s,;]+)/gi;
const SENSITIVE_QUERY =
  /([?&](?:x_cg_pro_api_key|api_key|apikey|token|access_token)=)[^&#\s]*/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

function uniqueSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets.filter((secret) => secret.length >= 4))].sort(
    (left, right) => right.length - left.length
  );
}

export function redactSensitiveText(
  text: string,
  secrets: readonly string[] = []
): string {
  let redacted = text;

  for (const secret of uniqueSecrets(secrets)) {
    redacted = redacted.replaceAll(secret, '[REDACTED]');
  }

  return redacted
    .replace(SENSITIVE_QUERY, '$1[REDACTED]')
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, '$1=[REDACTED]');
}

export function formatSafeError(
  error: unknown,
  secrets: readonly string[] = []
): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message, secrets);
}
