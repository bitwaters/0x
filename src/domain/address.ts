import type { Chain } from '../config.js';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map(
  [...BASE58_ALPHABET].map((character, index) => [character, BigInt(index)])
);

export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressError';
  }
}

function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) throw new AddressError('SOL address must not be empty');

  let numericValue = 0n;
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) throw new AddressError('SOL address contains non-base58 data');
    numericValue = numericValue * 58n + digit;
  }

  const bytes: number[] = [];
  while (numericValue > 0n) {
    bytes.unshift(Number(numericValue % 256n));
    numericValue /= 256n;
  }

  let leadingZeroes = 0;
  while (value[leadingZeroes] === '1') leadingZeroes += 1;
  return Uint8Array.from([...new Array<number>(leadingZeroes).fill(0), ...bytes]);
}

export function normalizeAddress(chain: Chain, address: string): string {
  const trimmed = address.trim();
  if (chain === 'bsc') {
    if (!EVM_ADDRESS.test(trimmed)) {
      throw new AddressError('BSC address must be a 20-byte 0x-prefixed hex value');
    }
    return trimmed.toLowerCase();
  }

  if (decodeBase58(trimmed).length !== 32) {
    throw new AddressError('SOL address must decode to exactly 32 bytes');
  }
  return trimmed;
}
