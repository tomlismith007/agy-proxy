/**
 * Anthropic streaming: upstream SSE events -> the strict Anthropic event
 * lifecycle (message_start / content_block_start / *_delta / content_block_stop
 * / message_delta / message_stop). Consecutive text parts merge into one open
 * text block; each tool call becomes its own tool_use block fed by
 * input_json_delta.
 */

import { rememberSignature } from '../shared/thinking.js'
import { decodeStreamFrame } from '../shared/frame.js'
import { originalToolName } from '../shared/tools.js'
import { upstreamErrorPayloads, type ClientErrorPayload } from '../shared/errors.js'
import { mapStopReason } from './response.js'
import type { SseEvent } from '../../upstream/sse.js'
import type { FormatContext } from '../shared/format-spec.js'

type OpenBlock =
  | { kind: 'text'; index: number }
  | { kind: 'thinking'; index: number }
  | { kind: 'tool_use'; index: number; id: string; name: string }

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function errorEvent(payload: ClientErrorPayload): string {
  return frame('error', payload.body)
}

/** Consume upstream SSE events and yield ready-to-write Anthropic SSE strings. */
export async function* streamAnthropicEvents(
  events: AsyncGenerator<SseEvent, void, undefined>,
  ctx: FormatContext,
): AsyncGenerator<string> {
  yield frame('message_start', {
    type: 'message_start',
    message: {
      id: ctx.responseId,
      type: 'message',
      role: 'assistant',
      model: ctx.requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
  yield frame('ping', { type: 'ping' })

  let nextIndex = 0
  let open: OpenBlock | null = null

  let finishReasonRaw: string | undefined
  let sawToolCall = false
  let outputTokens = 0
  let inputTokens = 0
  let cacheReadTokens: number | undefined

  try {
    for await (const event of events) {
      if (!event.data) continue
      const decoded = decodeStreamFrame(event.data)

      if (decoded.type === 'error') {
        yield errorEvent(upstreamErrorPayloads('transient', decoded.message).anthropic)
        return
      }
      if (decoded.type === 'usage') {
        outputTokens = decoded.usage.candidatesTokenCount ?? outputTokens
        if (decoded.finishReason) finishReasonRaw = decoded.finishReason
        continue
      }
      if (decoded.type !== 'parts') {
        // Only 'empty' remains here; it may still carry a bare finishReason.
        if (decoded.type === 'empty' && decoded.finishReason) {
          finishReasonRaw = decoded.finishReason
        }
        continue
      }

      for (const part of decoded.parts) {
        if (part.functionCall !== undefined) {
          // Close any open text/thinking block before the tool_use block.
          if (open) {
            yield frame('content_block_stop', { type: 'content_block_stop', index: open.index })
            open = null
          }
          const callId = part.functionCall.id ?? `toolu_${ctx.responseId.slice(-12)}_${nextIndex}`
          if (part.thoughtSignature) rememberSignature(callId, part.thoughtSignature)
          const name = originalToolName(ctx.toolNameMap, part.functionCall.name)
          const index = nextIndex++
          open = { kind: 'tool_use', index, id: callId, name }
          sawToolCall = true
          yield frame('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: callId, name, input: {} },
          })
          yield frame('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.functionCall.args ?? {}) },
          })
          continue
        }
        if (typeof part.text !== 'string' || part.text.length === 0) continue

        const wantKind: 'thinking' | 'text' = part.thought === true ? 'thinking' : 'text'
        if (!open || open.kind !== wantKind) {
          if (open) {
            yield frame('content_block_stop', { type: 'content_block_stop', index: open.index })
          }
          const index = nextIndex++
          open = wantKind === 'text' ? { kind: 'text', index } : { kind: 'thinking', index }
          yield frame('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: wantKind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
          })
        }
        yield frame('content_block_delta', {
          type: 'content_block_delta',
          index: open.index,
          delta:
            wantKind === 'text'
              ? { type: 'text_delta', text: part.text }
              : { type: 'thinking_delta', thinking: part.text },
        })
      }

      if (decoded.usage) {
        outputTokens = decoded.usage.candidatesTokenCount ?? outputTokens
        inputTokens = decoded.usage.promptTokenCount ?? inputTokens
        cacheReadTokens = decoded.usage.cachedContentTokenCount ?? cacheReadTokens
      }
      if (decoded.finishReason) finishReasonRaw = decoded.finishReason
    }

    if (open) {
      yield frame('content_block_stop', { type: 'content_block_stop', index: open.index })
      open = null
    }

    const usageDelta: Record<string, number> = { output_tokens: outputTokens }
    if (inputTokens > 0) usageDelta.input_tokens = inputTokens
    if (typeof cacheReadTokens === 'number') usageDelta.cache_read_input_tokens = cacheReadTokens

    yield frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapStopReason(finishReasonRaw, sawToolCall), stop_sequence: null },
      usage: usageDelta,
    })
    yield frame('message_stop', { type: 'message_stop' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    yield errorEvent(upstreamErrorPayloads('network-error', `upstream stream interrupted: ${message}`).anthropic)
  }
}
