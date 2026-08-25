/**
 * Model-family quota accounting: family mapping, aggregation of
 * fetchAvailableModels quotaInfo per family, staleness TTLs.
 */

import { SOFT_QUOTA_THRESHOLD } from './ratelimit.js'
import type { AccountRecord, CachedQuota, DiscoveredModels } from '../types.js'

export type ModelFamily = 'google' | 'anthropic' | 'openai'

/** Bucket for ids with no recognizable prefix. */
export const FAMILY_UNKNOWN = 'unknown'

export function modelFamilyOf(modelId?: string): ModelFamily | undefined {
  if (!modelId) return undefined
  const id = modelId.toLowerCase()
  if (id.startsWith('claude-')) return 'anthropic'
  if (id.startsWith('gemini-') || id.startsWith('gemma-')) return 'google'
  if (id.startsWith('gpt-') || id.startsWith('openai/')) return 'openai'
  return undefined
}

export function familyKeyOf(modelId: string | undefined): string {
  return modelFamilyOf(modelId) ?? FAMILY_UNKNOWN
}

function earliestResetTime(a?: string, b?: string): string | undefined {
  if (!a) return b
  if (!b) return a
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta)) return b
  if (Number.isNaN(tb)) return a
  return ta <= tb ? a : b
}

/**
 * Aggregate a discovery response into per-family records: the family's
 * remaining fraction is its most-pressured model's; reset time is the
 * earliest across the family (the bottleneck resets first).
 */
export function ingestFamilyQuotas(discovered: DiscoveredModels): Record<string, CachedQuota> {
  const families = new Map<string, CachedQuota>()
  for (const [modelId, entry] of Object.entries(discovered.models ?? {})) {
    const remaining = entry.quotaInfo?.remainingFraction
    if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue
    const key = familyKeyOf(modelId)
    const current = families.get(key)
    const resetTime = earliestResetTime(current?.resetTime, entry.quotaInfo?.resetTime)
    families.set(key, {
      remainingFraction: current ? Math.min(current.remainingFraction ?? 1, remaining) : remaining,
      ...(resetTime ? { resetTime } : {}),
      modelCount: (current?.modelCount ?? 0) + 1,
    })
  }
  return Object.fromEntries(families)
}

export function familyQuotaFor(record: AccountRecord, family?: string): CachedQuota | undefined {
  const cache = record.cachedQuota ?? {}
  if (family) return cache[family]
  let worst: CachedQuota | undefined
  for (const entry of Object.values(cache)) {
    if (typeof entry.remainingFraction !== 'number') continue
    if (!worst || entry.remainingFraction < (worst.remainingFraction ?? 1)) worst = entry
  }
  return worst
}

function quotaCacheTtlMs(remainingFraction: number | undefined): number {
  if (typeof remainingFraction !== 'number') return 10 * 60 * 1000
  if (remainingFraction < SOFT_QUOTA_THRESHOLD) return 60 * 1000
  if (remainingFraction < 0.5) return 5 * 60 * 1000
  return 15 * 60 * 1000
}

/** Whether the cached quota needs a refresh (missing or past its TTL). */
export function isQuotaStale(record: AccountRecord, now = Date.now()): boolean {
  if (!record.cachedQuota || !record.cachedQuotaUpdatedAt) return true
  return now - record.cachedQuotaUpdatedAt > quotaCacheTtlMs(familyQuotaFor(record)?.remainingFraction)
}

/** Whether the requested family is soft-quota-exhausted on this account. */
export function isFamilyDrained(record: AccountRecord, family?: string, now = Date.now()): boolean {
  const quota = familyQuotaFor(record, family)
  if (!quota || typeof quota.remainingFraction !== 'number') return false
  if (quota.resetTime) {
    const reset = Date.parse(quota.resetTime)
    if (!Number.isNaN(reset) && reset <= now) return false
  }
  return quota.remainingFraction < SOFT_QUOTA_THRESHOLD
}
