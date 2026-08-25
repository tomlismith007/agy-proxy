/**
 * Client-format specification contract: both /v1/chat/completions (OpenAI)
 * and /v1/messages (Anthropic) plug into the shared chat pipeline through
 * this interface.
 */

import type { ClientErrorPayload } from './errors.js'
import type { ParsedUpstreamResponse } from './frame.js'
import type { SseEvent } from '../../upstream/sse.js'
import type { AdapterDraft } from '../../types.js'

export interface ParsedClientRequest {
  draft: AdapterDraft
  stream: boolean
}

export interface FormatContext {
  /** Model id exactly as the client requested it (pre alias-remap echo). */
  requestedModel: string
  toolNameMap: Map<string, string>
  responseId: string
  /** UNIX seconds. */
  created: number
}

export interface ClientFormatSpec {
  name: 'openai' | 'anthropic'
  parse(body: unknown): Promise<ParsedClientRequest> | ParsedClientRequest
  respond(parsed: ParsedUpstreamResponse, ctx: FormatContext): Record<string, unknown>
  /** Yield ready-to-write SSE strings (frames + terminator included). */
  stream(events: AsyncGenerator<SseEvent, void, undefined>, ctx: FormatContext): AsyncGenerator<string>
  errorPayload(status: number, code: string, message: string): ClientErrorPayload
  upstreamPayload(kind: string, message: string): ClientErrorPayload
}
