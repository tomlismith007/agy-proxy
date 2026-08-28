/**
 * Anthropic Messages response mapping (non-streaming).
 */

import { originalToolName } from '../shared/tools.js'
import { isSafetyBlock, type ParsedUpstreamResponse } from '../shared/frame.js'
import type { FormatContext } from '../shared/format-spec.js'

export type AnthropicStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal'

export function mapStopReason(
  finishReason: string | undefined,
  hasToolCalls: boolean,
): AnthropicStopReason {
  if (finishReason === 'MAX_TOKENS') return 'max_tokens'
  if (isSafetyBlock(finishReason)) return 'refusal'
  return hasToolCalls ? 'tool_use' : 'end_turn'
}

function contentBlocks(parsed: ParsedUpstreamResponse, ctx: FormatContext): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  if (parsed.thoughtText.length > 0) {
    blocks.push({ type: 'thinking', thinking: parsed.thoughtText })
  }
  if (parsed.text.length > 0) {
    blocks.push({ type: 'text', text: parsed.text })
  }
  for (const call of parsed.calls) {
    blocks.push({
      type: 'tool_use',
      id: call.id ?? `toolu_${ctx.responseId.slice(-12)}_${blocks.length}`,
      name: originalToolName(ctx.toolNameMap, call.name),
      input: call.args ?? {},
    })
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' })
  }
  return blocks
}

/** Build the Anthropic `message` object from a parsed upstream response. */
export function buildAnthropicResponse(
  parsed: ParsedUpstreamResponse,
  ctx: FormatContext,
): Record<string, unknown> {
  const stopReason = mapStopReason(parsed.finishReason, parsed.calls.length > 0)
  const usage: Record<string, number> = {
    input_tokens: parsed.usage?.promptTokenCount ?? 0,
    output_tokens: parsed.usage?.candidatesTokenCount ?? 0,
  }
  if (typeof parsed.usage?.cachedContentTokenCount === 'number') {
    usage.cache_read_input_tokens = parsed.usage.cachedContentTokenCount
  }

  return {
    id: ctx.responseId,
    type: 'message',
    role: 'assistant',
    model: ctx.requestedModel,
    content: contentBlocks(parsed, ctx),
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  }
}
