/**
 * Normalized message model shared by both client formats, and the converter
 * to upstream `contents[]`: system messages merge into systemInstruction,
 * tool calls become functionCall parts (with replayed thought signatures),
 * tool results become user-role functionResponse parts, consecutive
 * same-role contents are merged.
 */

import { signatureForCall } from './thinking.js'
import { ApiError } from './errors.js'
import type {
  AdapterDraft,
  FunctionDeclaration,
  GenerationConfig,
  UpstreamContent,
  UpstreamPart,
} from '../../types.js'

export interface TextPart {
  kind: 'text'
  text: string
}

export interface ImagePart {
  kind: 'image'
  mimeType: string
  /** Pure base64, no data: prefix. */
  data: string
}

export type UserPart = TextPart | ImagePart

export interface ToolCallDraft {
  id: string
  name: string
  args: Record<string, unknown>
}

export type NormalMessage =
  | { role: 'system'; text: string }
  | { role: 'user'; parts: UserPart[] }
  | { role: 'assistant'; text?: string; toolCalls?: ToolCallDraft[] }
  | { role: 'tool'; toolCallId: string; content: string }

export interface BuiltContents {
  contents: UpstreamContent[]
  systemText?: string
}

const ACCEPTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function assertAcceptedImageMime(mimeType: string): void {
  if (!ACCEPTED_IMAGE_MIME.has(mimeType)) {
    throw new ApiError(400, 'invalid_request_error', `unsupported image media type: ${mimeType}`)
  }
}

function textPart(text: string): UpstreamPart {
  return { text }
}

function imagePart(part: ImagePart): UpstreamPart {
  assertAcceptedImageMime(part.mimeType)
  return { inlineData: { mimeType: part.mimeType, data: part.data } }
}

/**
 * Convert normalized messages into upstream contents. Empty text messages and
 * empty user turns are dropped; consecutive same-role contents merge so the
 * alternation the backend expects is preserved.
 */
export function buildUpstreamContents(messages: readonly NormalMessage[]): BuiltContents {
  const systemChunks: string[] = []
  const contents: UpstreamContent[] = []

  const pushPart = (role: 'user' | 'model', part: UpstreamPart): void => {
    const last = contents[contents.length - 1]
    if (last && last.role === role) {
      last.parts.push(part)
    } else {
      contents.push({ role, parts: [part] })
    }
  }

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        if (message.text.trim() !== '') systemChunks.push(message.text.trim())
        break
      case 'user': {
        for (const part of message.parts) {
          if (part.kind === 'text') {
            if (part.text !== '') pushPart('user', textPart(part.text))
          } else {
            pushPart('user', imagePart(part))
          }
        }
        break
      }
      case 'assistant': {
        if (typeof message.text === 'string' && message.text.length > 0) {
          pushPart('model', textPart(message.text))
        }
        for (const call of message.toolCalls ?? []) {
          pushPart('model', {
            functionCall: { id: call.id, name: call.name, args: call.args },
            thoughtSignature: signatureForCall(call.id),
          })
        }
        break
      }
      case 'tool': {
        // Tool results ride on the user role; name/id bind them to the call.
        pushPart('user', {
          functionResponse: {
            id: message.toolCallId,
            response: { result: message.content },
          },
        })
        break
      }
    }
  }

  return {
    contents,
    ...(systemChunks.length > 0 ? { systemText: systemChunks.join('\n\n') } : {}),
  }
}

/** Tool-set info carried into the draft by the request parsers. */
export interface ParsedTools {
  declarations?: FunctionDeclaration[]
  toolNameMap?: Map<string, string>
}

/**
 * Shared tail of both request parsers: convert normalized messages into
 * upstream contents and assemble the final draft.
 */
export function assembleDraft(
  model: string,
  messages: NormalMessage[],
  tools: ParsedTools | undefined,
  generationConfig: GenerationConfig,
  reasoningEffort: AdapterDraft['reasoningEffort'],
  stream: boolean,
): AdapterDraft & { stream: boolean } {
  const built = buildUpstreamContents(messages)
  return {
    model,
    contents: built.contents,
    systemInstructionText: built.systemText,
    declarations: tools?.declarations,
    ...(tools?.toolNameMap ? { toolNameMap: tools.toolNameMap } : {}),
    generationConfig,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    stream,
  }
}
