/**
 * Shared type definitions: account store records, upstream wire shapes,
 * client-facing adapter drafts.
 */

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
  clientId?: string
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
  consecutiveInvalidGrant?: number
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
}
