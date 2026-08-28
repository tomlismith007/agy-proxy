/**
 * Envelope assembly: AdapterDraft -> the outer v1internal request body.
 * thinkingConfig is only emitted for level-thinking models (upstream rejects
 * a level on id-bound models); Claude-family models strip a trailing model
 * turn; sessionId is stable per account so context caching keys consistently.
 */

import { generateAntigravityRequestId, deriveAntigravitySessionId } from '../../util/fnv1a.js'
import { catalogModel, isLevelThinkingModel } from '../../upstream/catalog.js'
import { signatureForCall } from './thinking.js'
import type {
  AdapterDraft,
  Envelope,
  FinalizedCall,
  GenerationConfig,
  UpstreamContent,
  UpstreamRequest,
} from '../../types.js'

export interface AccountIdentity {
  accountKey: string
  projectId?: string
}

function buildGenerationConfig(draft: AdapterDraft): GenerationConfig | undefined {
  const config: GenerationConfig = {}
  if (draft.generationConfig.temperature !== undefined) config.temperature = draft.generationConfig.temperature
  if (draft.generationConfig.topP !== undefined) config.topP = draft.generationConfig.topP
  const maxOutputTokens = draft.generationConfig.maxOutputTokens
  if (maxOutputTokens !== undefined) {
    // streamGenerateContent hard-400s (INVALID_ARGUMENT) any value above the
    // model cap even though generateContent tolerates it — clamp to the
    // catalog limit so oversized client budgets can't poison the request.
    const cap = catalogModel(draft.model)?.maxOutputTokens
    config.maxOutputTokens = cap !== undefined ? Math.min(maxOutputTokens, cap) : maxOutputTokens
  }

  const effort = draft.reasoningEffort
  if (
    (effort === 'low' || effort === 'medium' || effort === 'high') &&
    isLevelThinkingModel(draft.model)
  ) {
    config.thinkingConfig = { thinkingLevel: effort, includeThoughts: true }
  }

  return Object.keys(config).length > 0 ? config : undefined
}

/** Claude-family models reject a trailing model turn — drop it defensively. */
function stripTrailingModelTurn(contents: UpstreamContent[]): void {
  while (contents.length > 0 && contents[contents.length - 1]!.role === 'model') {
    contents.pop()
  }
}

/**
 * Upstream hard-fails (400) any functionCall part without a sibling
 * thoughtSignature. Enforce that invariant here — the single choke point
 * every request passes through — regardless of how contents were built.
 */
function ensureCallSignatures(contents: UpstreamContent[]): void {
  for (const content of contents) {
    for (const part of content.parts) {
      if (part.functionCall !== undefined && !part.thoughtSignature) {
        part.thoughtSignature = signatureForCall(part.functionCall.id)
      }
    }
  }
}

/**
 * Tool-history reconciliation at the single choke point. The client wire
 * formats carry tool results by call id only, but the upstream requires
 * `functionResponse.name` to be non-empty (400 "Name cannot be empty"
 * otherwise) and expects call/response names to match the sanitized
 * declarations. Remap functionCall names to their upstream names and backfill
 * every response name from its call id.
 */
function reconcileToolNames(contents: UpstreamContent[], toolNameMap: Map<string, string> | undefined): void {
  const upstreamByName = new Map<string, string>()
  if (toolNameMap) {
    for (const [upstreamName, originalName] of toolNameMap) upstreamByName.set(originalName, upstreamName)
  }
  const namesByCallId = new Map<string, string>()
  for (const content of contents) {
    for (const part of content.parts) {
      if (part.functionCall === undefined) continue
      const upstreamName = upstreamByName.get(part.functionCall.name) ?? part.functionCall.name
      part.functionCall.name = upstreamName
      if (part.functionCall.id !== undefined) namesByCallId.set(part.functionCall.id, upstreamName)
    }
  }
  for (const content of contents) {
    for (const part of content.parts) {
      if (part.functionResponse === undefined || part.functionResponse.name) continue
      const callName =
        (part.functionResponse.id !== undefined ? namesByCallId.get(part.functionResponse.id) : undefined) ??
        part.functionResponse.id ??
        'unknown_tool'
      part.functionResponse.name = callName
    }
  }
}

/** Assemble the final wire envelope for one upstream call. */
export function finalizeEnvelope(draft: AdapterDraft, identity: AccountIdentity): FinalizedCall {
  const contents = draft.contents
  if (contents.length === 0) {
    throw new Error('cannot send an empty conversation')
  }
  // A trailing model turn would be dropped for Claude models anyway; keep the
  // last user turn terminal for every family to avoid family-specific drift.
  if (contents[contents.length - 1]!.role !== 'user') {
    stripTrailingModelTurn(contents)
  }

  reconcileToolNames(contents, draft.toolNameMap)
  ensureCallSignatures(contents)

  const request: UpstreamRequest = {
    contents,
    ...(draft.systemInstructionText ? { systemInstruction: { parts: [{ text: draft.systemInstructionText }] } } : {}),
    ...(draft.declarations && draft.declarations.length > 0
      ? {
          tools: [{ functionDeclarations: draft.declarations }],
          toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
        }
      : {}),
    generationConfig: buildGenerationConfig(draft),
    sessionId: deriveAntigravitySessionId(identity.accountKey),
  }

  const envelope: Envelope = {
    ...(identity.projectId ? { project: identity.projectId } : {}),
    requestId: generateAntigravityRequestId(),
    model: draft.model,
    userAgent: 'antigravity',
    requestType: 'agent',
    request,
  }

  return { envelope, toolNameMap: draft.toolNameMap ?? new Map() }
}

/** Default max output tokens for a model when the client did not bound it. */
export function defaultMaxOutputTokens(modelId: string): number | undefined {
  return catalogModel(modelId)?.maxOutputTokens
}
