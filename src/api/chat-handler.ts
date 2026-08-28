/**
 * The shared chat pipeline for both client formats:
 * parse -> alias-remap -> rank accounts -> (refresh token -> finalize envelope
 * -> upstream call) with classified-failure rotation -> map response/stream.
 */

import type { Context } from 'hono'
import type { AppConfig } from '../config.js'
import type { AccountStore } from '../auth/store.js'
import { ensureFreshAccessToken, RefreshError } from '../auth/tokens.js'
import { beginStreamGenerateContent, countUpstreamTokens, generateContent, type UpstreamIdentity } from '../upstream/client.js'
import { finalizeEnvelope } from '../adapters/shared/finalize.js'
import { ANTHROPIC_FORMAT } from '../adapters/anthropic/format.js'
import { ApiError, type ClientErrorPayload } from '../adapters/shared/errors.js'
import type { ClientFormatSpec, FormatContext, ParsedClientRequest } from '../adapters/shared/format-spec.js'
import { ClassifiedUpstreamError } from '../pool/classify.js'
import { decideRotationFromClassified, isProxyPathOutage, markSuccess } from '../pool/ratelimit.js'
import { rankAccounts } from '../pool/selector.js'
import { applyAffinity, clearAffinity, pinAccount } from '../pool/affinity.js'
import { sseResponse } from '../util/sse-writer.js'
import { GateFullError, type Semaphore } from '../util/concurrency.js'
import { stats, type RequestStat } from '../util/stats.js'
import type { UsageHistory } from '../util/usage-history.js'
import { decodeStreamFrame, opaqueId, parseUpstreamResponse } from '../adapters/shared/frame.js'
import type { SseEvent } from '../upstream/sse.js'
import type { UsageMetadata } from '../types.js'
import { createLogger } from '../util/log.js'

const log = createLogger('chat')

export interface AppContext {
  config: AppConfig
  store: AccountStore
  /** Bounds simultaneous upstream calls (risk-control pacing). */
  upstreamGate: Semaphore
  /** Persistent per-day usage history backing the admin console's daily view. */
  usage: UsageHistory
}

/** Total upstream attempts per request across the pool. */
const MAX_TOTAL_ATTEMPTS = 5

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorResponse(c: Context, payload: ClientErrorPayload): Response {
  return c.json(payload.body, { status: payload.status } as never)
}

function payloadMessage(payload: ClientErrorPayload): string {
  const err = (payload.body as Record<string, { message?: unknown }>).error
  return typeof err?.message === 'string' ? err.message : 'request failed'
}

/**
 * Tee the upstream SSE event stream: forwards every event untouched while
 * watching for usage frames, then settles exactly once — with the last usage
 * seen (Gemini puts final usageMetadata on the trailing frames) or with the
 * stream error — so streamed requests land in stats/history with token counts.
 */
function trackStreamUsage(
  events: AsyncGenerator<SseEvent, void, undefined>,
  settle: (usage: UsageMetadata | undefined, streamError: string | undefined) => void,
): AsyncGenerator<SseEvent, void, undefined> {
  const tee = async function* (): AsyncGenerator<SseEvent, void, undefined> {
    let usage: UsageMetadata | undefined
    try {
      for await (const event of events) {
        if (event.data) {
          const decoded = decodeStreamFrame(event.data)
          if ((decoded.type === 'usage' || decoded.type === 'parts') && decoded.usage) usage = decoded.usage
        }
        yield event
      }
    } catch (error) {
      settle(usage, error instanceof Error ? error.message : String(error))
      throw error
    }
    settle(usage, undefined)
  }
  return tee()
}

/**
 * Handle one chat request end-to-end for the given client format.
 */
