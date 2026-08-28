/** Anthropic Messages format spec. */

import { anthropicErrorPayload, upstreamErrorPayloads } from '../shared/errors.js'
import type { ClientFormatSpec, ParsedClientRequest } from '../shared/format-spec.js'
import { parseAnthropicMessagesRequest } from './request.js'
import { buildAnthropicResponse } from './response.js'
import { streamAnthropicEvents } from './stream.js'

export const ANTHROPIC_FORMAT: ClientFormatSpec = {
  name: 'anthropic',

  parse(body: unknown): ParsedClientRequest {
    const parsed = parseAnthropicMessagesRequest(body)
    return { draft: parsed, stream: parsed.stream }
  },

  respond(parsed, ctx) {
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
