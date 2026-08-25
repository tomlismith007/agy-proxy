/**
 * v1internal Cloud Code client: generation (streaming + non-streaming) and
 * model discovery. Every call goes through the endpoint fallback chain and the
 * SSRF-guarded fetch; non-2xx responses are classified into ClassifiedError
 * and thrown as ClassifiedUpstreamError so the pool can act on them.
 */

import { AGY_ENDPOINT_FALLBACKS, postAcrossEndpoints } from './endpoints.js'
import { getBootstrapUserAgent, getClientMetadataHeader, getGenerationUserAgent, getXGoogApiClient } from './fingerprint.js'
import { classifyFetchError, classifyHttpError, ClassifiedUpstreamError } from '../pool/classify.js'
import { safeFetch } from '../util/urlguard.js'
import { createLogger } from '../util/log.js'
import type { DiscoveredModels } from '../types.js'
import type { Envelope, UpstreamResponse } from '../types.js'
import { parseSseStream, type SseEvent } from './sse.js'

const log = createLogger('client')

const GENERATE_TIMEOUT_MS = 120_000
const STREAM_TIMEOUT_MS = 600_000
const DISCOVERY_TIMEOUT_MS = 15_000

export interface UpstreamIdentity {
  accessToken: string
  /** Account email / stable key: seeds fingerprint + session identity. */
  accountKey: string
}

function generationHeaders(identity: UpstreamIdentity, stream: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${identity.accessToken}`,
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': getGenerationUserAgent(identity.accountKey),
    'X-Goog-Api-Client': getXGoogApiClient(identity.accountKey),
  }
}

async function readBodyText(response: Response): Promise<string | undefined> {
  try {
    return await response.text()
  } catch {
    return undefined
  }
}

/** Throw the classified error for a failed response; resolve with body text otherwise. */
async function assertOkOrClassify(response: Response, baseEndpoint: string): Promise<string | undefined> {
  if (response.ok) return readBodyText(response)
  const bodyText = await readBodyText(response)
  const classified = classifyHttpError(response.status, response.headers, bodyText)
  log.debug(`${response.status} at ${baseEndpoint}: ${classified.kind}${classified.rateLimitCategory ? `/${classified.rateLimitCategory}` : ''}`)
  throw new ClassifiedUpstreamError(classified)
}

export function parseUpstreamJson(bodyText: string): UpstreamResponse {
  return JSON.parse(bodyText) as UpstreamResponse
}

/** Non-streaming generation across fallback endpoints. */
export async function generateContent(
  identity: UpstreamIdentity,
  envelope: Envelope,
  options: { signal?: AbortSignal } = {},
): Promise<UpstreamResponse> {
  const body = JSON.stringify(envelope)
  try {
    const attempt = await postAcrossEndpoints(
      '/v1internal:generateContent',
      () => ({ method: 'POST', headers: generationHeaders(identity, false), body }),
      GENERATE_TIMEOUT_MS,
      options.signal,
    )
    const text = await assertOkOrClassify(attempt.response, attempt.baseEndpoint)
    return parseUpstreamJson(text ?? '{}')
  } catch (error) {
    if (error instanceof ClassifiedUpstreamError) throw error
    throw new ClassifiedUpstreamError(classifyFetchError(error))
  }
}

/**
 * Streaming generation: returns the raw Response (caller consumes the SSE
 * body). Non-ok statuses are classified and thrown before any streaming.
 */
export async function beginStreamGenerateContent(
  identity: UpstreamIdentity,
  envelope: Envelope,
  options: { signal?: AbortSignal } = {},
): Promise<{ response: Response; events: AsyncGenerator<SseEvent, void, undefined>; baseEndpoint: string }> {
  const body = JSON.stringify(envelope)
  try {
    const attempt = await postAcrossEndpoints(
      '/v1internal:streamGenerateContent?alt=sse',
      () => ({ method: 'POST', headers: generationHeaders(identity, true), body }),
      STREAM_TIMEOUT_MS,
      options.signal,
    )
    await assertOkOrClassify(attempt.response, attempt.baseEndpoint)
    if (!attempt.response.body) {
      throw new ClassifiedUpstreamError({ kind: 'network-error', message: 'upstream stream has no body' })
    }
    return {
      response: attempt.response,
      events: parseSseStream(attempt.response.body),
      baseEndpoint: attempt.baseEndpoint,
    }
  } catch (error) {
    if (error instanceof ClassifiedUpstreamError) throw error
    throw new ClassifiedUpstreamError(classifyFetchError(error))
  }
}

/** Model discovery with per-model quotaInfo, across fallback endpoints. */
export async function fetchAvailableModels(
  identity: UpstreamIdentity,
  projectId?: string,
): Promise<DiscoveredModels> {
  const headers = {
    Authorization: `Bearer ${identity.accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': getBootstrapUserAgent(identity.accountKey),
    'Client-Metadata': getClientMetadataHeader(),
  }
  const body = JSON.stringify(projectId ? { project: projectId } : {})
  let lastClassified: ClassifiedUpstreamError | undefined
  for (const base of AGY_ENDPOINT_FALLBACKS) {
    try {
      const response = await safeFetch(`${base}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      })
      if (response.ok) {
        return (await response.json()) as DiscoveredModels
      }
      lastClassified = new ClassifiedUpstreamError(
        classifyHttpError(response.status, response.headers, await readBodyText(response)),
      )
    } catch (error) {
      if (error instanceof ClassifiedUpstreamError) {
        lastClassified = error
      } else {
        lastClassified = new ClassifiedUpstreamError(classifyFetchError(error))
      }
    }
  }
  throw lastClassified ?? new Error('fetchAvailableModels: all endpoints failed')
}
