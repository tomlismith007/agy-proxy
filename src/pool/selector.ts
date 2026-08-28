/**
 * Account selection: rank usable accounts for one request. Blocked accounts
 * sink to the end (earliest unblock first); among usable ones, measured quota
 * beats unmeasured, near-exhausted ("hot") windows rank last, then lower
 * used-fraction wins. Ties keep store order so a single-account pool is stable.
 */

import type { AccountRecord } from '../types.js'
import { familyKeyOf, familyQuotaFor, isFamilyDrained } from './quota.js'

const HOT_FRACTION = 0.85

/**
 * Requests stay blocked this long AFTER a server-reported reset instant:
 * landing exactly at the boundary still trips a stale limiter shard upstream
 * and would burn another 429 + cooldown cycle (Antigravity-Manager uses the
 * same +1500ms grace).
 */
export const RESET_GRACE_MS = 1_500

export interface PoolCandidate {
  record: AccountRecord
  /** Cooldown wall blocking this account (null when usable now). */
  blockedUntil: number | null
  usedFraction?: number
  hot: boolean
  measured: boolean
  drained: boolean
}

interface Ranked extends PoolCandidate {
  order: number
}

function blockedUntilOf(record: AccountRecord, modelId: string | undefined, now: number): number | null {
  let blocked: number | null = null
  const bump = (until: number): number => until + RESET_GRACE_MS
  if (record.coolingDownUntil && bump(record.coolingDownUntil) > now) {
    blocked = bump(record.coolingDownUntil)
  }
  const familyLimit = record.rateLimitResetTimes?.[familyKeyOf(modelId)]
  if (familyLimit !== undefined && bump(familyLimit) > now) {
    blocked = blocked === null ? bump(familyLimit) : Math.max(blocked, bump(familyLimit))
  }
  // A measured zero-remaining family with a future reset blocks until that reset.
  if (blocked === null) {
    const quota = familyQuotaFor(record, familyKeyOf(modelId))
    const remaining = quota?.remainingFraction
    if (quota && typeof remaining === 'number' && remaining <= 0 && quota.resetTime) {
      const resetMs = Date.parse(quota.resetTime)
      if (!Number.isNaN(resetMs) && bump(resetMs) > now) blocked = bump(resetMs)
    }
  }
  return blocked
}

/**
 * Rank enabled accounts for a request on `modelId`. Accounts disabled in the
 * store are excluded; cooling ones are included but ranked last (the caller
 * decides whether to wait or fail when everything is blocked).
 */
export function rankAccounts(
  records: readonly AccountRecord[],
  modelId?: string,
  now = Date.now(),
): PoolCandidate[] {
  const ranked: Ranked[] = []
  let order = 0
  for (const record of records) {
    if (!record.enabled) continue
    const quota = familyQuotaFor(record, familyKeyOf(modelId))
    const remaining = quota?.remainingFraction
    const used = typeof remaining === 'number' ? Math.min(Math.max(1 - remaining, 0), 1) : undefined
    ranked.push({
      record,
      order: order++,
      blockedUntil: blockedUntilOf(record, modelId, now),
      usedFraction: used,
      hot: used !== undefined && used >= HOT_FRACTION,
      measured: used !== undefined,
      drained: isFamilyDrained(record, familyKeyOf(modelId), now),
    })
  }

  ranked.sort((a, b) => {
    const aBlocked = a.blockedUntil !== null
    const bBlocked = b.blockedUntil !== null
    if (aBlocked !== bBlocked) return aBlocked ? 1 : -1
    if (aBlocked && bBlocked) return (a.blockedUntil ?? 0) - (b.blockedUntil ?? 0)
    if (a.drained !== b.drained) return a.drained ? 1 : -1
    if (a.hot !== b.hot) return a.hot ? 1 : -1
    if (a.measured !== b.measured) return a.measured ? -1 : 1
    const usedDiff = (a.usedFraction ?? 0.5) - (b.usedFraction ?? 0.5)
    if (usedDiff !== 0) return usedDiff
    return a.order - b.order
  })

  return ranked.map(({ record, blockedUntil, usedFraction, hot, measured, drained }) => ({
    record, blockedUntil, usedFraction, hot, measured, drained,
  }))
}
