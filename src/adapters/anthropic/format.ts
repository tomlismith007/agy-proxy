/** Anthropic Messages format spec. */

import { anthropicErrorPayload, upstreamErrorPayloads } from '../shared/errors.js'
import type { ClientFormatSpec, FormatContext, ParsedClientRequest } from '../shared/format-spec.js'
import type { ParsedUpstreamResponse } from '../shared/frame.js'
import { parseAnthropicMessagesRequest } from './request.js'
import { buildAnthropicResponse, newAnthropicMessageId } from './response.js'
import { streamAnthropicEvents } from './stream.js'

export const ANTHROPIC_FORMAT: ClientFormatSpec = {
  name: 'anthropic',

  parse(body: unknown): ParsedClientRequest {
    const parsed = parseAnthropicMessagesRequest(body)
    return { draft: parsed, stream: parsed.stream }
  },

  respond(parsed: ParsedUpstreamResponse, ctx: FormatContext): Record<string, unknown> {
    return buildAnthropicResponse(parsed, ctx)
  },

  stream(events, ctx) {
    return streamAnthropicEvents(events, ctx)
  },

  errorPayload(status, code, message) {
    return anthropicErrorPayload(status, code, message)
  },

  upstreamPayload(kind, message) {
    return upstreamErrorPayloads(kind, message).anthropic
  },
}

export function newAnthropicContext(requestedModel: string, toolNameMap: Map<string, string>): FormatContext {
  return {
    requestedModel,
    toolNameMap,
    responseId: newAnthropicMessageId(),
    created: Math.floor(Date.now() / 1000),
  }
}
