/** OpenAI Chat Completions format spec. */

import { openAiErrorPayload, upstreamErrorPayloads } from '../shared/errors.js'
import type { ClientFormatSpec, ParsedClientRequest } from '../shared/format-spec.js'
import { parseOpenAiChatRequest } from './request.js'
import { buildOpenAiResponse } from './response.js'
import { streamOpenAiChunks } from './stream.js'

export const OPENAI_FORMAT: ClientFormatSpec = {
  name: 'openai',

  async parse(body: unknown): Promise<ParsedClientRequest> {
    const parsed = await parseOpenAiChatRequest(body)
    return { draft: parsed, stream: parsed.stream }
  },

  respond(parsed, ctx) {
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
