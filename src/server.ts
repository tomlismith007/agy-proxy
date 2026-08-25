/**
 * Hono app wiring: health/info, authenticated /v1/* surface (models, OpenAI
 * chat, Anthropic messages), CORS + logging + API key middleware.
 */

import { Hono } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { AGY_PUBLIC_MODELS } from './upstream/catalog.js'
import { fetchAvailableModels } from './upstream/client.js'
import { isChatCallableModelId, catalogModel } from './upstream/catalog.js'
import { ensureFreshAccessToken } from './auth/tokens.js'
import { OPENAI_FORMAT } from './adapters/openai/format.js'
import { ANTHROPIC_FORMAT } from './adapters/anthropic/format.js'
import type { DiscoveredModels, DiscoveredModelEntry } from './types.js'
import { apiKeyAuth, corsMiddleware, requestLogging } from './api/middleware.js'
import { handleChatRequest, type AppContext } from './api/chat-handler.js'
import type { AppConfig } from './config.js'
import type { AccountStore } from './auth/store.js'
import { createLogger } from './util/log.js'

const log = createLogger('server')

const PROXY_VERSION = '0.1.0'

export interface RunningServer {
  port: number
  close(): Promise<void>
}

/** In-memory model-id cache per account (TTL below). */
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000
const modelIdCache = new Map<string, { ids: string[]; updatedAt: number }>()

async function discoverModelEntries(
  ctx: AppContext,
): Promise<{ ids: string[]; source: 'discovered' | 'catalog' }> {
  const accounts = ctx.store
    .list()
    .filter((r) => r.enabled)
    .sort((a, b) => (b.cachedQuotaUpdatedAt ?? 0) - (a.cachedQuotaUpdatedAt ?? 0))

  for (const record of accounts) {
    const cached = modelIdCache.get(record.email)
    if (cached && Date.now() - cached.updatedAt < MODEL_CACHE_TTL_MS) {
      return { ids: cached.ids, source: 'discovered' }
    }
    try {
      const accessToken = await ensureFreshAccessToken(ctx.store, record.email)
      const discovered: DiscoveredModels = await fetchAvailableModels(
        { accessToken, accountKey: record.email },
        record.projectId,
      )
      const ids = Object.keys(discovered.models ?? {}).filter((id) => isChatCallableModelId(id))
      if (ids.length > 0) {
        modelIdCache.set(record.email, { ids, updatedAt: Date.now() })
        return { ids, source: 'discovered' }
      }
    } catch (error) {
      log.warn(
        `model discovery failed for ${record.email}: ${error instanceof Error ? error.message : String(error)}; trying next account`,
      )
    }
  }
  return { ids: AGY_PUBLIC_MODELS.map((m) => m.id), source: 'catalog' }
}

function modelEntry(id: string, discovered?: Map<string, DiscoveredModelEntry>): Record<string, unknown> {
  const meta = catalogModel(id)
  const dynamic = discovered?.get(id)
  return {
    id,
    object: 'model',
    type: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'antigravity',
    display_name: dynamic?.displayName ?? meta?.name ?? id,
    ...(meta ? { context_length: meta.contextLength, max_output_tokens: meta.maxOutputTokens } : {}),
    supports_reasoning: meta?.supportsReasoning ?? true,
    supports_vision: meta?.supportsVision ?? true,
    tool_calling: meta?.toolCalling ?? true,
  }
}

export function createApp(ctx: AppContext): Hono {
  const app = new Hono()

  app.use('*', corsMiddleware())
  app.onError((error, c) => {
    log.error(`unhandled error on ${c.req.path}: ${error instanceof Error ? error.stack : String(error)}`)
    return c.json({ error: { message: 'internal server error', type: 'api_error', code: 'internal_error' } }, 500)
  })

  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      version: PROXY_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      accounts: ctx.store.list().length,
    }),
  )

  app.get('/', (c) =>
    c.json({
      name: 'agy-proxy',
      version: PROXY_VERSION,
      endpoints: ['/v1/models', '/v1/chat/completions (OpenAI)', '/v1/messages (Anthropic)', '/healthz'],
    }),
  )

  // Authenticated API surface.
  app.use('/v1/*', apiKeyAuth(ctx.config.apiKey), requestLogging())

  app.get('/v1/models', async (c) => {
    try {
      const { ids, source } = await discoverModelEntries(ctx)
      let entries = ids
      if (!ctx.config.onlyRealModels && ctx.config.modelAliases) {
        entries = [...ids]
        for (const alias of Object.keys(ctx.config.modelAliases)) {
          if (!entries.includes(alias)) entries.push(alias)
        }
      }
      const data = entries.map((id) => modelEntry(id))
      return c.json({ object: 'list', data, x_source: source })
    } catch (error) {
      log.error(`models listing failed: ${error instanceof Error ? error.message : String(error)}`)
      return c.json({ object: 'list', data: [] })
    }
  })

  app.post('/v1/chat/completions', (c) => handleChatRequest(ctx, c, OPENAI_FORMAT))
  app.post('/v1/messages', (c) => handleChatRequest(ctx, c, ANTHROPIC_FORMAT))

  return app
}

/** Start the HTTP listener. Resolves once bound. */
export function startServer(config: AppConfig, store: AccountStore): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const app = createApp({ config, store })
    let server: ServerType
    try {
      server = serve({ fetch: app.fetch, hostname: config.host, port: config.port })
    } catch (error) {
      reject(error)
      return
    }
    server.once('error', reject)

    const close = (): Promise<void> =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose())
      })

    // give the listener a tick to bind before resolving
    setImmediate(() => resolve({ port: config.port, close }))
  })
}
