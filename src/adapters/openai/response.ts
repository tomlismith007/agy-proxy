/**
 * OpenAI Chat Completions response mapping (non-streaming).
 */

import { originalToolName } from '../shared/tools.js'
import { normalizedFinishReason, opaqueId, type ParsedUpstreamResponse } from '../shared/frame.js'
import type { ParsedFunctionCall } from '../shared/frame.js'
import type { FormatContext } from '../shared/format-spec.js'

function toToolCalls(
  calls: readonly ParsedFunctionCall[],
  toolNameMap: Map<string, string>,
): Array<Record<string, unknown>> {
  return calls.map((call) => ({
    id: call.id ?? opaqueId('call'),
    type: 'function',
    function: {
      name: originalToolName(toolNameMap, call.name),
      arguments: JSON.stringify(call.args ?? {}),
    },
  }))
}

export function mapUsage(usage: ParsedUpstreamResponse['usage']): Record<string, number> {
  const prompt = usage?.promptTokenCount ?? 0
  const completion = usage?.candidatesTokenCount ?? 0
  const total = usage?.totalTokenCount ?? prompt + completion
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  }
}

/** Build the `chat.completion` object from a parsed upstream response. */
export function buildOpenAiResponse(
  parsed: ParsedUpstreamResponse,
  ctx: FormatContext,
): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant' }
  if (parsed.thoughtText.length > 0) message.reasoning_content = parsed.thoughtText
  message.content = parsed.text.length > 0 ? parsed.text : null

  let finishReason: string
  if (parsed.calls.length > 0) {
    message.tool_calls = toToolCalls(parsed.calls, ctx.toolNameMap)
    finishReason = 'tool_calls'
  } else {
    finishReason = normalizedFinishReason(parsed.finishReason)
  }

  return {
    id: ctx.responseId,
    object: 'chat.completion',
    created: ctx.created,
    model: ctx.requestedModel,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: mapUsage(parsed.usage),
  }
}
