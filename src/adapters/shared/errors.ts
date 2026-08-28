/**
 * Shared adapter errors, client-format error payloads, and the tiny
 * field-validation helper both request parsers use.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Assert a JSON field is a string; throws the shared 400 ApiError otherwise. */
export function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_request_error', `field "${field}" must be a string`)
  return value
}

export interface ClientErrorPayload {
  status: number
  body: Record<string, unknown>
}

/** OpenAI-style error envelope. */
export function openAiErrorPayload(status: number, code: string, message: string): ClientErrorPayload {
  return { status, body: { error: { message, type: code, code } } }
}

/** Anthropic-style error envelope. */
export function anthropicErrorPayload(status: number, code: string, message: string): ClientErrorPayload {
  return { status, body: { type: 'error', error: { type: code, message } } }
}

const UPSTREAM_KIND_TO_CLIENT: Record<string, { status: number; openai: string; anthropic: string }> = {
  'rate-limit': { status: 429, openai: 'rate_limit_exceeded', anthropic: 'rate_limit_error' },
  'auth-failure': { status: 502, openai: 'upstream_auth_error', anthropic: 'api_error' },
  'validation-blocked': { status: 403, openai: 'upstream_validation_required', anthropic: 'api_error' },
  'network-error': { status: 502, openai: 'upstream_unavailable', anthropic: 'overloaded_error' },
  'request-error': { status: 400, openai: 'invalid_request_error', anthropic: 'invalid_request_error' },
  transient: { status: 502, openai: 'upstream_error', anthropic: 'api_error' },
}

/** Map an upstream classified failure to client-facing status + payloads. */
export function upstreamErrorPayloads(kind: string, message: string): {
  openai: ClientErrorPayload
  anthropic: ClientErrorPayload
} {
  const mapped = UPSTREAM_KIND_TO_CLIENT[kind] ?? UPSTREAM_KIND_TO_CLIENT['transient']!
  return {
    openai: openAiErrorPayload(mapped.status, mapped.openai, message),
    anthropic: anthropicErrorPayload(mapped.status, mapped.anthropic, message),
  }
}
