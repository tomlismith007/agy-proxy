/**
 * Upstream payload decoding shared by both client formats:
 * - SSE frame JSON -> parts/usage/finishReason (or an embedded error);
 * - full generation response -> a flat parsed shape adapters map from.
 */

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
    chunk = JSON.parse(data) as RawStreamChunk
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

/**
 * Map an upstream finishReason to the OpenAI-style triad used across both
 * formats (`stop` / `length` / `content_filter`).
 */
export function normalizedFinishReason(finishReason: string | undefined): 'stop' | 'length' | 'content_filter' {
  switch (finishReason) {
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'RECITATION':
    case 'BLOCKLIST':
      return 'content_filter'
    default:
      return 'stop'
  }
}
