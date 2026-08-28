/**
 * Anthropic Messages request parsing -> shared AdapterDraft.
 */

import { ApiError, expectString } from '../shared/errors.js'
import { sanitizedToolSet } from '../shared/tools.js'
import {
  assertAcceptedImageMime,
  assembleDraft,
  type NormalMessage,
  type ToolCallDraft,
  type UserPart,
} from '../shared/contents.js'
import type { AdapterDraft, GenerationConfig } from '../../types.js'

interface RawContentBlock {
  type?: unknown
  text?: unknown
  source?: { type?: unknown; media_type?: unknown; data?: unknown }
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
  thinking?: unknown
}

/** thinking.budget_tokens → coarse effort level for level-thinking models. */
function budgetToEffort(budget: number): AdapterDraft['reasoningEffort'] {
  if (budget <= 4_096) return 'low'
  if (budget <= 16_384) return 'medium'
  return 'high'
}

function parseImageBlock(block: RawContentBlock): UserPart {
  const source = block.source ?? {}
  if (source.type !== 'base64') {
    throw new ApiError(400, 'invalid_request_error', 'only base64 image sources are supported')
  }
  const mimeType = typeof source.media_type === 'string' ? source.media_type : ''
  const data = typeof source.data === 'string' ? source.data : ''
  assertAcceptedImageMime(mimeType)
  return { kind: 'image', mimeType, data }
}

function parseUserBlocks(blocks: readonly unknown[]): NormalMessage[] {
  const messages: NormalMessage[] = []
  const parts: UserPart[] = []
  const flushParts = (): void => {
    if (parts.length > 0) {
      messages.push({ role: 'user', parts: [...parts] })
      parts.length = 0
    }
  }
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const record = block as RawContentBlock
    switch (record.type) {
      case 'text':
        parts.push({ kind: 'text', text: typeof record.text === 'string' ? record.text : '' })
        break
      case 'image':
        parts.push(parseImageBlock(record))
        break
      case 'tool_result': {
        flushParts()
        const toolUseId = expectString(record.tool_use_id, 'tool_result.tool_use_id')
        let resultText = ''
        if (typeof record.content === 'string') {
          resultText = record.content
        } else if (Array.isArray(record.content)) {
          resultText = record.content
            .map((inner) =>
              inner && typeof inner === 'object' && typeof (inner as RawContentBlock).text === 'string'
                ? ((inner as RawContentBlock).text as string)
                : '',
            )
            .join('\n')
        }
        if (record.is_error === true && resultText.length > 0) {
          resultText = `[tool error] ${resultText}`
        }
        messages.push({ role: 'tool', toolCallId: toolUseId, content: resultText })
        break
      }
      default:
        throw new ApiError(400, 'invalid_request_error', `unsupported content block type "${String(record.type)}"`)
    }
  }
  flushParts()
  return messages
}

function parseAssistantBlocks(blocks: readonly unknown[]): NormalMessage[] {
  const texts: string[] = []
  const calls: ToolCallDraft[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const record = block as RawContentBlock
    switch (record.type) {
      case 'text':
        if (typeof record.text === 'string') texts.push(record.text)
        break
      case 'tool_use': {
        const id = expectString(record.id, 'tool_use.id')
        const name = expectString(record.name, 'tool_use.name')
        const input =
          record.input && typeof record.input === 'object' && !Array.isArray(record.input)
            ? (record.input as Record<string, unknown>)
            : {}
        calls.push({ id, name, args: input })
        break
      }
      // thinking / redacted_thinking blocks are intentionally not forwarded —
      // the upstream drops non-replayable thought parts anyway.
      case 'thinking':
      case 'redacted_thinking':
        break
      default:
        throw new ApiError(400, 'invalid_request_error', `unsupported content block type "${String(record.type)}"`)
    }
  }
  const message: NormalMessage = {
    role: 'assistant',
    ...(texts.length > 0 ? { text: texts.join('') } : {}),
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
  }
  return [message]
}

export interface AnthropicParsedRequest extends AdapterDraft {
  stream: boolean
}

/** Parse and validate an Anthropic `/v1/messages` body into a draft. */
export function parseAnthropicMessagesRequest(body: unknown): AnthropicParsedRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_request_error', 'request body must be a JSON object')
  }
  const raw = body as Record<string, unknown>

  const model = typeof raw.model === 'string' && raw.model.trim() !== '' ? raw.model.trim() : ''
  if (!model) throw new ApiError(400, 'invalid_request_error', 'field "model" is required')

  const maxTokens = typeof raw.max_tokens === 'number' && Number.isFinite(raw.max_tokens) ? Math.trunc(raw.max_tokens) : NaN
  if (!(maxTokens > 0)) throw new ApiError(400, 'invalid_request_error', 'field "max_tokens" must be a positive number')

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new ApiError(400, 'invalid_request_error', 'field "messages" must be a non-empty array')
  }

  const messages: NormalMessage[] = []

  // system: string or text-block array
  if (typeof raw.system === 'string') {
    messages.push({ role: 'system', text: raw.system })
  } else if (Array.isArray(raw.system)) {
    const chunks: string[] = []
    for (const block of raw.system) {
      if (block && typeof block === 'object' && typeof (block as RawContentBlock).text === 'string') {
        chunks.push((block as RawContentBlock).text as string)
      }
    }
    if (chunks.length > 0) messages.push({ role: 'system', text: chunks.join('\n\n') })
  }

  for (const [index, entry] of raw.messages.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new ApiError(400, 'invalid_request_error', `messages[${index}] must be an object`)
    }
    const message = entry as Record<string, unknown>
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new ApiError(400, 'invalid_request_error', `messages[${index}].role must be "user" or "assistant"`)
    }
    if (typeof message.content === 'string') {
      messages.push(
        message.role === 'user'
          ? { role: 'user', parts: [{ kind: 'text', text: message.content }] }
          : { role: 'assistant', text: message.content },
      )
    } else if (Array.isArray(message.content)) {
      messages.push(...(message.role === 'user' ? parseUserBlocks(message.content) : parseAssistantBlocks(message.content)))
    } else {
      throw new ApiError(400, 'invalid_request_error', `messages[${index}].content must be a string or block array`)
    }
  }

  // Tools
  const tools =
    Array.isArray(raw.tools) && raw.tools.length > 0
      ? sanitizedToolSet(
          raw.tools.map((tool) => {
            if (!tool || typeof tool !== 'object') {
              throw new ApiError(400, 'invalid_request_error', 'tools entries must be objects')
            }
            const record = tool as Record<string, unknown>
            return {
              name: record.name,
              description: record.description,
              input_schema: record.input_schema,
              parameters: undefined,
            }
          }),
        )
      : undefined

  // Thinking parameter -> coarse effort (used only by level-thinking models).
  let reasoningEffort: AdapterDraft['reasoningEffort']
  if (
    raw.thinking &&
    typeof raw.thinking === 'object' &&
    (raw.thinking as Record<string, unknown>).type === 'enabled'
  ) {
    const budget = (raw.thinking as Record<string, unknown>).budget_tokens
    reasoningEffort = budgetToEffort(typeof budget === 'number' && Number.isFinite(budget) ? budget : 16_384)
  }

  const generationConfig: GenerationConfig = {
    ...(typeof raw.temperature === 'number' ? { temperature: raw.temperature } : {}),
    ...(typeof raw.top_p === 'number' ? { topP: raw.top_p } : {}),
    maxOutputTokens: maxTokens,
  }

  return assembleDraft(model, messages, tools, generationConfig, reasoningEffort, raw.stream === true)
}
