/**
 * Admin console JSON API: overview/config/accounts/models/stats plus the
 * management actions (login wizard, quota refresh, test chat, import/export,
 * kill-switch). Reads are open on a loopback listener; writes additionally
 * require the AGY_ADMIN_TOKEN header when one is configured, and are refused
 * outright on non-loopback listeners without one. Cross-site browser POSTs
 * are rejected via an Origin check (CSRF guard).
 */

import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import type { AccountRecord, AdapterDraft, AppContext } from '../types.js'
import { generateApiKey } from '../util/crypto.js'
import { persistConfigPatch } from '../config.js'
import { stats } from '../util/stats.js'
import { parseDayKey } from '../util/usage-history.js'
import { GateFullError } from '../util/concurrency.js'
import { ensureEgressProxy, maskProxyUrl, normalizeProxyUrl, probeProxy } from '../util/urlguard.js'
import { clearKillSwitch, engageKillSwitch, killSwitchEngaged } from '../killswitch.js'
import { ensureFreshAccessToken } from '../auth/tokens.js'
import { LoginManager } from '../auth/login-flow.js'
import { verifyAccount } from '../pool/health.js'
import {
  accountQuotaDetail,
  discoverModels,
  modelEntry,
  refreshAccountQuota,
} from '../upstream/discovery.js'
import { finalizeEnvelope } from '../adapters/shared/finalize.js'
import { parseUpstreamResponse } from '../adapters/shared/frame.js'
import { generateContent } from '../upstream/client.js'
import { rankAccounts } from '../pool/selector.js'
import { markSuccess } from '../pool/ratelimit.js'
import { ClassifiedUpstreamError } from '../util/classify.js'
import { errText } from '../util/log.js'
import { isLoopbackHost } from './page.js'
import { VERSION } from '../version.js'

function adminToken(): string | undefined {
  return process.env.AGY_ADMIN_TOKEN?.trim() || undefined
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** body.email as a trimmed string ('' when absent or malformed). */
function emailFromBody(body: Record<string, unknown>): string {
  return typeof body.email === 'string' ? body.email.trim() : ''
}

/**
 * CSRF + optional token gate for mutating endpoints: browsers attach Origin
 * on cross-site posts — mismatched origins are dropped; curl/localhost tooling
 * sends no Origin and passes. When AGY_ADMIN_TOKEN is set it is always
 * required; when the listener is not loopback-bound, writes need it.
 */
function writeGuard(getHost: () => string): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')
    if (origin) {
      try {
        const originHost = new URL(origin).host
        const requestHost = c.req.header('host') ?? ''
        if (requestHost && originHost !== requestHost) {
          return c.json({ error: 'cross-origin admin request refused' }, 403)
        }
      } catch {
        return c.json({ error: 'malformed Origin header' }, 403)
      }
    }
    const expected = adminToken()
    if (!expected) {
      if (!isLoopbackHost(getHost())) {
        return c.json(
          {
            error:
              'listener 未绑定本机回环地址，管理写操作被拒绝。设置环境变量 AGY_ADMIN_TOKEN 并在请求头 x-admin-token 携带后重试。',
          },
          403,
        )
      }
      await next()
      return
    }
    const bearer = c.req.header('authorization')
    const provided = (bearer?.startsWith('Bearer ') ? bearer.slice(7).trim() : undefined) ?? c.req.header('x-admin-token')?.trim()
    if (provided !== expected) return c.json({ error: 'invalid or missing admin token' }, 403)
    await next()
  }
}

function publicAccount(record: AccountRecord): Record<string, unknown> {
  return {
    email: record.email,
    projectId: record.projectId,
    tierId: record.tierId,
    enabled: record.enabled,
    createdAt: record.createdAt,
    lastRefreshAt: record.lastRefreshAt,
    expiresAt: record.expiresAt,
    coolingDownUntil: record.coolingDownUntil,
    cooldownReason: record.cooldownReason,
    rateLimitResetTimes: record.rateLimitResetTimes,
    cachedQuota: record.cachedQuota,
    cachedQuotaUpdatedAt: record.cachedQuotaUpdatedAt,
    verificationRequired: record.verificationRequired,
    verificationRequiredReason: record.verificationRequiredReason,
    validationUrl: record.validationUrl,
    consecutiveInvalidGrant: record.consecutiveInvalidGrant,
    /** Masked display form only — the raw per-account proxy URL never leaves the gateway. */
    proxyMasked: maskProxyUrl(record.proxyUrl) ?? null,
    lastHealthAt: record.lastHealthAt,
    lastHealthOk: record.lastHealthOk,
    lastHealthError: record.lastHealthError,
  }
}

