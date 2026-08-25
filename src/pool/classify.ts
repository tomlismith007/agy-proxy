/**
 * Upstream failure classification: HTTP status + headers + body → FailureKind.
 * Conservative: only auth-failure may disable an account; everything else
 * cools, rotates or retries.
 */

import type { ClassifiedError, RateLimitCategory } from '../types.js'

const QUOTA_EXHAUSTED_KEYWORDS = [
  'quota_exhausted',
  'quota exhausted',
  'quota reached',
  'enable overages',
  'individual quota',
]

/** 429 body → sub-category. */
export function classifyRateLimit(
  bodyText: string | undefined,
  retryAfterMs: number | undefined,
): RateLimitCategory {
  const text = (bodyText ?? '').toLowerCase()
  if (QUOTA_EXHAUSTED_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return 'quota_exhausted'
  }
  if (retryAfterMs !== undefined && retryAfterMs < 3000) return 'soft_rate_limit'
  if (retryAfterMs !== undefined) return 'rate_limited'
  return text.includes('quota') || text.includes('resource_exhausted') ? 'quota_exhausted' : 'unknown'
}

const RESET_FIELDS = ['resetTime', 'reset_time', 'resetAt', 'quotaResetTime'] as const

function extractResetTime(bodyText: string | undefined): string | undefined {
  if (!bodyText) return undefined
  try {
    const data = JSON.parse(bodyText) as Record<string, unknown>
    for (const field of RESET_FIELDS) {
      const value = data[field]
      if (typeof value === 'string' && value) return value
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 1_000_000_000_000 ? new Date(value).toISOString() : new Date(Date.now() + value * 1000).toISOString()
      }
    }
    const quotaInfo = data.quotaInfo as Record<string, unknown> | undefined
    if (quotaInfo && typeof quotaInfo.resetTime === 'string') return quotaInfo.resetTime
  } catch {
    // not JSON — no reset info
  }
  return undefined
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

/** Classify a completed non-2xx response. */
export function classifyHttpError(status: number, headers: Headers, bodyText?: string): ClassifiedError {
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'))
  const resetTime = extractResetTime(bodyText)
  const snippet = bodyText ? bodyText.slice(0, 300) : undefined

  if (status === 429) {
    return { kind: 'rate-limit', rateLimitCategory: classifyRateLimit(bodyText, retryAfterMs), status, retryAfterMs, resetTime, message: snippet }
  }
  if (status === 401) {
    return { kind: 'auth-failure', status, message: snippet }
  }
  if (status === 403) {
    // Google also reports quota walls as 403 RESOURCE_EXHAUSTED, and the
    // endpoint fallback chain ends on hosts answering 403 for "no license".
    // Only treat 403 as auth failure when there is no quota wording.
    const category = classifyRateLimit(bodyText, undefined)
    if (category === 'quota_exhausted') {
      return { kind: 'rate-limit', rateLimitCategory: category, status, resetTime, message: snippet }
    }
    return { kind: 'auth-failure', status, message: snippet }
  }
  if (status === 404) {
    return { kind: 'transient', status, message: snippet }
  }
  if (status >= 500) {
    return { kind: 'transient', status, retryAfterMs, message: snippet }
  }
  if (status === 400) {
    // Generic 400s are permanent request-construction errors; only capacity
    // phrases are recoverable.
    const text = (bodyText ?? '').toLowerCase()
    const recoverable =
      (text.includes('context') && (text.includes('overflow') || text.includes('too long') || text.includes('exceeded'))) ||
      (text.includes('model') && (text.includes('not found') || text.includes('unavailable') || text.includes('not supported')))
    if (recoverable) return { kind: 'transient', status, message: snippet }
    return { kind: 'request-error', status, message: snippet }
  }
  return { kind: 'transient', status, message: snippet }
}

/** Classify a fetch-level failure (DNS, refused, timeout, abort). */
export function classifyFetchError(error: unknown): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof Error && error.name === 'TimeoutError') {
    return { kind: 'network-error', message }
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { kind: 'network-error', message }
  }
  return { kind: 'network-error', message }
}

/** Error carrying its classification so the pool can act on it. */
export class ClassifiedUpstreamError extends Error {
  readonly kind: ClassifiedError['kind']
  readonly status?: number
  readonly rateLimitCategory?: RateLimitCategory
  readonly retryAfterMs?: number
  readonly resetTime?: string

  constructor(classified: ClassifiedError) {
    super(classified.message ?? classified.kind)
    this.name = 'ClassifiedUpstreamError'
    this.kind = classified.kind
    this.status = classified.status
    this.rateLimitCategory = classified.rateLimitCategory
    this.retryAfterMs = classified.retryAfterMs
    this.resetTime = classified.resetTime
  }
}
