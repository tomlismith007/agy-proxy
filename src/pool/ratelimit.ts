/**
 * Rotation decisions after one failed attempt: retry / rotate / cool / fail.
 * Pure state transitions on the account record; persistence stays with the
 * caller so a decision can be applied without an extra store round-trip.
 */

import type { AccountRecord, ClassifiedError, FailureKind, RateLimitCategory } from '../types.js'
import { familyKeyOf } from './quota.js'

export const BACKOFF_TIERS_MS = [5_000, 10_000, 20_000, 30_000, 60_000] as const

/** Below this remaining fraction the family counts as soft-quota-exhausted. */
export const SOFT_QUOTA_THRESHOLD = 0.15

/** Cooldown for a fully exhausted quota window when no reset time is reported. */
export const FULL_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000
/** Default cooldown for per-minute rate limits. */
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000
/** Cap on server-reported resets for per-minute limits (guards bogus values). */
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000
/** Temporary block for Google VALIDATION_REQUIRED risk control (self-heals). */
export const VALIDATION_BLOCK_COOLDOWN_MS = 10 * 60 * 1000

function backoffFor(consecutiveFailures: number, maxJitterMs = 1_000): number {
  const index = Math.min(Math.max(consecutiveFailures, 0), BACKOFF_TIERS_MS.length - 1)
  const base = BACKOFF_TIERS_MS[index]!
  return base + Math.floor(Math.random() * maxJitterMs)
}

function parseFutureResetMs(resetTime: string | undefined, now: number): number | undefined {
  if (!resetTime) return undefined
  const reset = Date.parse(resetTime)
  if (Number.isNaN(reset) || reset <= now) return undefined
  return reset
}

/** Record a family-scoped rate-limit reset, retaining the latest time. */
export function recordRateLimit(record: AccountRecord, familyKey: string, resetAtMs: number): void {
  const current = record.rateLimitResetTimes?.[familyKey] ?? 0
  record.rateLimitResetTimes = {
    ...(record.rateLimitResetTimes ?? {}),
    [familyKey]: Math.max(current, resetAtMs),
  }
}

/** Drop expired rate-limit windows and cooldowns in place. */
export function clearExpiredState(record: AccountRecord, now = Date.now()): void {
  if (record.rateLimitResetTimes) {
    const fresh = Object.fromEntries(
      Object.entries(record.rateLimitResetTimes).filter(([, reset]) => reset > now),
    )
    record.rateLimitResetTimes = Object.keys(fresh).length > 0 ? fresh : undefined
  }
  if (record.coolingDownUntil && record.coolingDownUntil <= now) {
    record.coolingDownUntil = undefined
    record.cooldownReason = undefined
  }
}

/** Reset the failure streak after any successful exchange with upstream. */
export function markSuccess(record: AccountRecord): void {
  clearExpiredState(record)
}

export type RotationActionKind = 'retry-same' | 'rotate' | 'fail'

export interface RotationDecision {
  action: RotationActionKind
  /** Suggested wait before the next attempt (same or other account). */
  backoffMs?: number
}

/**
 * Decide what to do after one classified failure and mutate the record's
 * cooldown/rate-limit state accordingly.
 *
 * - soft_rate_limit → brief pause, retry the same account;
 * - rate_limited → cool this family until the real reset (capped), rotate;
 * - quota_exhausted → cool the whole account until the real reset (cap 24h);
 * - auth-failure → caller handles token re-confirmation first; here we only
 *   disable after that path has confirmed credentials are dead;
 * - request-error → permanent payload problem: surface to client, no rotation;
 * - network-error / transient → short backoff, rotate.
 */
