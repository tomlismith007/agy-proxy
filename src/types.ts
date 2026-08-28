/**
 * Shared type definitions: account store records, upstream wire shapes,
 * client-facing adapter drafts, and the runtime AppContext.
 */

import type { AppConfig } from './config.js'
import type { AccountStore } from './auth/store.js'
import type { Semaphore } from './util/concurrency.js'
import type { UsageHistory } from './util/usage-history.js'

// ---------------------------------------------------------------------------
// Account store
// ---------------------------------------------------------------------------

export interface QuotaInfo {
  remainingFraction?: number
  resetTime?: string
}

export interface CachedQuota extends QuotaInfo {
  /** Number of models aggregated into this family record. */
  modelCount?: number
}

export interface DiscoveredModelEntry {
  quotaInfo?: QuotaInfo
  displayName?: string
  modelName?: string
}

export interface DiscoveredModels {
  models?: Record<string, DiscoveredModelEntry>
}

export interface AccountRecord {
  email: string
  refreshToken: string
  projectId?: string
  tierId?: string
  /** OAuth client secret used for token refresh; stored encrypted so later
   * refreshes never depend on a shell env var being present. */
  clientSecret?: string
  /**
   * Per-account egress proxy (http/https URL). When set, every upstream call
   * for this account dispatches through it instead of the global proxy, so
   * each account keeps its own IP identity. Only ever surfaced masked.
   */
  proxyUrl?: string
  accessToken?: string
  /** Absolute epoch ms when the access token expires. */
  expiresAt?: number
  createdAt: number
  lastRefreshAt?: number
  enabled: boolean
  coolingDownUntil?: number
  cooldownReason?: string
  /** Family-keyed rate-limit reset times (epoch ms). */
  rateLimitResetTimes?: Record<string, number>
  cachedQuota?: Record<string, CachedQuota>
  cachedQuotaUpdatedAt?: number
  verificationRequired?: boolean
  verificationRequiredReason?: string
  /** Google validation link captured from a VALIDATION_REQUIRED (403) response. */
  validationUrl?: string
  consecutiveInvalidGrant?: number
  /** Last health-probe outcome (background loop + manual verify). */
  lastHealthAt?: number
  lastHealthOk?: boolean
  lastHealthError?: string
}

// ---------------------------------------------------------------------------
// Upstream v1internal wire shapes (subset we produce / consume)
// ---------------------------------------------------------------------------

export interface UpstreamInlineData {
  mimeType: string
  data: string
}

export interface UpstreamFunctionCall {
  id?: string
  name: string
  args?: unknown
}

export interface UpstreamFunctionResponse {
  id?: string
  /** Optional: the backend binds results by id; name is best-effort. */
  name?: string
  response?: unknown
}

export interface UpstreamPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: UpstreamInlineData
  functionCall?: UpstreamFunctionCall
  functionResponse?: UpstreamFunctionResponse
}

export interface UpstreamContent {
  role: 'user' | 'model'
  parts: UpstreamPart[]
}

export interface UpstreamSchema {
  type?: string
  format?: string
  title?: string
  description?: string
  nullable?: boolean
  items?: UpstreamSchema
  enum?: string[]
  default?: unknown
  properties?: Record<string, UpstreamSchema>
  required?: string[]
  additionalProperties?: boolean | UpstreamSchema
}

export interface FunctionDeclaration {
  name: string
  description?: string
  parameters?: UpstreamSchema
}

export interface ThinkingConfig {
  thinkingLevel?: 'low' | 'medium' | 'high'
  includeThoughts?: boolean
}

export interface GenerationConfig {
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  thinkingConfig?: ThinkingConfig
}

export interface UpstreamRequest {
  contents: UpstreamContent[]
  systemInstruction?: { parts: { text: string }[] }
  tools?: { functionDeclarations: FunctionDeclaration[] }[]
  toolConfig?: { functionCallingConfig: { mode: string } }
  generationConfig?: GenerationConfig
  sessionId?: string
}

export interface Envelope {
  project?: string
  requestId: string
  model: string
  userAgent: 'antigravity'
  requestType: 'agent'
  request: UpstreamRequest
}

export interface UsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
  thoughtsTokenCount?: number
  cachedContentTokenCount?: number
}

export interface UpstreamCandidate {
  content?: { parts?: UpstreamPart[]; role?: string }
  finishReason?: string
}

export interface UpstreamResponse {
  candidates?: UpstreamCandidate[]
  usageMetadata?: UsageMetadata
  modelVersion?: string
  responseId?: string
}

// ---------------------------------------------------------------------------
// Adapter drafts (client-format-agnostic intermediate representation)
// ---------------------------------------------------------------------------

export interface AdapterDraft {
  model: string
  systemInstructionText?: string
  contents: UpstreamContent[]
  declarations?: FunctionDeclaration[]
  /** sanitized name -> original client-visible name */
  toolNameMap?: Map<string, string>
  generationConfig: GenerationConfig
  /** thinkingLevel requested for level-thinking models ('low'|'medium'|'high'). */
  reasoningEffort?: 'low' | 'medium' | 'high'
}

export interface FinalizedCall {
  envelope: Envelope
  toolNameMap: Map<string, string>
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type FailureKind =
  | 'rate-limit'
  | 'auth-failure'
  | 'validation-blocked'
  | 'network-error'
  | 'request-error'
  | 'transient'

export type RateLimitCategory = 'soft_rate_limit' | 'rate_limited' | 'quota_exhausted' | 'unknown'

export interface ClassifiedError {
  kind: FailureKind
  status?: number
  retryAfterMs?: number
  resetTime?: string
  message?: string
  rateLimitCategory?: RateLimitCategory
  /** Set on validation-blocked failures: where the user must re-validate. */
  validationUrl?: string
  /** Undici connect-layer code from the cause chain (ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT, …). */
  connectCode?: string
}

// ---------------------------------------------------------------------------
// Runtime context (defined here so lower layers can depend on it without
// reaching up into the api/ composition layer)
// ---------------------------------------------------------------------------

export interface AppContext {
  config: AppConfig
  store: AccountStore
  /** Bounds simultaneous upstream calls (risk-control pacing). */
  upstreamGate: Semaphore
  /** Persistent per-day usage history backing the admin console's daily view. */
  usage: UsageHistory
}
