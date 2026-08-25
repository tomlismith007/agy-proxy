/**
 * OpenAI Chat Completions request parsing -> shared AdapterDraft.
 */

import { safeFetch } from '../../util/urlguard.js'
import { ApiError } from '../shared/errors.js'
import { sanitizeTools } from '../shared/tools.js'
import {
  assertAcceptedImageMime,
  buildUpstreamContents,
  type NormalMessage,
  type ToolCallDraft,
  type UserPart,
} from '../shared/contents.js'
import { defaultMaxOutputTokens } from '../shared/finalize.js'
import type { AdapterDraft } from '../../types.js'

const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const IMAGE_FETCH_TIMEOUT_MS = 15_000

interface RawMessage {
  role?: unknown
  content?: unknown
  tool_call_id?: unknown
  tool_calls?: unknown
}

interface RawToolCall {
  id?: unknown
  function?: { name?: unknown; arguments?: unknown }
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_request_error', `field "${field}" must be a string`)
  return value
}

async function fetchImagePart(url: string): Promise<UserPart> {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+);base64,(.*)$/s)
    if (!match) throw new ApiError(400, 'invalid_request_error', 'unsupported data URL encoding for image_url')
    const mimeType = match[1]!
    assertAcceptedImageMime(mimeType)
    return { kind: 'image', mimeType, data: match[2]! }
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new ApiError(400, 'invalid_request_error', `invalid image URL`)
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new ApiError(400, 'invalid_request_error', 'image URLs must use http(s)')
  }
  let response: Response
  try {
    response = await safeFetch(parsedUrl, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ApiError(400, 'invalid_request_error', `failed to download image: ${reason}`)
  }
  if (!response.ok) {
    throw new ApiError(400, 'invalid_request_error', `image download failed with HTTP ${response.status}`)
  }
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > IMAGE_MAX_BYTES) {
    throw new ApiError(400, 'invalid_request_error', 'image exceeds the 10MB limit')
  }
  const mimeType = (response.headers.get('content-type') ?? 'image/png').split(';')[0]!.trim()
  assertAcceptedImageMime(mimeType)
  return {
    kind: 'image',
    mimeType,
    data: Buffer.from(buffer).toString('base64'),
  }
}

async function parseUserContent(content: unknown): Promise<UserPart[]> {
  if (typeof content === 'string') {
    return [{ kind: 'text', text: content }]
  }
  if (!Array.isArray(content)) {
    throw new ApiError(400, 'invalid_request_error', 'message content must be a string or a parts array')
  }
  const parts: UserPart[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type === 'text') {
      parts.push({ kind: 'text', text: expectString(record.text, 'text') })
    } else if (record.type === 'image_url') {
      const imageUrl = (record.image_url ?? {}) as Record<string, unknown>
      parts.push(await fetchImagePart(expectString(imageUrl.url, 'image_url.url')))
    }
    // Unknown block types are skipped (forward compatibility).
  }
  return parts
}

function parseToolCalls(raw: unknown, messageIndex: number): ToolCallDraft[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new ApiError(400, 'invalid_request_error', 'tool_calls must be an array')
  }
  return raw.map((entry, index): ToolCallDraft => {
    if (!entry || typeof entry !== 'object') {
      throw new ApiError(400, 'invalid_request_error', `tool_calls[${index}] is malformed`)
    }
    const call = entry as RawToolCall
    const id = typeof call.id === 'string' && call.id ? call.id : `call_${messageIndex}_${index}`
    const fn = call.function ?? {}
    const name = typeof fn.name === 'string' ? fn.name : ''
    if (!name) throw new ApiError(400, 'invalid_request_error', `tool_calls[${index}] missing function.name`)
    let args: Record<string, unknown> = {}
    if (typeof fn.arguments === 'string' && fn.arguments.trim() !== '') {
      try {
        const parsed = JSON.parse(fn.arguments) as unknown
        args = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { value: parsed }
      } catch {
        throw new ApiError(400, 'invalid_request_error', `tool_calls[${index}].function.arguments is not valid JSON`)
      }
    }
    return { id, name, args }
  })
}

export interface OpenAiParsedRequest extends AdapterDraft {
  stream: boolean
}

