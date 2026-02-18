import { principalCV, serializeCV } from '@stacks/transactions';

import type { PipeKey } from './types.js';

function parseHexBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Uint8Array.from(Buffer.from(normalized, 'hex'));
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const minLength = Math.min(left.length, right.length);
  for (let index = 0; index < minLength; index += 1) {
    if (left[index] < right[index]) {
      return -1;
    }
    if (left[index] > right[index]) {
      return 1;
    }
  }

  if (left.length < right.length) {
    return -1;
  }
  if (left.length > right.length) {
    return 1;
  }

  return 0;
}

export function normalizeHex(input: string): string {
  const value = input.trim();
  return value.startsWith('0x') ? value.toLowerCase() : `0x${value.toLowerCase()}`;
}

export function isValidHex(input: string, bytes?: number): boolean {
  const value = normalizeHex(input);
  if (!/^0x[0-9a-f]+$/i.test(value)) {
    return false;
  }

  if (bytes === undefined) {
    return (value.length - 2) % 2 === 0;
  }

  return value.length === bytes * 2 + 2;
}

export function hexToBytes(input: string): Uint8Array {
  return parseHexBytes(normalizeHex(input));
}

export function parseOptionalUInt(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  return parseUInt(value);
}

export function parseUInt(value: unknown): string {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new Error('value must be a uint');
    }
    return value.toString(10);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error('value must be a uint');
    }
    return String(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('value must be a uint');
    }
    return BigInt(trimmed).toString(10);
  }

  throw new Error('value must be a uint');
}

export function splitContractId(contractId: string): {
  address: string;
  name: string;
} {
  const dot = contractId.indexOf('.');
  if (dot <= 0 || dot === contractId.length - 1) {
    throw new Error('invalid contract id');
  }

  return {
    address: contractId.slice(0, dot),
    name: contractId.slice(dot + 1),
  };
}

export function canonicalPipeKey(
  token: string | null,
  leftPrincipal: string,
  rightPrincipal: string,
): PipeKey {
  if (leftPrincipal === rightPrincipal) {
    throw new Error('forPrincipal and withPrincipal must be different');
  }

  const leftBytes = parseHexBytes(serializeCV(principalCV(leftPrincipal)));
  const rightBytes = parseHexBytes(serializeCV(principalCV(rightPrincipal)));

  if (compareBytes(leftBytes, rightBytes) <= 0) {
    return {
      token,
      'principal-1': leftPrincipal,
      'principal-2': rightPrincipal,
    };
  }

  return {
    token,
    'principal-1': rightPrincipal,
    'principal-2': leftPrincipal,
  };
}

export function parsePrincipal(input: unknown, fieldName: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error(`${fieldName} must be a principal string`);
  }

  const value = input.trim();
  principalCV(value);
  return value;
}
