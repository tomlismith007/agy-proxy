/**
 * Session affinity: pin the account that just served a request so an ongoing
 * conversation keeps hitting the same upstream identity for the affinity
 * window. This keeps upstream prefix caches warm (cache hits are keyed by the
 * per-account sessionId) and avoids account-hopping mid-conversation — both a
 * quota cost and a risk-control signal. Mirrors dsh-agy's 10-minute window.
 *
 * Single global slot by design: this is a personal local gateway, requests
 * arriving within the window almost always belong to the same active session.
 */

const AFFINITY_WINDOW_MS = 10 * 60_000

let pinned: { email: string; at: number } | null = null

/** Pin an account as the affinity target — call after it served successfully. */
export function pinAccount(email: string): void {
  if (!email) return
  if (pinned && pinned.email === email) {
    pinned.at = Date.now()
    return
  }
  pinned = { email, at: Date.now() }
}

/**
 * Return the pinned account email while the window is live, else null
 * (dropping the stale pin). Purely advisory — the caller still validates that
 * the account is enabled, unblocked and not drained before honoring it.
 */
export function takeAffinity(now = Date.now()): string | null {
  if (!pinned) return null
  if (now - pinned.at > AFFINITY_WINDOW_MS) {
    pinned = null
    return null
  }
  return pinned.email
}

/** Drop the pin — after a classified failure on `email`, or unconditionally. */
export function clearAffinity(email?: string): void {
  if (!pinned) return
  if (email === undefined || pinned.email === email) pinned = null
}

/**
 * Reorder ranked candidates so the pinned account leads — but only when it is
 * actually usable right now (unblocked, not drained); otherwise ranking stands.
 * Mutates and returns the same array (the pipeline treats it as throwaway).
 */
export function applyAffinity<
  T extends { record: { email: string }; blockedUntil: number | null; drained: boolean },
>(ranked: T[], now = Date.now()): T[] {
  const email = takeAffinity(now)
  if (!email) return ranked
  const idx = ranked.findIndex((candidate) => candidate.record.email === email)
  if (idx <= 0) return ranked
  const pick = ranked[idx]!
  if (pick.blockedUntil !== null || pick.drained) return ranked
  ranked.splice(idx, 1)
  ranked.unshift(pick)
  return ranked
}

/** Test-only: forget all affinity state. */
export function resetAffinity(): void {
  pinned = null
}
