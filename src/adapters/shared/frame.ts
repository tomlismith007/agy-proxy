/**
 * Upstream payload decoding shared by both client formats:
 * - SSE frame JSON -> parts/usage/finishReason (or an embedded error);
 * - full generation response -> a flat parsed shape adapters map from.
 */

import { randomUUID } from 'node:crypto'
import { rememberSignature } from './thinking.js'
import type {
  UpstreamCandidate,
  UpstreamPart,
  UpstreamResponse,
  UsageMetadata,
} from '../../types.js'

export interface DecodedPartsFrame {
  type: 'parts'
  parts: UpstreamPart[]
  usage?: UsageMetadata
  finishReason?: string
}

export interface DecodedUsageOnlyFrame {
  type: 'usage'
  usage: UsageMetadata
  /** Final frames often carry only usage + finishReason together. */
  finishReason?: string
}

export interface DecodedEmptyFrame {
  type: 'empty'
  finishReason?: string
}

export interface DecodedErrorFrame {
  type: 'error'
  message: string
}

export type DecodedFrame = DecodedPartsFrame | DecodedUsageOnlyFrame | DecodedEmptyFrame | DecodedErrorFrame

interface RawStreamChunk {
  error?: unknown
  candidates?: UpstreamCandidate[]
  usageMetadata?: UsageMetadata
}

/** Strip the upstream `{response: …}` wrapper if present (shared with client.ts). */
export function unwrapResponseEnvelope<T>(raw: T): T {
  if (raw && typeof raw === 'object') {
    const inner = (raw as Partial<Record<'response', T>>).response
    if (inner !== undefined) return inner
  }
  return raw
}

function extractErrorMessage(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.message === 'string') return record.message
  const status = record.status ?? record.code
  if (status !== undefined) return `${String(status)}: ${String(record.message ?? record.status)}`
  return undefined
}

/** Decode one `data:` frame of the upstream SSE channel. */
export function decodeStreamFrame(data: string): DecodedFrame {
  let chunk: RawStreamChunk
  try {
    chunk = unwrapResponseEnvelope(JSON.parse(data) as RawStreamChunk)
  } catch {
    return { type: 'empty' }
  }

  if (chunk.error !== undefined && chunk.error !== null) {
    return { type: 'error', message: extractErrorMessage(chunk.error) ?? JSON.stringify(chunk.error) }
  }

  const usage = chunk.usageMetadata
  const candidate = chunk.candidates?.[0]
  const parts = candidate?.content?.parts
  if (Array.isArray(parts) && parts.length > 0) {
    return { type: 'parts', parts, ...(usage ? { usage } : {}), ...(candidate!.finishReason ? { finishReason: candidate!.finishReason } : {}) }
  }
  if (usage) {
    return {
      type: 'usage',
      usage,
      ...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}),
    }
  }
  if (candidate?.finishReason) {
    return { type: 'empty', finishReason: candidate.finishReason }
  }
  return { type: 'empty' }
}

// ---------------------------------------------------------------------------
// Non-streaming response parsing
// ---------------------------------------------------------------------------

export interface ParsedFunctionCall {
  id?: string
  name: string
  args?: Record<string, unknown>
}

export interface ParsedUpstreamResponse {
  /** Concatenated non-thought text. */
  text: string
  /** Concatenated thought-part text (defensive; thoughts are rarely streamed). */
  thoughtText: string
  calls: ParsedFunctionCall[]
  usage?: UsageMetadata
  finishReason?: string
  modelVersion?: string
  responseId?: string
}

function collectFromParts(parts: readonly UpstreamPart[], parsed: ParsedUpstreamResponse): void {
  for (const part of parts) {
    if (part.functionCall !== undefined) {
      parsed.calls.push({
        ...(part.functionCall.id ? { id: part.functionCall.id } : {}),
        name: part.functionCall.name,
        args: part.functionCall.args as Record<string, unknown> | undefined,
      })
      // Capture + remember the signature bound to this call id.
      if (part.thoughtSignature) {
        rememberSignature(part.functionCall.id, part.thoughtSignature)
      }
      continue
    }
    if (typeof part.text === 'string' && part.text.length > 0) {
      if (part.thought === true) parsed.thoughtText += part.text
      else parsed.text += part.text
    }
  }
}

function emptyParsed(): ParsedUpstreamResponse {
  return { text: '', thoughtText: '', calls: [] }
}

/** Flatten a non-streaming generation response; remembers tool signatures. */
export function parseUpstreamResponse(response: UpstreamResponse): ParsedUpstreamResponse {
  const parsed = emptyParsed()
  for (const candidate of response.candidates ?? []) {
    if (candidate.content?.parts) collectFromParts(candidate.content.parts, parsed)
    if (candidate.finishReason && !parsed.finishReason) parsed.finishReason = candidate.finishReason
  }
  parsed.usage = response.usageMetadata
  parsed.modelVersion = response.modelVersion
  parsed.responseId = response.responseId
  return parsed
}

const SAFETY_FINISH_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'RECITATION', 'BLOCKLIST'])

/** Upstream reasons meaning the model was blocked for safety/policy. */
export function isSafetyBlock(finishReason: string | undefined): boolean {
  return finishReason !== undefined && SAFETY_FINISH_REASONS.has(finishReason)
}

/** Short opaque id with a prefix (response + tool-call ids share this shape). */
export function opaqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

/**
 * Map an upstream finishReason to the OpenAI-style triad used across both
 * formats (`stop` / `length` / `content_filter`).
 */
export function normalizedFinishReason(finishReason: string | undefined): 'stop' | 'length' | 'content_filter' {
  if (finishReason === 'MAX_TOKENS') return 'length'
  if (isSafetyBlock(finishReason)) return 'content_filter'
  return 'stop'
}
