/**
 * Model discovery with a short-lived per-account id cache, shared by the
 * public /v1/models endpoint, the admin console and quota refresh. Falls back
 * to the pinned catalog when no account can serve a live discovery call.
 */

import type { AppContext, DiscoveredModelEntry, DiscoveredModels } from '../types.js'
import { AGY_PUBLIC_MODELS, isChatCallableModelId } from './catalog.js'
import { fetchAvailableModels } from './client.js'
import { ensureFreshAccessToken } from '../auth/tokens.js'
import { familyKeyOf, ingestFamilyQuotas } from '../util/quota.js'
import { firstSuccessful } from '../util/concurrency.js'
import { createLogger, errText } from '../util/log.js'

const log = createLogger('discovery')

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000

interface CacheSlot {
  ids: string[]
  entries: Record<string, DiscoveredModelEntry>
  updatedAt: number
}

/** email -> last successful discovery (module scope: one process, one cache). */
const modelIdCache = new Map<string, CacheSlot>()

export interface DiscoveryResult {
  ids: string[]
  source: 'discovered' | 'catalog'
  /** Per-model quota/display info from the live discovery response. */
  entries: Record<string, DiscoveredModelEntry>
}

async function discoverForAccount(
  ctx: AppContext,
  email: string,
  projectId?: string,
): Promise<DiscoveredModels> {
  const accessToken = await ensureFreshAccessToken(ctx.store, email)
  // Discovery shares the account's egress proxy binding so quota reads leave
  // the same IP identity as generation.
  return fetchAvailableModels(
    { accessToken, accountKey: email, proxyUrl: ctx.store.get(email)?.proxyUrl },
    projectId,
  )
}

/** Live discovery across enabled accounts (freshest quota cache first). */
export async function discoverModels(ctx: AppContext): Promise<DiscoveryResult> {
  const accounts = ctx.store
    .list()
    .filter((r) => r.enabled)
    .sort((a, b) => (b.cachedQuotaUpdatedAt ?? 0) - (a.cachedQuotaUpdatedAt ?? 0))

  const found = await firstSuccessful(accounts, async (record): Promise<DiscoveryResult | undefined> => {
    const cached = modelIdCache.get(record.email)
    if (cached && Date.now() - cached.updatedAt < MODEL_CACHE_TTL_MS) {
      return { ids: cached.ids, source: 'discovered', entries: cached.entries }
    }
    try {
      const discovered = await discoverForAccount(ctx, record.email, record.projectId)
      const entries = discovered.models ?? {}
      const ids = Object.keys(entries).filter(isChatCallableModelId)
      if (ids.length === 0) return undefined
      modelIdCache.set(record.email, { ids, entries, updatedAt: Date.now() })
      return { ids, source: 'discovered', entries }
    } catch (error) {
      log.warn(`model discovery failed for ${record.email}: ${errText(error)}; trying next account`)
      return undefined
    }
  })

  return (
    found ?? {
      ids: AGY_PUBLIC_MODELS.map((m) => m.id),
      source: 'catalog',
      entries: {},
    }
  )
}

/**
 * Force-refresh one account's family quotas (and its discovery cache entry).
 * Returns the ingested per-family quota map.
 */
export async function refreshAccountQuota(
  ctx: AppContext,
  email: string,
): Promise<{ families: ReturnType<typeof ingestFamilyQuotas>; modelCount: number }> {
  const record = ctx.store.get(email)
  if (!record) throw new Error(`account not found: ${email}`)
  const discovered = await discoverForAccount(ctx, email, record.projectId)
  const families = ingestFamilyQuotas(discovered)
  const updatedAt = Date.now()
  ctx.store.update(email, (r) => {
    r.cachedQuota = families
    r.cachedQuotaUpdatedAt = updatedAt
  })

  const entries = discovered.models ?? {}
  const ids = Object.keys(entries).filter(isChatCallableModelId)
  if (ids.length > 0) {
    modelIdCache.set(email, { ids, entries, updatedAt })
  }
  return { families, modelCount: Object.keys(entries).length }
}

export interface AccountQuotaModel {
  id: string
  name: string
  /** Same bucketing as cachedQuota families (familyKeyOf), so the console can
   * expand a family row into exactly these entries. */
  family: string
  remaining: number | null
  resetTime?: string
}

/**
 * Per-model quota detail for one account. Serves the fresh per-account
 * discovery cache (filled by quota refresh / discovery) and only pays a live
 * upstream call when it is missing or older than MODEL_CACHE_TTL_MS.
 */
export async function accountQuotaDetail(
  ctx: AppContext,
  email: string,
): Promise<{ source: 'cache' | 'live'; models: AccountQuotaModel[] }> {
  const record = ctx.store.get(email)
  if (!record) throw new Error(`account not found: ${email}`)
  if (!record.enabled) throw new Error('账号已停用，请先启用后再查看模型明细')

  const cached = modelIdCache.get(email)
  let entries: Record<string, DiscoveredModelEntry>
  let source: 'cache' | 'live'
  if (cached && Date.now() - cached.updatedAt < MODEL_CACHE_TTL_MS) {
    entries = cached.entries
    source = 'cache'
  } else {
    const discovered = await discoverForAccount(ctx, email, record.projectId)
    entries = discovered.models ?? {}
    source = 'live'
    const ids = Object.keys(entries).filter(isChatCallableModelId)
    if (ids.length > 0) modelIdCache.set(email, { ids, entries, updatedAt: Date.now() })
  }

  // Worst-first so the pressured models are visible without scrolling.
  const models = Object.entries(entries)
    .filter(([id]) => isChatCallableModelId(id))
    .map(([id, entry]) => ({
      id,
      name: entry.displayName ?? id,
      family: familyKeyOf(id),
      remaining:
        typeof entry.quotaInfo?.remainingFraction === 'number' && Number.isFinite(entry.quotaInfo.remainingFraction)
          ? entry.quotaInfo.remainingFraction
          : null,
      resetTime: entry.quotaInfo?.resetTime,
    }))
    .sort((a, b) => (a.remaining ?? 2) - (b.remaining ?? 2))
  return { source, models }
}

/** Build the client-facing model entry, merging catalog metadata with live discovery. */
export function modelEntry(
  id: string,
  discovered?: Record<string, DiscoveredModelEntry>,
): Record<string, unknown> {  const meta = AGY_PUBLIC_MODELS.find((m) => m.id === id)
  const dynamic = discovered?.[id]
  const remaining = dynamic?.quotaInfo?.remainingFraction
  return {
    id,
    object: 'model',
    type: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'antigravity',
    display_name: dynamic?.displayName ?? meta?.name ?? id,
    ...(meta ? { context_length: meta.contextLength, max_output_tokens: meta.maxOutputTokens } : {}),
    supports_reasoning: meta?.supportsReasoning ?? true,
    supports_vision: meta?.supportsVision ?? true,
    tool_calling: meta?.toolCalling ?? true,
    ...(typeof remaining === 'number'
      ? {
          quota_remaining: Math.round(remaining * 1000) / 1000,
          ...(dynamic?.quotaInfo?.resetTime ? { quota_reset: dynamic.quotaInfo.resetTime } : {}),
        }
      : {}),
  }
}
