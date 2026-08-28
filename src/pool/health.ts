/**
 * Account health probing: force-refresh credentials, re-check Cloud Code
 * project access, and clear recoverable bad state. Shared by the admin verify
 * endpoint (manual), the CLI `health` command, and the background loop.
 *
 * Ban-safety: probing IS upstream traffic (a forced token exchange + a
 * loadCodeAssist call). Dead credentials must not be hammered on a timer, so
 * per-account probe state gates automatic probes: consecutive failures pause
 * them and same-account probes are spaced out. Manual verifies bypass the
 * gate — explicit user intent wins.
 */

import type { AccountRecord } from '../types.js'
import type { AccountStore } from '../auth/store.js'
import { ensureFreshAccessToken } from '../auth/tokens.js'
import { loadCodeAssist } from '../auth/bootstrap.js'
import { createLogger } from '../util/log.js'

const log = createLogger('health')

export interface VerifyResult {
  ok: boolean
  email: string
  projectId?: string
  tierId?: string
  error?: string
}

/** Auto-probing pauses for an account after this many consecutive failures. */
export const MAX_AUTO_CONSECUTIVE_FAILURES = 5

/** Minimum spacing between two automatic probes of the same account. */
export const MIN_PROBE_SPACING_MS = 10 * 60_000

/** Default cadence of the background health loop (AGY_HEALTH_INTERVAL_MS). */
export const DEFAULT_HEALTH_INTERVAL_MS = 30 * 60_000

interface ProbeState {
  consecutiveFailures: number
  lastProbeAt: number
}

const probeStateByEmail = new Map<string, ProbeState>()

function noteProbeResult(email: string, ok: boolean, now = Date.now()): void {
  const state = probeStateByEmail.get(email) ?? { consecutiveFailures: 0, lastProbeAt: 0 }
  state.lastProbeAt = now
  state.consecutiveFailures = ok ? 0 : state.consecutiveFailures + 1
  probeStateByEmail.set(email, state)
}

/** Test-only: forget all probe bookkeeping. */
export function resetHealthState(): void {
  probeStateByEmail.clear()
}

/** Whether the background loop may auto-probe this account right now. */
export function autoProbeAllowed(email: string, now = Date.now()): boolean {
  const state = probeStateByEmail.get(email)
  if (!state) return true
  if (state.consecutiveFailures >= MAX_AUTO_CONSECUTIVE_FAILURES) return false
  return now - state.lastProbeAt >= MIN_PROBE_SPACING_MS
}

/**
 * Accounts worth probing in an automatic pass: flagged for verification or
 * disabled by a confirmed credential failure, minus anything currently gated
 * by the safety valve. With `all`, every account qualifies (CLI status view).
 */
export function pickProbeTargets(
  store: AccountStore,
  options: { all?: boolean } = {},
): AccountRecord[] {
  const now = Date.now()
  return store.list().filter((record) => {
    if (!options.all && record.enabled && record.verificationRequired !== true) return false
    return autoProbeAllowed(record.email, now)
  })
}

/**
 * Force-refresh credentials and re-check project access for one account. On
 * success, persist refreshed identity info and clear recoverable bad state:
 * - verification-required / invalid-grant markers (refresh succeeded),
 * - a live VALIDATION_REQUIRED self-heal cooldown (credentials demonstrably
 *   work again — no reason to sit out the rest of the 10-minute block;
 *   quota/network cooldowns are NOT touched, only validation ones).
 */
export async function verifyAccount(store: AccountStore, email: string): Promise<VerifyResult> {
  const record = store.get(email)
  if (!record) return { ok: false, email, error: `未找到账号: ${email}` }
  const wasValidationCooling =
    record.coolingDownUntil !== undefined &&
    record.coolingDownUntil > Date.now() &&
    record.cooldownReason?.includes('validation') === true
  try {
    const accessToken = await ensureFreshAccessToken(store, email, { force: true })
    const assist = await loadCodeAssist(accessToken, record.proxyUrl)
    if (!assist.projectId) {
      const message = '凭据有效但未解析到 project（账号可能尚未开通 Cloud Code）'
      noteProbeResult(email, false)
      store.update(email, (r) => {
        r.lastHealthAt = Date.now()
        r.lastHealthOk = false
        r.lastHealthError = message
      })
      return { ok: false, email, error: message }
    }
    store.update(email, (r) => {
      r.projectId = assist.projectId
      r.tierId = assist.tierId
      r.verificationRequired = false
      r.verificationRequiredReason = undefined
      r.enabled = true
      r.consecutiveInvalidGrant = 0
      r.lastHealthAt = Date.now()
      r.lastHealthOk = true
      r.lastHealthError = undefined
      if (wasValidationCooling) {
        r.coolingDownUntil = undefined
        r.cooldownReason = undefined
      }
    })
    noteProbeResult(email, true)
    log.info(`health probe ${email}: ok`)
    return { ok: true, email, projectId: assist.projectId, tierId: assist.tierId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    noteProbeResult(email, false)
    store.update(email, (r) => {
      r.lastHealthAt = Date.now()
      r.lastHealthOk = false
      r.lastHealthError = message
    })
    log.info(`health probe ${email}: fail (${message})`)
    return { ok: false, email, error: message }
  }
}

// ---------------------------------------------------------------------------
// Background loop
// ---------------------------------------------------------------------------

export interface HealthLoop {
  stop(): void
}

function resolveIntervalMs(): number {
  const raw = process.env.AGY_HEALTH_INTERVAL_MS?.trim()
  if (raw !== undefined && raw !== '') {
    const value = Number(raw)
    if (Number.isFinite(value)) return Math.max(0, Math.trunc(value))
  }
  return DEFAULT_HEALTH_INTERVAL_MS
}

/**
 * Background prober mirroring the quota/version refresher lifecycle: one pass
 * at startup over accounts needing attention, then once per interval (0
 * disables the schedule). Each pass skips safety-valve-gated accounts, spaces
 * probes 2s apart within the pass, and never throws while serving.
 */
export function startHealthLoop(store: AccountStore): HealthLoop {
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  const probePass = async (): Promise<void> => {
    const candidates = pickProbeTargets(store)
    for (const record of candidates) {
      if (stopped) return
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      await verifyAccount(store, record.email)
    }
  }

  const run = (): void => {
    void probePass().catch((error) => {
      log.warn(`health pass aborted: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  run()
  const intervalMs = resolveIntervalMs()
  if (intervalMs > 0) {
    timer = setInterval(() => {
      if (!stopped) run()
    }, intervalMs)
    timer.unref?.()
  }

  return {
    stop(): void {
      stopped = true
      if (timer) clearInterval(timer)
    },
  }
}