/**
 * Access-token lifecycle: refresh proactively before expiry, with a short
 * backoff-and-confirm pass on `invalid_grant` so one network blip or clock
 * skew never disables an account — only two consecutive confirmed failures do.
 */

import { AccountStore } from './store.js'
import { refreshAccessToken } from './oauth.js'
import type { AccountRecord } from '../types.js'
import { createLogger } from '../util/log.js'

const log = createLogger('tokens')

/** Refresh when the token expires within this window. */
const REFRESH_LEEWAY_MS = 5 * 60 * 1000

const INVALID_GRANT_BACKOFF_MS = 500

export class RefreshError extends Error {
  constructor(
    message: string,
    readonly invalidGrant: boolean,
  ) {
    super(message)
    this.name = 'RefreshError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function needsRefresh(record: AccountRecord, force: boolean, now: number): boolean {
  if (force) return true
  if (!record.accessToken) return true
  if (!record.expiresAt) return true
  return record.expiresAt - now < REFRESH_LEEWAY_MS
}

/**
 * Return a usable access token for the account, refreshing through the store
 * when missing/expiring (or when `force`). Throws RefreshError when the
 * refresh token is dead; the account is then disabled in the store.
 */
export async function ensureFreshAccessToken(
  store: AccountStore,
  email: string,
  options: { force?: boolean } = {},
): Promise<string> {
  const record = store.get(email)
  if (!record) throw new RefreshError(`account not found: ${email}`, false)
  const now = Date.now()
  if (!needsRefresh(record, options.force === true, now)) {
    return record.accessToken!
  }

  const attempt = async (): Promise<string> => {
    const grant = await refreshAccessToken(record.refreshToken)
    store.update(email, (r) => {
      r.accessToken = grant.accessToken
      r.refreshToken = grant.refreshToken ?? r.refreshToken
      r.expiresAt = grant.expiresAt
      r.lastRefreshAt = Date.now()
      r.consecutiveInvalidGrant = 0
      r.verificationRequired = false
      r.verificationRequiredReason = undefined
      r.enabled = true
    })
    return grant.accessToken
  }

  try {
    return await attempt()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('invalid_grant')) {
      throw new RefreshError(`token refresh failed: ${message}`, false)
    }
    // Confirm once after a short backoff before disabling the account.
    log.warn(`invalid_grant for ${email}; confirming after ${INVALID_GRANT_BACKOFF_MS}ms`)
    await sleep(INVALID_GRANT_BACKOFF_MS)
    try {
      return await attempt()
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
      if (retryMessage.includes('invalid_grant')) {
        log.error(`invalid_grant confirmed twice for ${email}; disabling account`)
        store.update(email, (r) => {
          r.enabled = false
          r.verificationRequired = true
          r.verificationRequiredReason = 'refresh token revoked (invalid_grant)'
          r.consecutiveInvalidGrant = 2
        })
        throw new RefreshError(`refresh token revoked for ${email}: ${retryMessage}`, true)
      }
      throw new RefreshError(`token refresh failed: ${retryMessage}`, false)
    }
  }
}
