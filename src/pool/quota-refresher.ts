/**
 * Background loop keeping cached family quotas fresh so usage-aware account
 * selection works during normal serving, not only after a manual admin-panel
 * refresh. Ticks periodically and refreshes accounts whose quota cache is past
 * its health-based TTL (pool/quota isQuotaStale). A failing account backs off
 * per-account instead of being re-probed every tick.
 *
 * Risk-control posture: one discovery call per stale account per pass,
 * serialized with jittered inter-account delays — never a parallel fan-out.
 */

import type { AppContext } from '../api/chat-handler.js'
import { refreshAccountQuota } from '../upstream/discovery.js'
import { isQuotaStale } from './quota.js'
import { createLogger } from '../util/log.js'

const log = createLogger('quota')

const TICK_INTERVAL_MS = 30_000
/** Minimum gap before re-probing an account whose refresh just failed. */
const FAILURE_RETRY_MS = 60_000
/** Jittered pause between refreshing different accounts in one pass. */
const INTER_ACCOUNT_DELAY_MS = 1_500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface QuotaRefresher {
  stop(): void
}

export function startQuotaRefresher(ctx: AppContext): QuotaRefresher {
  let stopped = false
  let running = false
  const lastFailedAttemptAt = new Map<string, number>()

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const stale = ctx.store
        .list()
        .filter((r) => r.enabled && isQuotaStale(r))
      for (const record of stale) {
        if (stopped) return
        const failedAt = lastFailedAttemptAt.get(record.email)
        if (failedAt !== undefined && Date.now() - failedAt < FAILURE_RETRY_MS) continue
        try {
          await refreshAccountQuota(ctx, record.email)
          lastFailedAttemptAt.delete(record.email)
          log.debug(`background quota refresh ok: ${record.email}`)
        } catch (error) {
          lastFailedAttemptAt.set(record.email, Date.now())
          log.warn(
            `background quota refresh failed for ${record.email}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        // Spread accounts out; a burst of discovery calls is its own signal.
        await sleep(INTER_ACCOUNT_DELAY_MS + Math.floor(Math.random() * 1_000))
      }
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), TICK_INTERVAL_MS)
  timer.unref?.()
  void tick()
  log.debug(`quota refresher started (tick ${TICK_INTERVAL_MS / 1000}s)`)
  return {
    stop(): void {
      stopped = true
      clearInterval(timer)
    },
  }
}