export async function handleChatRequest(
  ctx: AppContext,
  c: Context,
  format: ClientFormatSpec,
): Promise<Response> {
  const startedAt = Date.now()
  let requestedModelId = '-'
  let streamMode = false
  let servedBy: string | undefined
  const finishStat = (status: number, ok: boolean, extra: Partial<RequestStat> = {}): void => {
    stats.record({
      time: Date.now(),
      format: format.name,
      model: requestedModelId,
      ...(servedBy ? { account: servedBy } : {}),
      status,
      ok,
      latencyMs: Date.now() - startedAt,
      ...(streamMode ? { stream: true } : {}),
      ...extra,
    })
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    finishStat(400, false, { error: 'request body must be valid JSON' })
    return errorResponse(c, format.errorPayload(400, 'invalid_request_error', 'request body must be valid JSON'))
  }

  let parsed: ParsedClientRequest
  try {
    parsed = await format.parse(body)
  } catch (error) {
    if (error instanceof ApiError) {
      finishStat(error.status, false, { error: error.message })
      return errorResponse(c, format.errorPayload(error.status, error.code, error.message))
    }
    log.warn(`parse failed: ${error instanceof Error ? error.message : String(error)}`)
    finishStat(400, false, { error: 'malformed request body' })
    return errorResponse(c, format.errorPayload(400, 'invalid_request_error', 'malformed request body'))
  }

  const draft = parsed.draft
  requestedModelId = draft.model
  streamMode = Boolean(parsed.stream)

  // Exact-match alias remap (request id -> upstream id).
  const aliasTarget = ctx.config.modelAliases[draft.model]
  if (typeof aliasTarget === 'string' && aliasTarget.trim() !== '') {
    draft.model = aliasTarget.trim()
  }

  const ranked = rankAccounts(ctx.store.list(), draft.model)
  if (ranked.length === 0) {
    const payload = format.upstreamPayload('auth-failure', 'no enabled Antigravity accounts; run `agy-proxy login` first')
    finishStat(payload.status, false, { error: payloadMessage(payload) })
    return errorResponse(c, payload)
  }

  // Session affinity: while the window is live, keep serving the conversation
  // from the same account (prefix-cache continuity) as long as it is usable.
  applyAffinity(ranked)

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
      const message = error instanceof Error ? error.message : 'empty conversation'
      finishStat(400, false, { error: message })
      return errorResponse(c, format.errorPayload(400, 'invalid_request_error', message))
    }

    const identity: UpstreamIdentity = { accessToken, accountKey: email, proxyUrl: record.proxyUrl }

    let releaseGate: (() => void) | undefined
    try {
      try {
        releaseGate = await ctx.upstreamGate.acquire()
      } catch (error) {
        if (error instanceof GateFullError) {
          lastPayload = format.errorPayload(
            503,
            'rate_limit_exceeded',
            'server busy: too many concurrent requests, retry shortly',
          )
          break
        }
        throw error
      }

      if (!parsed.stream) {
        const response = await generateContent(identity, call.envelope, { signal: clientSignal })
        ctx.store.update(email, (r) => markSuccess(r))
        const parsedUpstream = parseUpstreamResponse(response)
        servedBy = email
        pinAccount(email)
        const usage = parsedUpstream.usage
        finishStat(200, true, {
          promptTokens: usage?.promptTokenCount,
          outputTokens: usage?.candidatesTokenCount,
          thoughtsTokens: usage?.thoughtsTokenCount,
        })
        return c.json(format.respond(parsedUpstream, buildFormatContext(format.name, requestedModel, call.toolNameMap)))
      }

      const streamAttempt = await beginStreamGenerateContent(identity, call.envelope, { signal: clientSignal })
      // The upstream connection is established; the long-lived SSE body no
      // longer counts against the concurrency gate.
      releaseGate!()
      releaseGate = undefined
      ctx.store.update(email, (r) => markSuccess(r))
      servedBy = email
      pinAccount(email)
      // Deferred stat: recorded when the stream settles so the usage frame's
      // token counts are included (streamed requests used to record none).
      const recordStreamStat = (usage?: UsageMetadata, streamError?: string): void => {
        finishStat(200, true, {
          ...(usage?.promptTokenCount != null ? { promptTokens: usage.promptTokenCount } : {}),
          ...(usage?.candidatesTokenCount != null ? { outputTokens: usage.candidatesTokenCount } : {}),
          ...(usage?.thoughtsTokenCount != null ? { thoughtsTokens: usage.thoughtsTokenCount } : {}),
          ...(streamError ? { error: streamError } : {}),
        })
      }
      const frames = format.stream(
        trackStreamUsage(streamAttempt.events, recordStreamStat),
        buildFormatContext(format.name, requestedModel, call.toolNameMap),
      )
      return sseResponse(frames)
    } catch (error) {
      if (!(error instanceof ClassifiedUpstreamError)) {
        const message = error instanceof Error ? error.message : String(error)
        log.error(`unexpected failure on ${email}: ${message}`)
        lastPayload = format.errorPayload(500, 'internal_error', message)
        break
      }
      if (clientSignal.aborted) {
        finishStat(499, false, { error: 'client aborted' })
        return new Response(null, { status: 499 })
      }

      // Fail-closed: an account bound to its own proxy failing at the connect
      // layer says nothing about the account itself. Skip cooldown bookkeeping
      // entirely (no store.update below), unpin affinity, and rotate; the
      // account re-enters ranking untouched next round.
      if (isProxyPathOutage(error.kind, Boolean(record.proxyUrl))) {
        lastPayload = format.upstreamPayload(error.kind, `${email}: ${error.message}`)
        clearAffinity(email)
        log.warn(
          `proxy-bound ${email} connect-layer outage${error.connectCode ? ` (${error.connectCode})` : ''}; rotating without cooldown`,
        )
        candidateIdx += 1
        continue
      }

      consecutiveFailures += 1
      lastPayload = format.upstreamPayload(error.kind, `${email}: ${error.message}`)
      // The pinned conversation identity just failed — unpin so the next
      // attempt ranks purely on merit (and the next success re-pins).
      clearAffinity(email)

      // One forced-refresh confirmation before trusting an auth failure.
      // (validation-blocked is NOT a credential problem — skip the refresh.)
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
    } finally {
      releaseGate?.()
    }
  }

  if (!lastPayload) {
    lastPayload = format.upstreamPayload(
      'network-error',
      'all accounts are cooling down or exhausted; retry later',
    )
    lastPayload = { ...lastPayload, status: 503 }
  }
  finishStat(lastPayload.status, false, { error: payloadMessage(lastPayload) })
  return errorResponse(c, lastPayload)
}

