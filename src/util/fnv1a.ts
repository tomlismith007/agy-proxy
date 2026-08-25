/**
 * Antigravity request/session identity helpers.
 * requestId: `agent/<epoch>/<8 hex>` per upstream call;
 * sessionId: stable negative numeric string derived per account so upstream
 * context caching keys consistently across turns.
 */

import { randomBytes } from 'node:crypto'

export function generateAntigravityRequestId(): string {
  return `agent/${Date.now()}/${randomBytes(4).toString('hex')}`
}

const FNV_OFFSET_I64 = -3_750_763_044_362_895_579n
const FNV_PRIME_I64 = 1_099_511_628_211n

/** 64-bit FNV-1a hash of a string (stable across processes). */
export function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET_I64
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i))
    hash = BigInt.asIntN(64, hash * FNV_PRIME_I64)
  }
  return hash
}

const SESSION_TARGET = 9_000_000_000_000_000_000n

/** Stable per-account session id (`-<0..9e18>`); empty input gets a fresh random id. */
export function deriveAntigravitySessionId(accountKey: string | null | undefined): string {
  if (!accountKey || accountKey.trim().length === 0) return generateRandomSessionId()
  const hash = fnv1a64(accountKey.trim())
  const folded = hash < 0n ? -hash : hash
  return `-${(folded % SESSION_TARGET).toString()}`
}

/** Uniformly random session id in `-{0..9e18}` via rejection sampling. */
export function generateRandomSessionId(): string {
  const max = 18_446_744_073_709_551_615n // 2^64 - 1
  const limit = max - (max % SESSION_TARGET)
  let value: bigint
  do {
    value = randomBytes(8).readBigUInt64BE()
  } while (value >= limit)
  return `-${(value % SESSION_TARGET).toString()}`
}
