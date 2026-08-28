#!/usr/bin/env node
/**
 * agy-proxy CLI: Google OAuth login, account status, model listing,
 * verification and the local serving daemon.
 */

import fs from 'node:fs'
import readline from 'node:readline/promises'
import { Command } from 'commander'
import { loadConfig, resolveDataDir } from './config.js'
import { openStore } from './auth/store.js'
import { buildAuthorizationUrl, decodeState, ensureClientSecret } from './auth/oauth.js'
import {
  completeLogin,
  findFreePort,
  openInBrowser,
  waitForLoopbackCallback,
  type CallbackResult,
} from './auth/login-flow.js'
import { ensureFreshAccessToken } from './auth/tokens.js'
import { fetchAvailableModels } from './upstream/client.js'
import { isChatCallableModelId } from './upstream/catalog.js'
import { DEFAULT_HEALTH_INTERVAL_MS, pickProbeTargets, verifyAccount, type VerifyResult } from './pool/health.js'
import { killFilePath } from './api/middleware.js'
import { startServer } from './server.js'
import { VERSION } from './version.js'
import { ensureEgressProxy, maskProxyUrl, normalizeProxyUrl, probeProxy } from './util/urlguard.js'
import { loadFingerprintOverrides } from './upstream/fingerprint.js'
import { createLogger } from './util/log.js'
import { UsageHistory, type DayUsage } from './util/usage-history.js'
import type { AccountRecord } from './types.js'

const log = createLogger('cli')

