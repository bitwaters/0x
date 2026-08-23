export class ContractError extends Error {
  constructor(
    readonly provider: 'gmgn' | 'coingecko',
    readonly operation: string,
    readonly field: string,
    message = 'invalid provider response'
  ) {
    super(`${provider} ${operation}: ${field}: ${message}`);
    this.name = 'ContractError';
  }
}

export function recordValue(
  provider: ContractError['provider'],
  operation: string,
  field: string,
  value: unknown
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError(provider, operation, field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

export function arrayValue(
  provider: ContractError['provider'],
  operation: string,
  field: string,
  value: unknown
): unknown[] {
  if (!Array.isArray(value)) {
    throw new ContractError(provider, operation, field, 'must be an array');
  }
  return value;
}

export function stringValue(
  provider: ContractError['provider'],
  operation: string,
  field: string,
  value: unknown,
  allowEmpty = false
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new ContractError(provider, operation, field, 'must be a string');
  }
  return value;
}

export function booleanValue(
  provider: ContractError['provider'],
  operation: string,
  field: string,
  value: unknown
): boolean {
  if (typeof value !== 'boolean') {
    throw new ContractError(provider, operation, field, 'must be a boolean');
  }
  return value;
}

export function numberValue(
  provider: ContractError['provider'],
  operation: string,
  field: string,
  value: unknown,
  options: {
    readonly numericString?: boolean;
    readonly integer?: boolean;
    readonly minimum?: number;
    readonly maximum?: number;
    readonly positive?: boolean;
  } = {}
): number {
  const parsed =
    options.numericString === true && typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new ContractError(provider, operation, field, 'must be a finite number');
  }
  if (options.integer === true && !Number.isInteger(parsed)) {
    throw new ContractError(provider, operation, field, 'must be an integer');
  }
  if (options.positive === true && parsed <= 0) {
    throw new ContractError(provider, operation, field, 'must be positive');
  }
  if (options.minimum !== undefined && parsed < options.minimum) {
    throw new ContractError(provider, operation, field, 'is below the allowed range');
  }
  if (options.maximum !== undefined && parsed > options.maximum) {
    throw new ContractError(provider, operation, field, 'is above the allowed range');
  }
  return parsed;
}

export function decimalStringValue(
  provider: ContractError['provider'],
  operation: string,
  field: string,
  value: unknown,
  options: {
    readonly minimum?: number;
    readonly maximum?: number;
    readonly positive?: boolean;
  } = {}
): number {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ContractError(provider, operation, field, 'must be a decimal string');
  }
  return numberValue(provider, operation, field, value, {
    numericString: true,
    ...options
  });
}

export function timestampMsFromSeconds(
  provider: ContractError['provider'],
  operation: string,
  field: string,
  value: unknown,
  allowZero = false
): number | null {
  const seconds = numberValue(provider, operation, field, value, {
    integer: true,
    minimum: 0
  });
  if (seconds === 0 && allowZero) return null;
  if (seconds === 0) {
    throw new ContractError(provider, operation, field, 'must be a positive Unix timestamp');
  }
  return seconds * 1000;
}

export function timestampMsFromIso(
  provider: ContractError['provider'],
  operation: string,
  field: string,
  value: unknown
): number {
  const text = stringValue(provider, operation, field, value);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new ContractError(provider, operation, field, 'must be an ISO timestamp');
  }
  return parsed;
}
