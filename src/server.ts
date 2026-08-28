/**
 * Hono app wiring: health/info, admin console (page + JSON API), and the
 * authenticated /v1/* surface (models, OpenAI chat, Anthropic messages) behind
 * CORS + logging + API key middleware.
 */

import { Hono } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { apiKeyAuth, corsMiddleware, killSwitchMiddleware, requestLogging } from './api/middleware.js'
import { handleChatRequest, handleCountTokensRequest, type AppContext } from './api/chat-handler.js'
import { OPENAI_FORMAT } from './adapters/openai/format.js'
import { ANTHROPIC_FORMAT } from './adapters/anthropic/format.js'
import { Semaphore } from './util/concurrency.js'
import { discoverModels, modelEntry } from './upstream/discovery.js'
import { startQuotaRefresher, type QuotaRefresher } from './pool/quota-refresher.js'
import { startVersionRefreshLoop, type VersionRefresher } from './upstream/fingerprint.js'
import { startHealthLoop, type HealthLoop } from './pool/health.js'
import { stats } from './util/stats.js'
import { UsageHistory } from './util/usage-history.js'
import { createLogger } from './util/log.js'
import type { AppConfig } from './config.js'
import type { AccountStore } from './auth/store.js'
import { isLoopbackHost, registerAdminPage } from './admin/page.js'
import { registerAdminRoutes } from './admin/api.js'
import { VERSION } from './version.js'

const log = createLogger('server')

export interface RunningServer {
  port: number
  close(): Promise<void>
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
      version: VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      accounts: ctx.store.list().length,
    }),
  )

  // Admin console page (shell + assets) and its JSON API. Reads are open on a
  // loopback listener; writes are guarded (Origin check + optional token).
  registerAdminPage(app)
  registerAdminRoutes(app, ctx)

  // Authenticated API surface.
  app.use(
    '/v1/*',
    killSwitchMiddleware(ctx.config.dataDir),
    apiKeyAuth(() => [ctx.config.apiKey, ...Object.values(ctx.config.apiKeys)]),
    requestLogging(),
  )

  app.get('/v1/models', async (c) => {
    try {
      const { ids, source, entries } = await discoverModels(ctx)
      let list = ids
      if (!ctx.config.onlyRealModels && ctx.config.modelAliases) {
        list = [...ids]
        for (const alias of Object.keys(ctx.config.modelAliases)) {
          if (!list.includes(alias)) list.push(alias)
        }
      }
      return c.json({
        object: 'list',
        data: list.map((id) => modelEntry(id, entries)),
        x_source: source,
      })
    } catch (error) {
      log.error(`models listing failed: ${error instanceof Error ? error.message : String(error)}`)
      return c.json({ object: 'list', data: [] })
    }
  })

  app.post('/v1/chat/completions', (c) => handleChatRequest(ctx, c, OPENAI_FORMAT))
  app.post('/v1/messages', (c) => handleChatRequest(ctx, c, ANTHROPIC_FORMAT))
  // Anthropic SDK / Claude Code preflight counting (no OpenAI equivalent).
  app.post('/v1/messages/count_tokens', (c) => handleCountTokensRequest(ctx, c))

  return app
}

/** Start the HTTP listener. Resolves once bound. */
export function startServer(config: AppConfig, store: AccountStore): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    // Persistent per-day usage history; live stats forward every request into
    // it so daily token/request totals survive restarts.
    const usageHistory = new UsageHistory(config.dataDir, { retentionDays: config.usageRetentionDays })
    stats.attachHistory(usageHistory)
    const ctx: AppContext = {
      config,
      store,
      upstreamGate: new Semaphore(config.maxConcurrentUpstream),
      usage: usageHistory,
    }
    const app = createApp(ctx)
    // Keeps cached family quotas fresh so usage-aware selection has data
    // without manual admin-panel refreshes; keeps the fingerprint version
    // pool tracking the real Antigravity release feed.
    const quotaRefresher: QuotaRefresher = startQuotaRefresher(ctx)
    const versionRefresher: VersionRefresher = startVersionRefreshLoop()
    const healthLoop: HealthLoop = startHealthLoop(store)
    let server: ServerType
    try {
      server = serve({ fetch: app.fetch, hostname: config.host, port: config.port })
    } catch (error) {
      quotaRefresher.stop()
      versionRefresher.stop()
      healthLoop.stop()
      reject(error)
      return
    }
    server.once('error', reject)

    const close = (): Promise<void> =>
      new Promise((resolveClose) => {
        quotaRefresher.stop()
        versionRefresher.stop()
        healthLoop.stop()
        usageHistory.flush()
        server.close(() => resolveClose())
      })

    // give the listener a tick to bind before resolving
    setImmediate(() => resolve({ port: config.port, close }))
  })
}
