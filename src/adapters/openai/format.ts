/** OpenAI Chat Completions format spec. */

import { openAiErrorPayload, upstreamErrorPayloads } from '../shared/errors.js'
import type { ClientFormatSpec, FormatContext, ParsedClientRequest } from '../shared/format-spec.js'
import type { ParsedUpstreamResponse } from '../shared/frame.js'
import { parseOpenAiChatRequest } from './request.js'
import { buildOpenAiResponse, newChatCompletionId } from './response.js'
import { streamOpenAiChunks } from './stream.js'

export const OPENAI_FORMAT: ClientFormatSpec = {
  name: 'openai',

  async parse(body: unknown): Promise<ParsedClientRequest> {
    const parsed = await parseOpenAiChatRequest(body)
    return { draft: parsed, stream: parsed.stream }
  },

  respond(parsed: ParsedUpstreamResponse, ctx: FormatContext): Record<string, unknown> {
    return buildOpenAiResponse(parsed, ctx)
  },

  stream(events, ctx) {
    return streamOpenAiChunks(events, ctx)
  },

  errorPayload(status, code, message) {
    return openAiErrorPayload(status, code, message)
  },

  upstreamPayload(kind, message) {
    return upstreamErrorPayloads(kind, message).openai
  },
}

export function newOpenAiContext(requestedModel: string, toolNameMap: Map<string, string>): FormatContext {
  return {
    requestedModel,
    toolNameMap,
    responseId: newChatCompletionId(),
    created: Math.floor(Date.now() / 1000),
  }
}
