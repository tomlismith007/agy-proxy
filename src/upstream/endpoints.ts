/**
 * Upstream endpoint fallback chain. Consumer OAuth accounts get RESOURCE_
 * EXHAUSTED/403 from the production host; the daily runtime answers 200.
 * Order matters: first non-429/403 response wins.
 */

import { safeFetch } from '../util/urlguard.js'
import { paceUpstreamCall } from '../util/pacer.js'

const AGY_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.googleapis.com'
const AGY_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com'
const AGY_ENDPOINT_DAILY_SANDBOX = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
const AGY_ENDPOINT_AUTOPUSH = 'https://autopush-cloudcode-pa.sandbox.googleapis.com'

export const AGY_ENDPOINT_FALLBACKS: readonly string[] = [
  AGY_ENDPOINT_DAILY,
  AGY_ENDPOINT_PROD,
  AGY_ENDPOINT_DAILY_SANDBOX,
  AGY_ENDPOINT_AUTOPUSH,
]

/** Statuses meaning "this endpoint is not usable for this account" → try the next. */
const ENDPOINT_SKIP_STATUSES = new Set([429, 403])

export interface EndpointAttempt {
  response: Response
  baseEndpoint: string
}

/**
 * POST `path` against each fallback endpoint in order. Returns the first
 * response that is not a skip-status (2xx or a real error like 400/401);
 * when every endpoint skips, returns the last skipped response so callers can
 * still classify it. `externalSignal` (client disconnect) is combined with
 * the per-attempt timeout. `opts.proxyUrl` honors a per-account proxy binding.
 */
export async function postAcrossEndpoints(
  path: string,
  buildInit: () => RequestInit,
  timeoutMs = 120_000,
  externalSignal?: AbortSignal,
  opts?: { proxyUrl?: string },
): Promise<EndpointAttempt> {
  let lastSkipped: Response | null = null
  let lastSkippedBase = ''
  for (const baseEndpoint of AGY_ENDPOINT_FALLBACKS) {
    if (externalSignal?.aborted) throw new DOMException('aborted by caller', 'AbortError')
    // Pace BEFORE arming the per-attempt timeout so the wait doesn't eat
    // into the request's own time budget.
    await paceUpstreamCall()
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal =
      externalSignal !== undefined && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([timeoutSignal, externalSignal])
        : timeoutSignal
    try {
      const response = await safeFetch(`${baseEndpoint}${path}`, {
        ...buildInit(),
        signal,
        ...(opts?.proxyUrl ? { agyProxy: opts.proxyUrl } : {}),
      })
      if (!ENDPOINT_SKIP_STATUSES.has(response.status)) {
        return { response, baseEndpoint }
      }
      lastSkipped = response
      lastSkippedBase = baseEndpoint
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw error
      // network error — try next endpoint
    }
  }
  if (lastSkipped) return { response: lastSkipped, baseEndpoint: lastSkippedBase }
  throw new Error('all Antigravity endpoints failed')
}
