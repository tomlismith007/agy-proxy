/**
 * Post-login bootstrap: resolve the account's Cloud Code project id (and tier)
 * via `v1internal:loadCodeAssist`, onboarding brand-new accounts through
 * `v1internal:onboardUser` when no project exists yet.
 *
 * Ban-safety: onboarding retries are bounded with jittered delays — a fixed
 * fast loop reads as scripted automation upstream.
 */

import { AGY_ENDPOINT_FALLBACKS } from '../upstream/endpoints.js'
import { getBootstrapUserAgent, getClientMetadataHeader } from '../upstream/fingerprint.js'
import { safeFetch } from '../util/urlguard.js'
import { firstSuccessful, sleep } from '../util/concurrency.js'
import { createLogger } from '../util/log.js'

const log = createLogger('bootstrap')

const FETCH_TIMEOUT_MS = 15_000

interface CodeAssistData {
  cloudaicompanionProject?: unknown
  subscriptionInfo?: unknown
}

/** Only `ideType` is accepted by the backend's enum validation. */
function bootstrapMetadata(): Record<string, string> {
  return { ideType: 'ANTIGRAVITY' }
}

function extractProjectId(data: CodeAssistData): string {
  const project = data.cloudaicompanionProject
  if (typeof project === 'string' && project) return project
  const record = project as { id?: string } | undefined
  return record && typeof record.id === 'string' ? record.id : ''
}

type TierSource = 'name' | 'id'

function tierOf(value: unknown, field: TierSource): string | null {
  const record = value as Record<string, unknown> | undefined
  const picked = record?.[field]
  return typeof picked === 'string' && picked.trim() !== '' ? picked.trim() : null
}

/** Subscription tier id for onboardUser: paid → current → default allowed → legacy. */
export function extractOnboardTierId(subscriptionInfo: unknown): string {
  const subscription = (subscriptionInfo ?? {}) as Record<string, unknown>
  const paidId = tierOf(subscription.paidTier, 'id')
  if (paidId) return paidId
  const ineligible = Array.isArray(subscription.ineligibleTiers) && subscription.ineligibleTiers.length > 0
  if (!ineligible) {
    const currentId = tierOf(subscription.currentTier, 'id')
    if (currentId) return currentId
  }
  if (Array.isArray(subscription.allowedTiers)) {
    for (const tierValue of subscription.allowedTiers) {
      const defaultId = tierOf((tierValue as Record<string, unknown>).isDefault === true ? tierValue : undefined, 'id')
      if (defaultId) return defaultId
    }
  }
  const fallbackCurrent = tierOf(subscription.currentTier, 'id')
  return fallbackCurrent ?? 'legacy-tier'
}

function bootstrapHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': getBootstrapUserAgent(),
    'Client-Metadata': getClientMetadataHeader(),
  }
}

export interface BootstrapResult {
  projectId: string
  tierId: string
}

/** Resolve project + tier via loadCodeAssist across fallback endpoints. */
export async function loadCodeAssist(accessToken: string, proxyUrl?: string): Promise<BootstrapResult> {
  const headers = bootstrapHeaders(accessToken)
  const body = JSON.stringify({ metadata: bootstrapMetadata() })
  const result = await firstSuccessful(AGY_ENDPOINT_FALLBACKS, async (base) => {
    try {
      const response = await safeFetch(`${base}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers,
        body,
        timeoutMs: FETCH_TIMEOUT_MS,
        ...(proxyUrl ? { agyProxy: proxyUrl } : {}),
      })
      if (!response.ok) return undefined
      const data = (await response.json()) as CodeAssistData
      const projectId = extractProjectId(data)
      if (!projectId) return undefined
      return { projectId, tierId: extractOnboardTierId(data.subscriptionInfo) }
    } catch {
      return undefined // try the next endpoint
    }
  })
  return result ?? { projectId: '', tierId: 'legacy-tier' }
}

/**
 * Onboard an account without a Cloud Code project, then retry discovery.
 * Bounded: 3 attempts, each after a fresh 3–7s jittered delay (a fixed
 * interval reads as scripted automation upstream).
 */
export async function onboardAndDiscoverProject(
  accessToken: string,
  tierId: string,
  proxyUrl?: string,
): Promise<BootstrapResult> {
  const headers = bootstrapHeaders(accessToken)
  const body = JSON.stringify({ tier_id: tierId, metadata: bootstrapMetadata() })
  const maxAttempts = 3

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const retryDelayMs = 3000 + Math.floor(Math.random() * 4000)
    const discovered = await firstSuccessful(AGY_ENDPOINT_FALLBACKS, async (base) => {
      try {
        const response = await safeFetch(`${base}/v1internal:onboardUser`, {
          method: 'POST',
          headers,
          body,
          timeoutMs: FETCH_TIMEOUT_MS,
          ...(proxyUrl ? { agyProxy: proxyUrl } : {}),
        })
        if (!response.ok) return undefined
        const result = (await response.json()) as { done?: boolean }
        if (result.done !== true) return undefined
        const found = await loadCodeAssist(accessToken, proxyUrl)
        return found.projectId ? found : undefined
      } catch {
        return undefined // transient — retried after the jittered delay
      }
    })
    if (discovered) return discovered
    if (attempt < maxAttempts - 1) await sleep(retryDelayMs)
  }
  log.warn('onboarding did not complete within bounded attempts')
  return { projectId: '', tierId }
}

/** Full bootstrap for a fresh login: discover project, onboard when needed. */
export async function bootstrapAccount(accessToken: string, proxyUrl?: string): Promise<BootstrapResult> {
  const discovered = await loadCodeAssist(accessToken, proxyUrl)
  if (discovered.projectId) return discovered
  log.info('no Cloud Code project found; attempting onboarding')
  return onboardAndDiscoverProject(accessToken, discovered.tierId, proxyUrl)
}