/** Minimal real upstream call used by the console's "模型测试". */
async function runTestChat(
  ctx: AppContext,
  model: string,
  prompt: string,
): Promise<Record<string, unknown>> {
  const ranked = rankAccounts(ctx.store.list(), model)
  const candidate = ranked[0]
  if (!candidate) throw new Error('没有启用的账号，请先登录')

  let releaseGate: (() => void) | undefined
  const startedAt = Date.now()
  try {
    releaseGate = await ctx.upstreamGate.acquire()
    const accessToken = await ensureFreshAccessToken(ctx.store, candidate.record.email)
    const draft: AdapterDraft = {
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {},
    }
    const call = finalizeEnvelope(draft, {
      accountKey: candidate.record.email,
      projectId: candidate.record.projectId,
    })
    const response = await generateContent(
      { accessToken, accountKey: candidate.record.email, proxyUrl: candidate.record.proxyUrl },
      call.envelope,
    )
    ctx.store.update(candidate.record.email, (r) => markSuccess(r))
    const parsed = parseUpstreamResponse(response)
    return {
      ok: true,
      account: candidate.record.email,
      latencyMs: Date.now() - startedAt,
      text: parsed.text,
      thoughtText: parsed.thoughtText || undefined,
      finishReason: parsed.finishReason,
      modelVersion: parsed.modelVersion,
      usage: parsed.usage,
    }
  } finally {
    releaseGate?.()
  }
}