/**
 * POST /v1/messages/count_tokens — Anthropic-specific helper (Claude Code and
 * the Anthropic SDK call it before sending). Best-effort upstream passthrough
 * on the top-ranked account; no rotation loop, counting is cheap to retry.
 */
export async function handleCountTokensRequest(ctx: AppContext, c: Context): Promise<Response> {
  const anthropic = ANTHROPIC_FORMAT

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return errorResponse(c, anthropic.errorPayload(400, 'invalid_request_error', 'request body must be valid JSON'))
  }
  let draft: ParsedClientRequest['draft']
  try {
    draft = (await anthropic.parse(body)).draft
  } catch (error) {
    if (error instanceof ApiError) {
      return errorResponse(c, anthropic.errorPayload(error.status, error.code, error.message))
    }
    return errorResponse(c, anthropic.errorPayload(400, 'invalid_request_error', 'malformed request body'))
  }

  const ranked = rankAccounts(ctx.store.list(), draft.model)
  const candidate = ranked.find((entry) => entry.blockedUntil === null) ?? ranked[0]
  if (!candidate) {
    return errorResponse(
      c,
      anthropic.upstreamPayload('auth-failure', 'no enabled Antigravity accounts; run `agy-proxy login` first'),
    )
  }

  let releaseGate: (() => void) | undefined
  try {
    releaseGate = await ctx.upstreamGate.acquire()
    const email = candidate.record.email
    const accessToken = await ensureFreshAccessToken(ctx.store, email)
    const call = finalizeEnvelope(draft, { accountKey: email, projectId: candidate.record.projectId })
    const inputTokens = await countUpstreamTokens(
      { accessToken, accountKey: email, proxyUrl: candidate.record.proxyUrl },
      call.envelope,
      { signal: c.req.raw.signal },
    )
    ctx.store.update(email, (r) => markSuccess(r))
    pinAccount(email)
    return c.json({ input_tokens: inputTokens })
  } catch (error) {
    if (error instanceof GateFullError) {
      return errorResponse(
        c,
        anthropic.errorPayload(503, 'rate_limit_exceeded', 'server busy: too many concurrent requests, retry shortly'),
      )
    }
    if (error instanceof ClassifiedUpstreamError) {
      return errorResponse(c, anthropic.upstreamPayload(error.kind, error.message))
    }
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`count_tokens failed: ${message}`)
    return errorResponse(c, anthropic.errorPayload(500, 'api_error', message))
  } finally {
    releaseGate?.()
  }
}

function buildFormatContext(
  formatName: string,
  requestedModel: string,
  toolNameMap: Map<string, string>,
): FormatContext {
  const prefix = formatName === 'openai' ? 'chatcmpl' : 'msg'
  return {
    requestedModel,
    toolNameMap,
    responseId: opaqueId(prefix),
    created: Math.floor(Date.now() / 1000),
  }
}
