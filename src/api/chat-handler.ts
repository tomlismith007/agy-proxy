/**
 * The shared chat pipeline for both client formats:
 * parse -> alias-remap -> rank accounts -> (refresh token -> finalize envelope
 * -> upstream call) with classified-failure rotation -> map response/stream.
 */

import type { Context } from 'hono'
import type { AppConfig } from '../config.js'
import type { AccountStore } from '../auth/store.js'
import { ensureFreshAccessToken, RefreshError } from '../auth/tokens.js'
import { beginStreamGenerateContent, generateContent, type UpstreamIdentity } from '../upstream/client.js'
import { parseUpstreamResponse } from '../adapters/shared/frame.js'
import { finalizeEnvelope } from '../adapters/shared/finalize.js'
import { ApiError, type ClientErrorPayload } from '../adapters/shared/errors.js'
import type { ClientFormatSpec, ParsedClientRequest } from '../adapters/shared/format-spec.js'
import { ClassifiedUpstreamError } from '../pool/classify.js'
import { decideRotationFromClassified, markSuccess } from '../pool/ratelimit.js'
import { rankAccounts } from '../pool/selector.js'
import { sseResponse } from '../util/sse-writer.js'
import { createLogger } from '../util/log.js'

const log = createLogger('chat')

export interface AppContext {
  config: AppConfig
  store: AccountStore
}

/** Total upstream attempts per request across the pool. */
const MAX_TOTAL_ATTEMPTS = 5

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorResponse(c: Context, payload: ClientErrorPayload): Response {
  return c.json(payload.body, { status: payload.status } as never)
}

/**
 * Handle one chat request end-to-end for the given client format.
 */
export async function handleChatRequest(
  ctx: AppContext,
  c: Context,
  format: ClientFormatSpec,
): Promise<Response> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return errorResponse(c, format.errorPayload(400, 'invalid_request_error', 'request body must be valid JSON'))
  }

  let parsed: ParsedClientRequest
  try {
    parsed = await format.parse(body)
  } catch (error) {
    if (error instanceof ApiError) {
      return errorResponse(c, format.errorPayload(error.status, error.code, error.message))
    }
    log.warn(`parse failed: ${error instanceof Error ? error.message : String(error)}`)
    return errorResponse(c, format.errorPayload(400, 'invalid_request_error', 'malformed request body'))
  }

  const draft = parsed.draft

  // Exact-match alias remap (request id -> upstream id).
  const aliasTarget = ctx.config.modelAliases[draft.model]
  if (typeof aliasTarget === 'string' && aliasTarget.trim() !== '') {
    draft.model = aliasTarget.trim()
  }

  const ranked = rankAccounts(ctx.store.list(), draft.model)
  if (ranked.length === 0) {
    return errorResponse(c, format.upstreamPayload('auth-failure', 'no enabled Antigravity accounts; run `agy-proxy login` first'))
  }

  const requestedModel = draft.model
  const refreshedOnce = new Set<string>()
  let lastPayload: ClientErrorPayload | null = null
  let candidateIdx = 0
  let consecutiveFailures = 0
  let totalAttempts = 0
  const clientSignal = c.req.raw.signal

  while (totalAttempts < MAX_TOTAL_ATTEMPTS) {
    if (candidateIdx >= ranked.length) break
    totalAttempts += 1
    const candidate = ranked[candidateIdx]!
    const record = candidate.record
    const email = record.email

    let accessToken: string
    try {
      accessToken = await ensureFreshAccessToken(ctx.store, email)
    } catch (error) {
      consecutiveFailures += 1
      const message = error instanceof RefreshError ? error.message : 'token refresh failed'
      lastPayload = format.upstreamPayload('auth-failure', `${email}: ${message}`)
      log.warn(`token unavailable for ${email}; rotating`)
      candidateIdx += 1
      continue
    }

    let call
    try {
      call = finalizeEnvelope(draft, { accountKey: email, projectId: record.projectId })
    } catch (error) {
      return errorResponse(
        c,
        format.errorPayload(400, 'invalid_request_error', error instanceof Error ? error.message : 'empty conversation'),
      )
    }

    const identity: UpstreamIdentity = { accessToken, accountKey: email }

    try {
      if (!parsed.stream) {
        const response = await generateContent(identity, call.envelope, { signal: clientSignal })
        ctx.store.update(email, (r) => markSuccess(r))
        const parsedUpstream = parseUpstreamResponse(response)
        return c.json(format.respond(parsedUpstream, buildFormatContext(format.name, requestedModel, call.toolNameMap)))
      }

      const streamAttempt = await beginStreamGenerateContent(identity, call.envelope, { signal: clientSignal })
      ctx.store.update(email, (r) => markSuccess(r))
      const frames = format.stream(streamAttempt.events, buildFormatContext(format.name, requestedModel, call.toolNameMap))
      return sseResponse(frames)
    } catch (error) {
      if (!(error instanceof ClassifiedUpstreamError)) {
        const message = error instanceof Error ? error.message : String(error)
        log.error(`unexpected failure on ${email}: ${message}`)
        lastPayload = format.errorPayload(500, 'internal_error', message)
        break
      }
      if (clientSignal.aborted) return new Response(null, { status: 499 })

      consecutiveFailures += 1
      lastPayload = format.upstreamPayload(error.kind, `${email}: ${error.message}`)

      // One forced-refresh confirmation before trusting an auth failure.
      if (error.kind === 'auth-failure' && !refreshedOnce.has(email)) {
        refreshedOnce.add(email)
        try {
          await ensureFreshAccessToken(ctx.store, email, { force: true })
          log.warn(`401/403 on ${email}: retried once after forced token refresh`)
          continue
        } catch {
          // fall through — decideRotation below disables the account
        }
      }

      const decision = decideRotationFromClassified(error, record, consecutiveFailures)
      ctx.store.update(email, () => {}) // persist the cooldown/rate-limit mutations
      log.info(
        `attempt ${consecutiveFailures} on ${email} -> ${error.kind}${error.rateLimitCategory ? `/${error.rateLimitCategory}` : ''}: ${decision.action}`,
      )

      if (decision.action === 'fail') break
      if (decision.action === 'retry-same') {
        if (decision.backoffMs) await sleep(Math.min(decision.backoffMs, 3_000))
        continue
      }
      if (decision.backoffMs) await sleep(Math.min(decision.backoffMs, 2_000))
      candidateIdx += 1
    }
  }

  if (!lastPayload) {
    lastPayload = format.upstreamPayload(
      'network-error',
      'all accounts are cooling down or exhausted; retry later',
    )
    lastPayload = { ...lastPayload, status: 503 }
  }
  return errorResponse(c, lastPayload)
}

interface FormatContextLike {
  requestedModel: string
  toolNameMap: Map<string, string>
  responseId: string
  created: number
}

function buildFormatContext(
  formatName: string,
  requestedModel: string,
  toolNameMap: Map<string, string>,
): FormatContextLike {
  const prefix = formatName === 'openai' ? 'chatcmpl' : 'msg'
  let hex = ''
  while (hex.length < 24) hex += Math.floor(Math.random() * 16).toString(16)
  return {
    requestedModel,
    toolNameMap,
    responseId: `${prefix}_${hex.slice(0, 24)}`,
    created: Math.floor(Date.now() / 1000),
  }
}
