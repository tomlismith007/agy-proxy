/** Typed client for the gateway's /admin/* JSON API + small format helpers. */

export interface Overview {
  version: string
  uptimeSeconds: number
  host: string
  port: number
  dataDir: string
  loopback: boolean
  accounts: { total: number; enabled: number }
  paused: boolean
  proxy: string | null
  maxConcurrentUpstream: number
  activeUpstreamRequests: number
  apiKeyTail: string
  debugLog: boolean
}

export interface FamilyQuota {
  remainingFraction?: number
  resetTime?: string
  modelCount?: number
}

/** One model's live quota from the account detail endpoint (/admin/quota/detail). */
export interface QuotaModelEntry {
  id: string
  name: string
  family: string
  remaining: number | null
  resetTime?: string
}

export interface QuotaDetail {
  email: string
  source: 'cache' | 'live'
  models: QuotaModelEntry[]
}

export interface AccountRec {
  email: string
  projectId?: string
  tierId?: string
  enabled: boolean
  createdAt: number
  lastRefreshAt?: number
  expiresAt?: number
  coolingDownUntil?: number
  cooldownReason?: string
  rateLimitResetTimes?: Record<string, number>
  cachedQuota?: Record<string, FamilyQuota>
  cachedQuotaUpdatedAt?: number
  verificationRequired?: boolean
  verificationRequiredReason?: string
  validationUrl?: string
  /** Masked per-account egress proxy (`protocol//host:port`); null when unbound. */
  proxyMasked: string | null
  lastHealthAt?: number
  lastHealthOk?: boolean
  lastHealthError?: string
}

export interface ModelEntry {
  id: string
  display_name: string
  context_length?: number
  max_output_tokens?: number
  supports_reasoning: boolean
  supports_vision: boolean
  tool_calling: boolean
  quota_remaining?: number
  quota_reset?: string
}

export interface RequestStat {
  time: number
  format: string
  model: string
  account?: string
  status: number
  ok: boolean
  latencyMs: number
  stream?: boolean
  promptTokens?: number
  outputTokens?: number
  thoughtsTokens?: number
  error?: string
}

export interface StatsSnapshot {
  startedAt: number
  totals: {
    requests: number
    success: number
    failures: number
    promptTokens: number
    outputTokens: number
    thoughtsTokens: number
  }
  byFormat: Record<string, { requests: number; failures: number }>
  recent: RequestStat[]
}

export interface UsageTotals {
  requests: number
  success: number
  failures: number
  promptTokens: number
  outputTokens: number
  thoughtsTokens: number
}

/** Hourly trend bucket inside one persisted day. */
export interface UsageHourBucket {
  requests: number
  promptTokens: number
  outputTokens: number
  thoughtsTokens: number
}

/** One persisted day of usage history (GET /admin/usage/day). */
export interface DayUsage {
  version: number
  date: string
  totals: UsageTotals
  byFormat: Record<string, UsageTotals>
  byModel: Record<string, UsageTotals>
  byAccount: Record<string, UsageTotals>
  byHour: UsageHourBucket[]
  updatedAt: number
}

/** Reduced day entry from GET /admin/usage/days. */
export interface DayUsageSummary {
  date: string
  totals: UsageTotals
  updatedAt: number
}

export interface GatewayConfig {
  host: string
  port: number
  debugLog: boolean
  onlyRealModels: boolean
  modelAliases: Record<string, string>
  proxy: string | null
  maxConcurrentUpstream: number
  killSwitch: boolean
  apiKeyTail: string
  apiKeyFull: string | null
  /** Named gateway keys; keyFull only present when the listener is loopback-bound. */
  apiKeys: ApiKeyRec[]
  restartRequiredFields: string[]
}

export interface ApiKeyRec {
  name: string
  keyTail: string
  keyFull: string | null
}

export type LoginPhase = 'idle' | 'waiting' | 'exchanging' | 'success' | 'error'

export interface LoginStatus {
  phase: LoginPhase
  url?: string
  email?: string
  projectId?: string
  tierId?: string
  error?: string
}

export interface TestChatResult {
  ok: boolean
  account?: string
  latencyMs?: number
  text?: string
  thoughtText?: string
  finishReason?: string
  modelVersion?: string
  usage?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
  kind?: string
  error?: string
}

export class ApiError extends Error {
  status: number
  data?: unknown

  constructor(message: string, status: number, data?: unknown) {
    super(message)
    this.status = status
    this.data = data
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers:
        init?.body !== undefined ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
    })
  } catch (e) {
    throw new ApiError(`网络请求失败：${e instanceof Error ? e.message : String(e)}`, 0)
  }
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string } | string } | null)?.error
    const message =
      (typeof err === 'string' ? err : err?.message) ??
      (data as { message?: string } | null)?.message ??
      `HTTP ${res.status}`
    throw new ApiError(message, res.status, data)
  }
  return data as T
}

export const get = <T>(path: string): Promise<T> => api<T>(path)
export const post = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
export const patch = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) })

// ------------------------------------------------------------------ format --

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  const abs = Math.abs(ms)
  if (abs >= 86_400_000) return `${Math.floor(abs / 86_400_000)}d ${Math.floor((abs % 86_400_000) / 3_600_000)}h`
  if (abs >= 3_600_000) return `${Math.floor(abs / 3_600_000)}h ${Math.floor((abs % 3_600_000) / 60_000)}m`
  if (abs >= 60_000) return `${Math.floor(abs / 60_000)}m`
  return `${Math.max(1, Math.floor(abs / 1000))}s`
}

export function fmtUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return (h ? `${h}h ` : '') + (m || h ? `${m}m ` : '') + `${s}s`
}

export function fmtTokens(n: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

export function fmtContext(tokens?: number): string {
  if (!tokens) return '—'
  return (tokens / 1_048_576).toFixed(tokens % 1_048_576 ? 1 : 0) + 'M'
}

export const FAMILY_LABELS: Record<string, string> = {
  google: 'Google / Gemini',
  anthropic: 'Claude',
  openai: 'GPT / OSS',
  unknown: '其他配额族',
}
