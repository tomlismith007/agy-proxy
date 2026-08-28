/**
 * Process-wide start-to-start pacing between upstream generation attempts.
 * The concurrency semaphore bounds parallelism; this bounds instantaneous
 * request rate — a burst of back-to-back calls is itself a risk-control
 * signal even when each call is small (Antigravity-Manager runs a 500ms
 * global rate limiter for the same reason). Default 300ms; disable or tune
 * with AGY_MIN_INTERVAL_MS (0 = off).
 */

import { sleep } from './concurrency.js'

const DEFAULT_MIN_INTERVAL_MS = 300

function resolveMinInterval(): number {
  const raw = process.env.AGY_MIN_INTERVAL_MS?.trim()
  if (raw !== undefined && raw !== '') {
    const value = Number(raw)
    if (Number.isFinite(value)) return Math.max(0, Math.trunc(value))
  }
  return DEFAULT_MIN_INTERVAL_MS
}

export const MIN_INTERVAL_MS = resolveMinInterval()

let lastStartAt = 0

/**
 * Reserve the next start slot and wait until it arrives. Slots are allocated
 * at call time, so N concurrent callers space out FIFO one interval apart —
 * they never all fire on the same tick after a shared wake-up.
 */
export async function paceUpstreamCall(now = Date.now()): Promise<void> {
  if (MIN_INTERVAL_MS <= 0) return
  const earliest = lastStartAt + MIN_INTERVAL_MS
  const wait = Math.max(0, earliest - now)
  lastStartAt = Math.max(now, earliest)
  if (wait > 0) await sleep(wait)
}

/** Test-only: forget pacing history. */
export function resetPacer(): void {
  lastStartAt = 0
}
