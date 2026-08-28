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

async function fetchJson(url: string, init: RequestInit, proxyUrl?: string): Promise<Response> {
  return safeFetch(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...(proxyUrl ? { agyProxy: proxyUrl } : {}),
  })
}

export interface BootstrapResult {
  projectId: string
  tierId: string
}

/** Resolve project + tier via loadCodeAssist across fallback endpoints. */
export async function loadCodeAssist(accessToken: string, proxyUrl?: string): Promise<BootstrapResult> {
  const headers = bootstrapHeaders(accessToken)
  for (const base of AGY_ENDPOINT_FALLBACKS) {
    try {
      const response = await fetchJson(
        `${base}/v1internal:loadCodeAssist`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ metadata: bootstrapMetadata() }),
        },
        proxyUrl,
      )
      if (!response.ok) continue
      const data = (await response.json()) as CodeAssistData
      const projectId = extractProjectId(data)
      if (projectId) {
        return { projectId, tierId: extractOnboardTierId(data.subscriptionInfo) }
      }
    } catch {
      // try the next endpoint
    }
  }
  return { projectId: '', tierId: 'legacy-tier' }
}

/**
 * Onboard an account without a Cloud Code project, then retry discovery.
 * Bounded: 3 attempts with a 3–7s jittered delay.
 */
export async function onboardAndDiscoverProject(
  accessToken: string,
  tierId: string,
  proxyUrl?: string,
): Promise<BootstrapResult> {
  const headers = bootstrapHeaders(accessToken)
  const metadata = bootstrapMetadata()
  const maxAttempts = 3
  const retryDelayMs = 3000 + Math.floor(Math.random() * 4000)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      for (const base of AGY_ENDPOINT_FALLBACKS) {
        const response = await fetchJson(
          `${base}/v1internal:onboardUser`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ tier_id: tierId, metadata }),
          },
          proxyUrl,
        )
        if (!response.ok) continue
        const result = (await response.json()) as { done?: boolean }
        if (result.done === true) {
          const discovered = await loadCodeAssist(accessToken, proxyUrl)
          if (discovered.projectId) return discovered
        }
      }
    } catch {
      // transient — retry after delay
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
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
