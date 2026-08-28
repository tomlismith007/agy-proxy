/**
 * OpenAI streaming: upstream SSE events -> `chat.completion.chunk` frames
 * terminated by `[DONE]`. Tool calls are emitted whole per part (clients
 * assemble them by index); usage rides on a final empty-choices chunk.
 */

import { rememberSignature } from '../shared/thinking.js'
import { decodeStreamFrame, normalizedFinishReason } from '../shared/frame.js'
import { originalToolName } from '../shared/tools.js'
import { upstreamErrorPayloads, type ClientErrorPayload } from '../shared/errors.js'
import { mapUsage } from './response.js'
import type { SseEvent } from '../../upstream/sse.js'
import type { FormatContext } from '../shared/format-spec.js'

function chunkFrame(ctx: FormatContext, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: ctx.responseId,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.requestedModel,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
  })}\n\n`
}

function errorChunk(payload: ClientErrorPayload): string {
  return `data: ${JSON.stringify(payload.body)}\n\n`
}

/** Consume upstream SSE events and yield ready-to-write OpenAI SSE strings. */
export async function* streamOpenAiChunks(
  events: AsyncGenerator<SseEvent, void, undefined>,
  ctx: FormatContext,
): AsyncGenerator<string> {
  yield chunkFrame(ctx, { role: 'assistant', content: '' }, null)

  let toolCallIndex = 0
  let finishReason: string | null = null
  let lastUsage: ReturnType<typeof mapUsage> | undefined

  const applyFinish = (raw: string | undefined): void => {
    if (!raw) return
    finishReason = toolCallIndex > 0 && raw === 'STOP' ? 'tool_calls' : normalizedFinishReason(raw)
  }

  try {
    for await (const event of events) {
      if (!event.data) continue
      const decoded = decodeStreamFrame(event.data)

      if (decoded.type === 'error') {
        yield errorChunk(upstreamErrorPayloads('transient', decoded.message).openai)
        yield 'data: [DONE]\n\n'
        return
      }
      if (decoded.type !== 'parts') {
        if (decoded.type === 'usage') lastUsage = mapUsage(decoded.usage)
        applyFinish(decoded.finishReason)
        continue
      }

      for (const part of decoded.parts) {
        if (part.functionCall !== undefined) {
          const callId = part.functionCall.id ?? `call_${toolCallIndex}`
          if (part.thoughtSignature) rememberSignature(callId, part.thoughtSignature)
          yield chunkFrame(
            ctx,
            {
              tool_calls: [
                {
                  index: toolCallIndex,
                  id: callId,
                  type: 'function',
                  function: {
                    name: originalToolName(ctx.toolNameMap, part.functionCall.name),
                    arguments: JSON.stringify(part.functionCall.args ?? {}),
                  },
                },
              ],
            },
            null,
          )
          toolCallIndex += 1
          continue
        }
        if (typeof part.text !== 'string' || part.text.length === 0) continue
        if (part.thought === true) {
          yield chunkFrame(ctx, { reasoning_content: part.text }, null)
        } else {
          yield chunkFrame(ctx, { content: part.text }, null)
        }
      }

      if (decoded.usage) lastUsage = mapUsage(decoded.usage)
      applyFinish(decoded.finishReason)
    }

    yield chunkFrame(ctx, {}, finishReason)
    if (lastUsage) {
      yield `data: ${JSON.stringify({
        id: ctx.responseId,
        object: 'chat.completion.chunk',
        created: ctx.created,
        model: ctx.requestedModel,
        choices: [],
        usage: lastUsage,
      })}\n\n`
    }
    yield 'data: [DONE]\n\n'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (finishReason === null) {
      yield errorChunk(upstreamErrorPayloads('network-error', `upstream stream interrupted: ${message}`).openai)
    }
    yield 'data: [DONE]\n\n'
  }
}
