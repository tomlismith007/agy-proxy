/**
 * HTTP middleware: API-key authentication, permissive CORS (localhost tool),
 * and lightweight request logging.
 */

import type { Context, MiddlewareHandler } from 'hono'
import { createLogger, redactSecrets } from '../util/log.js'

const log = createLogger('http')

function extractApiKey(c: Context): string | undefined {
  const header = c.req.header('authorization')
  if (header?.startsWith('Bearer ')) return header.slice(7).trim()
  const apiKeyHeader = c.req.header('x-api-key')
  if (apiKeyHeader) return apiKeyHeader.trim()
  return undefined
}

/** Require the configured local API key on /v1/* routes. */
export function apiKeyAuth(expectedKey: string): MiddlewareHandler {
  return async (c, next) => {
    const provided = extractApiKey(c)
    if (!provided || provided !== expectedKey) {
      return c.json(
        { error: { message: 'invalid or missing API key', type: 'invalid_request_error', code: 'invalid_api_key' } },
        401,
      )
    }
    await next()
  }
}

/** Permissive CORS — this is a localhost tool; browsers on the same machine connect. */
export function corsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*')
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    c.header(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta',
    )
    c.header('Access-Control-Max-Age', '86400')
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204)
    }
    await next()
  }
}

/** One info line per request with duration and status. */
export function requestLogging(): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = Date.now()
    await next()
    const status = c.res.status
    const line = `${c.req.method} ${c.req.path} -> ${status} (${Date.now() - startedAt}ms)`
    if (status >= 500) log.warn(redactSecrets(line))
    else log.info(redactSecrets(line))
  }
}