export function registerAdminRoutes(app: Hono, ctx: AppContext): void {
  const loginManager = new LoginManager(ctx.store)

  /**
   * Shared shape of the account-mutation endpoints: read body.email, resolve
   * the account. Returns the record, or a ready-to-return error Response.
   */
  const accountFromBody = (c: Context, body: Record<string, unknown>): AccountRecord | Response => {
    const email = emailFromBody(body)
    if (!email) return c.json({ error: '缺少 email' }, 400)
    const record = ctx.store.get(email)
    if (!record) return c.json({ error: `未找到账号: ${email}` }, 404)
    return record
  }

  // ---------------------------------------------------------------- reads --
  app.get('/admin/overview', (c) => {
    const accounts = ctx.store.list()
    return c.json({
      version: VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      host: ctx.config.host,
      port: ctx.config.port,
      dataDir: ctx.config.dataDir,
      loopback: isLoopbackHost(ctx.config.host),
      accounts: { total: accounts.length, enabled: accounts.filter((a) => a.enabled).length },
      paused: killSwitchEngaged(ctx.config.dataDir),
      proxy: process.env.AGY_PROXY_PROXY?.trim() || null,
      maxConcurrentUpstream: ctx.config.maxConcurrentUpstream,
      activeUpstreamRequests: ctx.upstreamGate.activeCount,
      apiKeyTail: ctx.config.apiKey.slice(-6),
      debugLog: ctx.config.debugLog,
    })
  })

  app.get('/admin/config', (c) =>
    c.json({
      host: ctx.config.host,
      port: ctx.config.port,
      debugLog: ctx.config.debugLog,
      onlyRealModels: ctx.config.onlyRealModels,
      modelAliases: ctx.config.modelAliases,
      proxy: ctx.config.proxy ?? null,
      maxConcurrentUpstream: ctx.config.maxConcurrentUpstream,
      killSwitch: ctx.config.killSwitch ?? false,
      apiKeyTail: ctx.config.apiKey.slice(-6),
      apiKeyFull: isLoopbackHost(ctx.config.host) ? ctx.config.apiKey : null,
      apiKeys: Object.entries(ctx.config.apiKeys).map(([name, key]) => ({
        name,
        keyTail: key.slice(-6),
        // Full values only over loopback listeners, same trust rule as apiKeyFull.
        keyFull: isLoopbackHost(ctx.config.host) ? key : null,
      })),
      restartRequiredFields: ['host', 'port'],
    }),
  )

  app.get('/admin/accounts', (c) =>
    c.json({ accounts: ctx.store.list().map(publicAccount) }),
  )

  app.get('/admin/models', async (c) => {
    try {
      const { ids, source, entries } = await discoverModels(ctx)
      return c.json({ source, models: ids.map((id) => modelEntry(id, entries)) })
    } catch (error) {
      return c.json({ source: 'catalog', models: [], error: errText(error) })
    }
  })

  app.get('/admin/stats', (c) => c.json(stats.snapshot()))

  // Persisted daily usage history (survives restarts), newest first. The
  // window is fixed: the only client (admin console) always asks for 30, so
  // no request-supplied number reaches the listing logic.
  app.get('/admin/usage/days', (c) => c.json({ days: ctx.usage.listDays(30) }))

  // Full breakdown for one day (models / accounts / hourly trend).
  app.get('/admin/usage/day', (c) => {
    // The request value is canonicalized and then only ever *compared*
    // against dates the persisted listing itself produced. The filesystem
    // layer receives an fs-sourced key, never a request-derived string.
    const date = parseDayKey(c.req.query('date') ?? '')
    if (!date) return c.json({ error: 'date 需为 YYYY-MM-DD 格式' }, 400)
    const listed = ctx.usage.listDays(366).find((d) => d.date === date)
    if (!listed) return c.json({ error: `未找到该日期的用量记录：${date}` }, 404)
    const day = ctx.usage.getDay(listed.date)
    if (!day) return c.json({ error: `未找到该日期的用量记录：${date}` }, 404)
    return c.json(day)
  })

  // Per-model quota detail for the console's expandable family rows. GET like
  // /admin/models: may perform a live upstream discovery on a stale cache.
  app.get('/admin/quota/detail', async (c) => {
    const email = c.req.query('email')?.trim() ?? ''
    try {
      return c.json({ email, ...(await accountQuotaDetail(ctx, email)) })
    } catch (error) {
      return c.json({ error: errText(error) }, ctx.store.get(email) ? 502 : 404)
    }
  })

  // ---------------------------------------------------------------- writes --
  app.use('/admin/*', async (c, next) => {
    if (c.req.method === 'GET') return next()
    return writeGuard(() => ctx.config.host)(c, next)
  })

  app.patch('/admin/config', async (c) => {
    const body = await readJson(c)
    const applied: string[] = []
    const restartRequired: string[] = []
    const filePatch: Record<string, unknown> = {}

    if (typeof body.debugLog === 'boolean') {
      ctx.config.debugLog = body.debugLog
      filePatch['debugLog'] = body.debugLog
      applied.push('debugLog')
    }
    if (typeof body.onlyRealModels === 'boolean') {
      ctx.config.onlyRealModels = body.onlyRealModels
      filePatch['onlyRealModels'] = body.onlyRealModels
      applied.push('onlyRealModels')
    }
    if (body.modelAliases !== undefined) {
      if (
        !body.modelAliases ||
        typeof body.modelAliases !== 'object' ||
        Array.isArray(body.modelAliases) ||
        !Object.values(body.modelAliases as object).every((v) => typeof v === 'string')
      ) {
        return c.json({ error: 'modelAliases 必须是 字符串->字符串 的对象' }, 400)
      }
      ctx.config.modelAliases = body.modelAliases as Record<string, string>
      filePatch['modelAliases'] = body.modelAliases
      applied.push('modelAliases')
    }
    if (body.proxy !== undefined) {
      const proxy = typeof body.proxy === 'string' ? body.proxy.trim() : ''
      ctx.config.proxy = proxy === '' ? undefined : proxy
      filePatch['proxy'] = proxy
      applied.push('proxy')
      if (proxy === '') delete process.env.AGY_PROXY_PROXY
      else process.env.AGY_PROXY_PROXY = proxy
      // Re-resolve so clearing falls back to auto-detection immediately.
      void ensureEgressProxy(proxy === '' ? undefined : proxy).catch(() => {})
    }
    if (body.maxConcurrentUpstream !== undefined) {
      const n = Number(body.maxConcurrentUpstream)
      if (!Number.isFinite(n) || Math.trunc(n) < 1 || Math.trunc(n) > 64) {
        return c.json({ error: 'maxConcurrentUpstream 必须是 1–64 的整数' }, 400)
      }
      ctx.config.maxConcurrentUpstream = Math.trunc(n)
      ctx.upstreamGate.setCapacity(Math.trunc(n))
      filePatch['maxConcurrentUpstream'] = Math.trunc(n)
      applied.push('maxConcurrentUpstream')
    }
    if (body.host !== undefined || body.port !== undefined) {
      if (body.host !== undefined) {
        const host = String(body.host).trim()
        if (host === '') return c.json({ error: 'host 不能为空' }, 400)
        ctx.config.host = host
        filePatch['host'] = host
        restartRequired.push('host')
      }
      if (body.port !== undefined) {
        const port = Number(body.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return c.json({ error: 'port 必须是 1–65535 的整数' }, 400)
        }
        ctx.config.port = port
        filePatch['port'] = port
        restartRequired.push('port')
      }
    }

    if (Object.keys(filePatch).length > 0) persistConfigPatch(ctx.config.dataDir, filePatch)
    return c.json({ ok: true, applied, restartRequired })
  })

  app.post('/admin/apikey/rotate', (c) => {
    const key = generateApiKey()
    ctx.config.apiKey = key
    persistConfigPatch(ctx.config.dataDir, { apiKey: key })
    return c.json({
      ok: true,
      apiKey: isLoopbackHost(ctx.config.host) ? key : null,
      apiKeyTail: key.slice(-6),
    })
  })

  app.post('/admin/apikeys/create', async (c) => {
    const body = await readJson(c)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return c.json({ error: '缺少密钥名称' }, 400)
    if (name.length > 40) return c.json({ error: '密钥名称过长（最多 40 字符）' }, 400)
    if (name in ctx.config.apiKeys) return c.json({ error: `已存在同名密钥：${name}` }, 409)
    const key = generateApiKey()
    const next = { ...ctx.config.apiKeys, [name]: key }
    ctx.config.apiKeys = next
    persistConfigPatch(ctx.config.dataDir, { apiKeys: next })
    return c.json({ ok: true, name, keyFull: isLoopbackHost(ctx.config.host) ? key : null })
  })

  app.post('/admin/apikeys/remove', async (c) => {
    const body = await readJson(c)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || !(name in ctx.config.apiKeys)) {
      return c.json({ error: `未找到命名密钥：${name || '(空)'}` }, 404)
    }
    const { [name]: _removed, ...next } = ctx.config.apiKeys
    void _removed
    ctx.config.apiKeys = next
    persistConfigPatch(ctx.config.dataDir, { apiKeys: next })
    return c.json({ ok: true, name })
  })

  app.post('/admin/accounts/toggle', async (c) => {
    const body = await readJson(c)
    const target = accountFromBody(c, body)
    if (target instanceof Response) return target
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : !target.enabled
    ctx.store.update(target.email, (r) => {
      r.enabled = enabled
      if (enabled) {
        r.consecutiveInvalidGrant = 0
      }
    })
    return c.json({ ok: true, email: target.email, enabled })
  })

  app.post('/admin/accounts/remove', async (c) => {
    const target = accountFromBody(c, await readJson(c))
    if (target instanceof Response) return target
    if (!ctx.store.remove(target.email)) return c.json({ error: `未找到账号: ${target.email}` }, 404)
    return c.json({
      ok: true,
      note: '本地账号已删除；Google 侧授权不会自动撤销，如需彻底撤销请访问 https://myaccount.google.com/permissions',
    })
  })

  app.post('/admin/accounts/verify', async (c) => {
    const email = emailFromBody(await readJson(c))
    const target = email ? ctx.store.get(email) : ctx.store.list().find((r) => r.enabled)
    if (!target) return c.json({ error: email ? `未找到账号: ${email}` : '没有可用账号' }, 404)
    // Shared probe path with the CLI + background loop; clears recoverable
    // validation cooldowns and records lastHealth* fields on the account.
    return c.json(await verifyAccount(ctx.store, target.email))
  })

  // ------------------------------------------------- per-account egress proxy --
  app.post('/admin/accounts/proxy', async (c) => {
    const body = await readJson(c)
    const target = accountFromBody(c, body)
    if (target instanceof Response) return target
    let normalized: string | undefined
    if (typeof body.proxyUrl === 'string' && body.proxyUrl.trim() !== '') {
      try {
        normalized = normalizeProxyUrl(body.proxyUrl)
      } catch (error) {
        return c.json({ error: errText(error) }, 400)
      }
    } else if (body.proxyUrl !== null && body.proxyUrl !== undefined) {
      return c.json({ error: 'proxyUrl 需为字符串（http/https URL）或 null' }, 400)
    }
    ctx.store.update(target.email, (r) => {
      r.proxyUrl = normalized
    })
    return c.json({ ok: true, email: target.email, proxyMasked: maskProxyUrl(normalized) ?? null })
  })

  app.post('/admin/accounts/proxy/test', async (c) => {
    const target = accountFromBody(c, await readJson(c))
    if (target instanceof Response) return target
    if (!target.proxyUrl) return c.json({ ok: false, error: '该账号未绑定代理' })
    // Real request through the bound path to a fixed fast endpoint.
    return c.json(await probeProxy(target.proxyUrl))
  })

  app.post('/admin/quota/refresh', async (c) => {
    const email = emailFromBody(await readJson(c))
    const targets = email
      ? [ctx.store.get(email)].filter((r): r is AccountRecord => Boolean(r))
      : ctx.store.list().filter((r) => r.enabled)
    if (targets.length === 0) return c.json({ error: email ? `未找到账号: ${email}` : '没有启用的账号' }, 404)

    const results: Array<Record<string, unknown>> = []
    for (const record of targets) {
      try {
        const { families, modelCount } = await refreshAccountQuota(ctx, record.email)
        results.push({ email: record.email, ok: true, families, modelCount })
      } catch (error) {
        results.push({ email: record.email, ok: false, error: errText(error) })
      }
    }
    return c.json({ ok: results.some((r) => r.ok), results })
  })

  app.post('/admin/test-chat', async (c) => {
    const body = await readJson(c)
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return c.json({ ok: false, error: '缺少 model' }, 400)
    const prompt =
      typeof body.prompt === 'string' && body.prompt.trim() !== ''
        ? body.prompt.trim()
        : '你好！请用一句话介绍你自己。'
    try {
      return c.json(await runTestChat(ctx, model, prompt))
    } catch (error) {
      if (error instanceof GateFullError) {
        return c.json({ ok: false, error: '上游并发已满，请稍后再试' })
      }
      if (error instanceof ClassifiedUpstreamError) {
        return c.json({ ok: false, kind: error.kind, error: error.message })
      }
      return c.json({ ok: false, error: errText(error) })
    }
  })

  // ----------------------------------------------------------- login flow --
  app.post('/admin/login/start', async (c) => c.json(await loginManager.start()))

  app.get('/admin/login/status', (c) => c.json(loginManager.getStatus()))

  app.post('/admin/login/paste', async (c) => {
    const body = await readJson(c)
    const url = typeof body.url === 'string' ? body.url : ''
    if (url.trim() === '') return c.json({ error: '请粘贴完整的回调 URL' }, 400)
    return c.json(await loginManager.completePaste(url))
  })

  // ---------------------------------------------------------- kill switch --
  app.post('/admin/pause', (c) => {
    engageKillSwitch(ctx.config.dataDir)
    return c.json({ ok: true, paused: true })
  })

  app.post('/admin/resume', (c) => {
    clearKillSwitch(ctx.config.dataDir)
    return c.json({ ok: true, paused: false })
  })

  // ------------------------------------------------------- import/export --
  // POST (not GET) so the mutating writeGuard applies: a cross-site page must
  // never be able to trigger a full-credentials download via plain navigation.
  app.post('/admin/accounts/export', async (c) => {
    const body = await readJson(c)
    const includeCredentials = body.credentials === true
    const records = ctx.store.list().map((r) => {
      if (includeCredentials) return { ...r }
      // Redacted export: structure and status only, no secrets.
      const { refreshToken, accessToken, clientSecret, ...rest } = r
      void refreshToken
      void accessToken
      void clientSecret
      return rest
    })
    const stamp = new Date().toISOString().slice(0, 10)
    const name = includeCredentials ? `agy-proxy-full-${stamp}.json` : `agy-proxy-redacted-${stamp}.json`
    c.header('Content-Disposition', `attachment; filename="${name}"`)
    return c.json({
      kind: 'agy-proxy.accounts',
      version: 1,
      exportedAt: new Date().toISOString(),
      includesCredentials: includeCredentials,
      accounts: records,
    })
  })

  app.post('/admin/accounts/import', async (c) => {
    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json({ error: '请求体必须是合法 JSON' }, 400)
    }
    const rawList = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as Record<string, unknown>)?.accounts)
        ? ((payload as Record<string, unknown>).accounts as unknown[])
        : []
    if (rawList.length === 0) return c.json({ error: '未找到 accounts 数组' }, 400)

    const skipped: Array<{ email: string; reason: string }> = []
    let imported = 0
    for (const item of rawList) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Partial<AccountRecord>
      if (typeof rec.email !== 'string' || rec.email.trim() === '') {
        skipped.push({ email: '(无 email)', reason: '缺少 email 字段' })
        continue
      }
      const existing = ctx.store.get(rec.email)
      if (typeof rec.refreshToken !== 'string' || rec.refreshToken === '') {
        if (existing) {
          skipped.push({ email: rec.email, reason: '导入内容无凭据，保留现有账号不覆盖' })
        } else {
          skipped.push({ email: rec.email, reason: '缺少 refreshToken，无法使用（可先导出脱敏备份再补凭据）' })
        }
        continue
      }
      ctx.store.upsert({
        ...(existing ?? {}),
        ...rec,
        email: rec.email,
        refreshToken: rec.refreshToken,
        createdAt: rec.createdAt ?? Date.now(),
        enabled: rec.enabled ?? existing?.enabled ?? true,
      } as AccountRecord)
      imported += 1
    }
    return c.json({ ok: imported > 0, imported, skipped })
  })
}