export function decideRotation(
  kind: FailureKind,
  record: AccountRecord,
  options: {
    rateLimitCategory?: RateLimitCategory
    retryAfterMs?: number
    resetTime?: string
    consecutiveFailures?: number
    validationUrl?: string
  } = {},
): RotationDecision {
  const now = Date.now()
  const backoffMs = backoffFor(options.consecutiveFailures ?? 1)
  const category = options.rateLimitCategory

  switch (kind) {
    case 'rate-limit': {
      if (category === 'soft_rate_limit') {
        return { action: 'retry-same', backoffMs: Math.min(options.retryAfterMs ?? backoffMs, 3_000) }
      }
      if (category === 'quota_exhausted') {
        const resetMs = parseFutureResetMs(options.resetTime, now)
        const cooldownMs =
          resetMs !== undefined ? Math.min(resetMs - now, FULL_QUOTA_COOLDOWN_MS) : FULL_QUOTA_COOLDOWN_MS
        record.coolingDownUntil = now + Math.max(cooldownMs, 60_000)
        record.cooldownReason = 'quota exhausted'
        if (resetMs !== undefined) recordRateLimit(record, familyKeyOf(undefined), resetMs)
        return { action: 'rotate', backoffMs: Math.max(cooldownMs, 60_000) }
      }
      // Per-minute limit: prefer server reset (capped), then Retry-After, then fixed window.
      const resetMs = parseFutureResetMs(options.resetTime, now)
      const cooldownMs =
        resetMs !== undefined
          ? Math.min(resetMs - now, MAX_RATE_LIMIT_COOLDOWN_MS)
          : (options.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS)
      if (resetMs !== undefined) recordRateLimit(record, familyKeyOf(undefined), resetMs)
      else recordRateLimit(record, familyKeyOf(undefined), now + cooldownMs)
      return { action: 'rotate', backoffMs: Math.max(cooldownMs, 1_000) }
    }
    case 'auth-failure': {
      record.enabled = false
      record.verificationRequired = true
      record.verificationRequiredReason = 'upstream rejected credentials (401/403)'
      return { action: 'fail' }
    }
    case 'validation-blocked': {
      // Temporary risk control, NOT dead credentials: cool briefly and keep
      // the account enabled so it re-enters rotation automatically; the user
      // can clear the flag early via `agy-proxy verify` after validating.
      record.coolingDownUntil = now + VALIDATION_BLOCK_COOLDOWN_MS
      record.cooldownReason = 'Google requires account validation'
      record.verificationRequired = true
      record.verificationRequiredReason = 'VALIDATION_REQUIRED: re-validate in a browser, then run verify'
      if (options.validationUrl) record.validationUrl = options.validationUrl
      return { action: 'rotate', backoffMs: 2_000 }
    }
    case 'network-error': {
      record.coolingDownUntil = now + backoffMs
      record.cooldownReason = 'network error'
      return { action: 'rotate', backoffMs }
    }
    case 'request-error': {
      // Permanent: retrying resends the same broken payload.
      return { action: 'fail' }
    }
    case 'transient':
    default: {
      return { action: 'rotate', backoffMs }
    }
  }
}

/** Convenience wrapper taking a ClassifiedError directly. */
export function decideRotationFromClassified(
  classified: ClassifiedError,
  record: AccountRecord,
  consecutiveFailures = 1,
): RotationDecision {
  return decideRotation(classified.kind, record, {
    rateLimitCategory: classified.rateLimitCategory,
    retryAfterMs: classified.retryAfterMs,
    resetTime: classified.resetTime,
    consecutiveFailures,
    validationUrl: classified.validationUrl,
  })
}

/**
 * Fail-closed gate for accounts bound to their own egress proxy: connect-layer
 * failures mean THIS proxy path is dead (proxy down / wrong port), not that
 * Google rejected or rate-limited the account. Such attempts must not write
 * cooldowns or bump failure streaks — the account is skipped untouched and
 * retried unchanged next round. Without an account proxy the normal engine
 * still applies cooldowns (direct connectivity failing IS account-agnostic).
 */
export function isProxyPathOutage(kind: FailureKind, hasAccountProxy: boolean): boolean {
  return hasAccountProxy && kind === 'network-error'
}