const program = new Command()
program.name('agy-proxy').description('Local Antigravity reverse proxy').version(VERSION)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formatExpiry(expiresAt: number | undefined): string {
  if (!expiresAt) return 'never issued'
  const deltaMs = expiresAt - Date.now()
  if (deltaMs <= 0) return 'expired'
  const minutes = Math.floor(deltaMs / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
}

function usageTotalsRow(label: string, email: string, u: { requests: number; success: number; failures: number; promptTokens: number; outputTokens: number; thoughtsTokens: number }): Record<string, string | number> {
  return { [label]: email, 请求: u.requests, 成功: u.success, 失败: u.failures, 输入: u.promptTokens, 输出: u.outputTokens, 思考: u.thoughtsTokens }
}

function printUsageDay(day: DayUsage): void {
  const t = day.totals
  console.log(
    `\n${day.date}  请求 ${t.requests}（成功 ${t.success} / 失败 ${t.failures}）  tokens 输入 ${t.promptTokens} / 输出 ${t.outputTokens} / 思考 ${t.thoughtsTokens}\n`,
  )
  const models = Object.entries(day.byModel).map(([model, u]) => usageTotalsRow('模型', model, u))
  if (models.length > 0) {
    console.log('按模型:')
    console.table(models)
  }
  const accounts = Object.entries(day.byAccount).map(([email, u]) => usageTotalsRow('账号', email, u))
  if (accounts.length > 0) {
    console.log('按账号:')
    console.table(accounts)
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

program
  .command('login')
  .description('Log in with a Google account (browser OAuth, or paste mode with --headless)')
  .option('--headless', 'print the authorize URL and wait for a pasted redirect URL')
  .option('--port <port>', 'loopback callback port', '51121')
  .action(async (options: { headless?: boolean; port: string }) => {
    // Resolve egress proxy before any network work (token exchange, userinfo,
    // bootstrap) — direct connectivity to Google is often unavailable.
    const proxyInUse = await ensureEgressProxy(loadConfig().proxy)
    if (proxyInUse) console.log(`· 出站代理: ${proxyInUse}`)

    const requestedPort = Number(options.port) || 51121
    const port = requestedPort === 51121 ? await findFreePort(requestedPort) : requestedPort
    const redirectUri =
      port === 51121 ? 'http://localhost:51121/oauth-callback' : `http://localhost:${port}/oauth-callback`
    const authRequest = buildAuthorizationUrl(redirectUri)

    // Provision the public OAuth client credentials up front (env override →
    // public reference sources) so the token exchange cannot fail late.
    const clientSecret = await ensureClientSecret()
    if (clientSecret) {
      console.log(
        process.env.AGY_CLIENT_SECRET?.trim()
          ? '· OAuth 客户端凭据：来自环境变量 AGY_CLIENT_SECRET'
          : '· OAuth 客户端凭据：已从公开参考源自动获取',
      )
    } else {
      console.log('提示：未能获取公开 OAuth client_secret（离线？）。')
      console.log('      将先尝试无 secret 交换；若 Google 拒绝，请设置 AGY_CLIENT_SECRET 后重试。')
      console.log('')
    }

    console.log('\nAntigravity 使用 Antigravity 桌面版内置的 Google 公开客户端进行 OAuth 授权。')
    console.log('如浏览器未自动打开，请手动访问以下链接：\n')
    console.log(authRequest.url)
    console.log('')

    let result: CallbackResult
    if (options.headless) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const pasted = (await rl.question('粘贴回调完整 URL（或 code=…&state=…）: ')).trim()
      rl.close()
      const normalized = pasted.startsWith('http') ? pasted : `http://localhost/?${pasted.replace(/^[?&]+/, '')}`
      const url = new URL(normalized)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state') ?? ''
      if (!code) {
        console.error('✗ 未在输入中找到 code 参数')
        process.exitCode = 1
        return
      }
      let verifier = ''
      try {
        verifier = decodeState<{ verifier?: string }>(state).verifier ?? ''
      } catch {
        verifier = ''
      }
      if (!verifier) {
        console.error('✗ 未在 state 中找到 PKCE verifier，请粘贴完整的回调 URL')
        process.exitCode = 1
        return
      }
      result = { code, verifier }
    } else {
      openInBrowser(authRequest.url)
      console.log(`等待回调中（http://localhost:${port}/oauth-callback，5 分钟超时）…`)
      result = await waitForLoopbackCallback(port, authRequest.state)
    }

    try {
      const config = loadConfig()
      const store = openStore(config.dataDir)
      const summary = await completeLogin(
        store,
        result.code,
        result.verifier,
        redirectUri,
        (step) => console.log(`· ${step}`),
      )
      console.log('')
      console.log(`✅ 登录成功：${summary.email}`)
      if (summary.projectId) console.log(`   project : ${summary.projectId}`)
      if (summary.tierId) console.log(`   tier    : ${summary.tierId}`)
      console.log(`   存储    : ${config.dataDir}`)
      console.log('')
      console.log('下一步：')
      console.log('  agy-proxy models   # 查看可用模型')
      console.log('  agy-proxy serve    # 启动本地网关（OpenAI + Anthropic 兼容接口）')
    } catch (error) {
      console.error(`✗ 登录失败: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  })

program
  .command('status')
  .description('Show stored accounts')
  .action(() => {
    const config = loadConfig()
    const store = openStore(config.dataDir)
    const accounts = store.list()
    if (accounts.length === 0) {
      console.log('暂无账号。先运行: agy-proxy login')
      return
    }
    for (const record of accounts) {
      const flags: string[] = []
      if (!record.enabled) flags.push('disabled')
      if (record.verificationRequired) flags.push(`needs-reauth (${record.verificationRequiredReason ?? 'unknown'})`)
      if (record.coolingDownUntil && record.coolingDownUntil > Date.now()) flags.push('cooling-down')
      console.log(`${flags.length > 0 ? '⚠' : '●'} ${record.email}${flags.length > 0 ? `  [${flags.join(', ')}]` : ''}`)
      console.log(`    token 有效期至: ${formatExpiry(record.expiresAt)}`)
      console.log(`    project: ${record.projectId ?? '-'}   tier: ${record.tierId ?? '-'}`)
      const maskedProxy = maskProxyUrl(record.proxyUrl)
      if (maskedProxy) console.log(`    出站代理: ${maskedProxy}（账号独立 IP）`)
      if (record.cachedQuotaUpdatedAt) {
        console.log(`    配额缓存更新于: ${new Date(record.cachedQuotaUpdatedAt).toLocaleString()}`)
      }
    }
  })

program
  .command('models')
  .description('List available models for an account')
  .argument('[email]', 'account email (defaults to the first enabled account)')
  .action(async (email?: string) => {
    try {
      const config = loadConfig()
      await ensureEgressProxy(config.proxy)
      const store = openStore(config.dataDir)
      const accounts = store.list().filter((r) => r.enabled)
      const target = (email && store.get(email)) ?? accounts[0]
      if (!target) {
        console.error('✗ 没有可用账号，请先运行: agy-proxy login')
        process.exitCode = 1
        return
      }
      const accessToken = await ensureFreshAccessToken(store, target.email)
      const discovered = await fetchAvailableModels({ accessToken, accountKey: target.email }, target.projectId)
      const entries = Object.entries(discovered.models ?? {}).filter(([id]) => isChatCallableModelId(id))
      console.log(`\n${target.email} 可用模型 (${entries.length}):`)
      for (const [id, entry] of entries) {
        const remaining = entry.quotaInfo?.remainingFraction
        const pct = typeof remaining === 'number' ? `${Math.round(remaining * 100)}%` : '?'
        const reset = entry.quotaInfo?.resetTime ?? '-'
        console.log(`  ${id.padEnd(34)} 剩余 ${pct.padStart(4)}  重置 ${reset}`)
      }
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  })

program
  .command('verify')
  .description('Force-refresh credentials and re-check project access')
  .argument('[email]')
  .action(async (email?: string) => {
    try {
      const config = loadConfig()
      await ensureEgressProxy(config.proxy)
      const store = openStore(config.dataDir)
      const accounts = store.list().filter((r) => r.enabled)
      const target = (email && store.get(email)) ?? accounts[0]
      if (!target) {
        console.error('✗ 没有可用账号')
        process.exitCode = 1
        return
      }
      // Shared probe path with the web console and the background health loop.
      const result = await verifyAccount(store, target.email)
      if (result.ok) {
        console.log(`✅ ${result.email}: 凭据有效, project=${result.projectId}, tier=${result.tierId}`)
      } else {
        console.warn(`⚠ ${result.email}: ${result.error}`)
        process.exitCode = 1
      }
    } catch (error) {
      console.error(`✗ 验证失败: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  })

program
  .command('health')
  .description('Probe account credentials one pass; with --interval, keep looping')
  .option('--email <email>', 'probe only this account (bypasses auto-probe gating)')
  .option('--interval <ms>', 'run as a background loop probing accounts that need attention')
  .action(async (options: { email?: string; interval?: string }) => {
    try {
      const config = loadConfig()
      await ensureEgressProxy(config.proxy)
      const store = openStore(config.dataDir)

      const printResult = (result: VerifyResult): void => {
        if (result.ok) {
          console.log(`✓ ${result.email}  project=${result.projectId}${result.tierId ? `, tier=${result.tierId}` : ''}`)
        } else {
          console.log(`✗ ${result.email}  ${result.error}`)
        }
      }

      // Loop mode: only problem accounts each round, safety-valve aware.
      if (options.interval !== undefined) {
        const intervalMs = Math.max(5000, Math.trunc(Number(options.interval)) || DEFAULT_HEALTH_INTERVAL_MS)
        console.log(`健康循环已启动，每 ${Math.round(intervalMs / 1000)}s 一轮；按 Ctrl+C 停止。`)
        console.log('循环只探测需要处理的账号（已停用/待验证）；连续失败的号会自动熔断自动探测。')
        let stopped = false
        const tick = async (): Promise<void> => {
          if (stopped) return
          for (const record of pickProbeTargets(store)) {
            if (stopped) return
            printResult(await verifyAccount(store, record.email))
          }
        }
        void tick().catch((error) => {
          console.warn(`⚠ 探测轮次中断: ${error instanceof Error ? error.message : String(error)}`)
        })
        // Active interval ref keeps the process alive until Ctrl+C.
        setInterval(() => void tick(), intervalMs)
        await new Promise<never>(() => {})
      }

      // Single pass over every account (or the one requested).
      const targets = options.email
        ? [store.get(options.email.trim())].filter((r): r is AccountRecord => Boolean(r))
        : pickProbeTargets(store, { all: true })
      if (targets.length === 0) {
        console.error(options.email ? `✗ 未找到账号: ${options.email}` : '没有账号可探测；先运行 agy-proxy login。')
        process.exitCode = 1
        return
      }
      let failures = 0
      for (const record of targets) {
        const result = await verifyAccount(store, record.email)
        if (!result.ok) failures += 1
        printResult(result)
      }
      if (failures > 0) process.exitCode = 1
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  })

// ---------------------------------------------------------------------------
// Per-account egress proxy bindings
// ---------------------------------------------------------------------------

const proxyCmd = program
  .command('proxy')
  .description('Manage per-account egress proxies (http/https; shown masked everywhere)')

proxyCmd
  .command('set')
  .description('Bind an http/https egress proxy to one account (its own IP identity)')
  .argument('<email>')
  .argument('<url>', 'e.g. http://127.0.0.1:7890 (for socks5 use your client mixed port)')
  .action((email: string, url: string) => {
    try {
      const store = openStore(resolveDataDir())
      if (!store.get(email)) {
        console.error(`✗ 未找到账号: ${email}`)
        process.exitCode = 1
        return
      }
      const normalized = normalizeProxyUrl(url)
      store.update(email, (r) => {
        r.proxyUrl = normalized
      })
      console.log(`✓ 已设置 ${email} 的出站代理：${maskProxyUrl(normalized)}`)
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  })

proxyCmd
  .command('clear')
  .description('Remove an account proxy binding (falls back to the global proxy)')
  .argument('<email>')
  .action((email: string) => {
    const store = openStore(resolveDataDir())
    if (!store.update(email, (r) => { r.proxyUrl = undefined })) {
      console.error(`✗ 未找到账号: ${email}`)
      process.exitCode = 1
      return
    }
    console.log(`✓ 已清除 ${email} 的出站代理绑定。`)
  })

proxyCmd
  .command('test')
  .description('Probe an account proxy with a real request through it')
  .argument('<email>')
  .action(async (email: string) => {
    try {
      const record = openStore(resolveDataDir()).get(email)
      if (!record?.proxyUrl) {
        console.error(record ? '✗ 该账号未绑定代理' : `✗ 未找到账号: ${email}`)
        process.exitCode = 1
        return
      }
      console.log(`· 正在探测 ${maskProxyUrl(record.proxyUrl)} …`)
      const result = await probeProxy(record.proxyUrl)
      if (result.ok) {
        console.log(`✅ 代理可用，出口探测耗时 ${result.latencyMs}ms`)
      } else {
        console.error(`✗ 探测失败：${result.error}`)
        process.exitCode = 1
      }
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  })

proxyCmd
  .command('list')
  .description('List accounts with their masked proxy bindings')
  .action(() => {
    const accounts = openStore(resolveDataDir()).list()
    if (accounts.length === 0) {
      console.log('暂无账号。先运行: agy-proxy login')
      return
    }
    for (const record of accounts) {
      console.log(`${record.email.padEnd(32)} ${maskProxyUrl(record.proxyUrl) ?? '(未绑定)'}`)
    }
  })

program
  .command('logout')
  .description('Remove a stored account (does NOT revoke Google-side authorization)')
  .argument('<email>')
  .action((email: string) => {
    const config = loadConfig()
    const store = openStore(config.dataDir)
    if (!store.remove(email)) {
      console.error(`✗ 未找到账号: ${email}`)
      process.exitCode = 1
      return
    }
    console.log(`已删除本地账号 ${email}。`)
    console.log('注意：这不会撤销 Google 侧的授权；如需彻底撤销请访问 https://myaccount.google.com/permissions')
  })

program
  .command('pause')
  .description('Engage the kill switch: all /v1/* requests refuse until resume (no restart needed)')
  .action(() => {
    fs.writeFileSync(killFilePath(resolveDataDir()), new Date().toISOString(), { mode: 0o600 })
    console.log('⏸  已暂停：所有 /v1/* 请求将返回 503，上游零流量。')
    console.log('   运行 `agy-proxy resume` 恢复（无需重启服务）。')
  })

program
  .command('resume')
  .description('Lift the kill switch and restore normal serving')
  .action(() => {
    if (!fs.existsSync(killFilePath(resolveDataDir()))) {
      console.log('当前未处于暂停状态。')
      return
    }
    fs.unlinkSync(killFilePath(resolveDataDir()))
    console.log('▶ 已恢复：/v1/* 正常服务。')
  })

program
  .command('usage')
  .description('Show persisted daily usage history (requests + tokens)')
  .option('--days <n>', 'how many recent days to list', '14')
  .option('--date <date>', 'full per-model / per-account breakdown for one day (YYYY-MM-DD)')
  .action((options: { days?: string; date?: string }) => {
    const config = loadConfig()
    const usage = new UsageHistory(config.dataDir)
    if (options.date) {
      const day = usage.getDay(options.date.trim())
      if (!day) {
        console.error(`✗ 未找到该日期的用量记录: ${options.date}`)
        process.exitCode = 1
        return
      }
      printUsageDay(day)
      return
    }
    const days = usage.listDays(Math.max(1, Number(options.days) || 14))
    if (days.length === 0) {
      console.log('暂无用量历史（数据自本版本起按天落盘，发起请求后即可查阅）。')
      return
    }
    console.table(
      days.map((d) => ({
        日期: d.date,
        请求: d.totals.requests,
        成功: d.totals.success,
        失败: d.totals.failures,
        输入: d.totals.promptTokens,
        输出: d.totals.outputTokens,
        思考: d.totals.thoughtsTokens,
      })),
    )
  })

program
  .command('serve')
  .description('Start the local gateway (OpenAI + Anthropic compatible APIs)')
  .option('--host <host>', 'listen host (default 127.0.0.1)')
  .option('--port <port>', 'listen port (default 8045)')
  .action(async (options: { host?: string; port?: string }) => {
    // loadConfig reads AGY_HOST/AGY_PORT, so set them before resolving.
    if (options.host) process.env.AGY_HOST = options.host
    if (options.port) process.env.AGY_PORT = options.port
    const config = loadConfig()
    if (config.killSwitch) {
      console.error('✗ config.json 中 killSwitch 为 true（紧急停用），拒绝启动网关。')
      console.error('  恢复：把 killSwitch 改为 false 或删除该字段后重试。')
      process.exitCode = 1
      return
    }
    const fingerprintOverrides = loadFingerprintOverrides(config.dataDir)
    const proxyInUse = await ensureEgressProxy(config.proxy)
    const store = openStore(config.dataDir)
    const running = await startServer(config, store)

    console.log('')
    console.log(`🚀 agy-proxy 已启动  http://${config.host}:${running.port}`)
    console.log(`   账号数     : ${store.list().filter((r) => r.enabled).length}/${store.size}`)
    console.log(`   数据目录   : ${resolveDataDir()}`)
    console.log(`   出站代理   : ${proxyInUse ?? '直连（未检测到可用代理）'}`)
    console.log(`   并发上限   : ${config.maxConcurrentUpstream} 个同时上游请求${fingerprintOverrides ? '（指纹池已从 fingerprint.json 加载）' : ''}`)
    console.log('')
    console.log('   API Key    : ****' + config.apiKey.slice(-6))
    console.log(`                （完整值见 ${resolveDataDir()}/config.json 的 apiKey 字段）`)
    console.log('')
    console.log('   OpenAI 兼容 : POST /v1/chat/completions')
    console.log('   Anthropic   : POST /v1/messages')
    console.log('   模型列表    : GET  /v1/models')
    console.log('   健康检查    : GET  /healthz')
    console.log('   紧急停用   : agy-proxy pause（热生效）/ agy-proxy resume')
    console.log('')
    console.log('按 Ctrl+C 停止。')

    const shutdown = async (): Promise<void> => {
      log.info('shutting down')
      await running.close()
      process.exit(0)
    }
    process.on('SIGINT', () => void shutdown())
    process.on('SIGTERM', () => void shutdown())
  })

const parsed = program.parseAsync(process.argv).catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
void parsed