/** Parse and validate an OpenAI `/v1/chat/completions` body into a draft. */
export async function parseOpenAiChatRequest(body: unknown): Promise<OpenAiParsedRequest> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_request_error', 'request body must be a JSON object')
  }
  const raw = body as Record<string, unknown>

  const model = typeof raw.model === 'string' && raw.model.trim() !== '' ? raw.model.trim() : ''
  if (!model) throw new ApiError(400, 'invalid_request_error', 'field "model" is required')

  if (raw.n !== undefined && raw.n !== 1) {
    throw new ApiError(400, 'invalid_request_error', 'only n=1 is supported')
  }

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new ApiError(400, 'invalid_request_error', 'field "messages" must be a non-empty array')
  }

  const messages: NormalMessage[] = []
  for (const [index, entry] of raw.messages.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new ApiError(400, 'invalid_request_error', `messages[${index}] must be an object`)
    }
    const message = entry as RawMessage
    switch (message.role) {
      case 'system':
      case 'developer': {
        const text = typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? parseTextBlocks(message.content)
            : ''
        messages.push({ role: 'system', text })
        break
      }
      case 'user':
        messages.push({ role: 'user', parts: await parseUserContent(message.content) })
        break
      case 'assistant': {
        const text = typeof message.content === 'string' ? message.content : undefined
        messages.push({
          role: 'assistant',
          ...(text !== undefined ? { text } : {}),
          toolCalls: parseToolCalls(message.tool_calls, index),
        })
        break
      }
      case 'tool': {
        const toolCallId = expectString(message.tool_call_id, 'tool_call_id')
        const content = typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? parseTextBlocks(message.content)
            : ''
        messages.push({ role: 'tool', toolCallId, content })
        break
      }
      default:
        throw new ApiError(400, 'invalid_request_error', `messages[${index}].role "${String(message.role)}" is not supported`)
    }
  }

  // Tools
  let declarations: AdapterDraft['declarations']
  let toolNameMap: Map<string, string> | undefined
  if (Array.isArray(raw.tools) && raw.tools.length > 0) {
    const flat = raw.tools.map((tool) => {
      if (!tool || typeof tool !== 'object') {
        throw new ApiError(400, 'invalid_request_error', 'tools entries must be objects')
      }
      const record = tool as Record<string, unknown>
      const fn = (record.function ?? {}) as Record<string, unknown>
      if (record.type !== undefined && record.type !== 'function') {
        throw new ApiError(400, 'invalid_request_error', `tool type "${String(record.type)}" is not supported`)
      }
      return { name: fn.name, description: fn.description, parameters: fn.parameters }
    })
    const sanitized = sanitizeTools(flat)
    if (sanitized.declarations.length > 0) {
      declarations = sanitized.declarations
      toolNameMap = sanitized.nameMap
    }
  }

  // Generation parameters
  const temperature = typeof raw.temperature === 'number' ? raw.temperature : undefined
  const topP = typeof raw.top_p === 'number' ? raw.top_p : undefined
  const requestedMax =
    typeof raw.max_completion_tokens === 'number'
      ? raw.max_completion_tokens
      : typeof raw.max_tokens === 'number'
        ? raw.max_tokens
        : undefined
  const maxOutputTokens = requestedMax ?? defaultMaxOutputTokens(model)

  let reasoningEffort: AdapterDraft['reasoningEffort']
  if (raw.reasoning_effort === 'low' || raw.reasoning_effort === 'medium' || raw.reasoning_effort === 'high') {
    reasoningEffort = raw.reasoning_effort
  } else if (raw.reasoning_effort === 'minimal') {
    reasoningEffort = 'low'
  }

  const built = buildUpstreamContents(messages)

  return {
    model,
    contents: built.contents,
    systemInstructionText: built.systemText,
    declarations,
    ...(toolNameMap ? { toolNameMap } : {}),
    generationConfig: {
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { topP } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    },
    ...(reasoningEffort ? { reasoningEffort } : {}),
    stream: raw.stream === true,
  }
}

/** Concatenate text out of a content-parts array (system/tool roles). */
function parseTextBlocks(blocks: readonly unknown[]): string {
  const chunks: string[] = []
  for (const block of blocks) {
    if (block && typeof block === 'object') {
      const record = block as Record<string, unknown>
      if ((record.type === 'text' || record.type === undefined) && typeof record.text === 'string') {
        chunks.push(record.text)
      }
    }
  }
  return chunks.join('\n')
}
