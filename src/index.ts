#!/usr/bin/env node
/**
 * agy-proxy CLI: Google OAuth login, account status, model listing,
 * verification and the local serving daemon.
 */

import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import readline from 'node:readline/promises'
import { Command } from 'commander'
import { loadConfig, resolveDataDir } from './config.js'
import { openStore } from './auth/store.js'
import {
  buildAuthorizationUrl,
  decodeState,
  exchangeCodeForTokens,
  fetchUserEmail,
  resolveClientCredentials,
} from './auth/oauth.js'
import { bootstrapAccount } from './auth/bootstrap.js'
import { ensureFreshAccessToken } from './auth/tokens.js'
import { fetchAvailableModels } from './upstream/client.js'
import { loadCodeAssist } from './auth/bootstrap.js'
import { startServer } from './server.js'
import { createLogger } from './util/log.js'

const log = createLogger('cli')

const program = new Command()
program.name('agy-proxy').description('Local Antigravity reverse proxy').version('0.1.0')

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

function openInBrowser(url: string): void {
  const platform = process.platform
  if (platform === 'win32') {
    // No shell: `&` in the URL would be reinterpreted by cmd as a command separator.
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', detached: true }).unref()
  } else if (platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
  } else {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
  }
}

interface CallbackResult {
  code: string
  verifier: string
}

function waitForLoopbackCallback(port: number, expectedState: string, timeoutMs = 5 * 60_000): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== '/oauth-callback') {
          res.writeHead(404).end()
          return
        }
        const error = url.searchParams.get('error')
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state') ?? ''
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          '<html><body style="font-family:sans-serif;text-align:center;padding-top:4em">' +
            '<h2>&#9989; 授权完成</h2><p>可以关闭此页面，回到终端查看进度。</p></body></html>',
        )
        if (settled) return
        if (error) {
          settled = true
          reject(new Error(`authorization failed: ${error}`))
          server.close()
          return
        }
        if (!code) return
        let verifier = ''
        try {
          verifier = decodeState<{ verifier?: string }>(state).verifier ?? ''
        } catch {
          verifier = ''
        }
        if (!verifier || state !== expectedState) {
          // state mismatch — keep listening briefly for the real callback
          return
        }
        settled = true
        resolve({ code, verifier })
        server.close()
      } catch {
        res.writeHead(500).end()
      }
    })
    server.on('error', (error) => reject(error))
    server.listen(port, '127.0.0.1')
    setTimeout(() => {
      if (!settled) {
        settled = true
        server.close()
        reject(new Error(`timed out waiting for OAuth callback on port ${port}`))
      }
    }, timeoutMs)
  })
}

/** Find a free loopback port starting at `start`, trying up to 20 ports. */
async function findFreePort(start: number): Promise<number> {
  for (let candidate = start; candidate < start + 20; candidate++) {
    const isFree = await new Promise<boolean>((resolve) => {
      const probe = net.createServer()
      probe.once('error', () => resolve(false))
      probe.listen(candidate, '127.0.0.1', () => {
        probe.close(() => resolve(true))
      })
    })
    if (isFree) return candidate
  }
  return start
}

async function completeLogin(code: string, verifier: string, redirectUri: string): Promise<void> {
  const config = loadConfig()
  const store = openStore(config.dataDir)

  console.log('· exchanging authorization code for tokens…')
  const exchange = await exchangeCodeForTokens(code, verifier, redirectUri)

  console.log('· fetching account email…')
  const email = (await fetchUserEmail(exchange.grant.accessToken)) ?? `google-user-${Date.now()}`

  console.log('· resolving Cloud Code project (may onboard a fresh account)…')
  const boot = await bootstrapAccount(exchange.grant.accessToken)

  store.upsert({
    email,
    refreshToken: exchange.grant.refreshToken!,
    accessToken: exchange.grant.accessToken,
    expiresAt: exchange.grant.expiresAt,
    createdAt: Date.now(),
    enabled: true,
    projectId: boot.projectId || undefined,
    tierId: boot.tierId || undefined,
  })

  console.log('')
  console.log(`✅ 登录成功：${email}`)
  if (boot.projectId) console.log(`   project : ${boot.projectId}`)
  if (boot.tierId) console.log(`   tier    : ${boot.tierId}`)
  console.log(`   存储    : ${config.dataDir}`)
  console.log('')
  console.log('下一步：')
  console.log('  agy-proxy models   # 查看可用模型')
  console.log('  agy-proxy serve    # 启动本地网关（OpenAI + Anthropic 兼容接口）')
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
    const requestedPort = Number(options.port) || 51121
    const port = requestedPort === 51121 ? await findFreePort(requestedPort) : requestedPort
    const redirectUri =
      port === 51121 ? 'http://localhost:51121/oauth-callback' : `http://localhost:${port}/oauth-callback`
    const authRequest = buildAuthorizationUrl(redirectUri)

    if (!resolveClientCredentials().clientSecret) {
      console.log('提示：未设置 AGY_CLIENT_SECRET（Antigravity 桌面版公开 OAuth 客户端凭据）。')
      console.log('      如 Google 拒绝无 secret 的交换，先 export AGY_CLIENT_SECRET=<值> 再登录。')
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
      await completeLogin(result.code, result.verifier, redirectUri)
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
      const entries = Object.entries(discovered.models ?? {}).filter(([id]) => isChatCallable(id))
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

function isChatCallable(id: string): boolean {
  return !id.startsWith('tab_')
}

program
  .command('verify')
  .description('Force-refresh credentials and re-check project access')
  .argument('[email]')
  .action(async (email?: string) => {
    try {
      const config = loadConfig()
      const store = openStore(config.dataDir)
      const accounts = store.list().filter((r) => r.enabled)
      const target = (email && store.get(email)) ?? accounts[0]
      if (!target) {
        console.error('✗ 没有可用账号')
        process.exitCode = 1
        return
      }
      const accessToken = await ensureFreshAccessToken(store, target.email, { force: true })
      const assist = await loadCodeAssist(accessToken)
      if (assist.projectId) {
        store.update(target.email, (r) => {
          r.projectId = assist.projectId
          r.tierId = assist.tierId
          r.verificationRequired = false
          r.verificationRequiredReason = undefined
          r.enabled = true
        })
        console.log(`✅ ${target.email}: 凭据有效, project=${assist.projectId}, tier=${assist.tierId}`)
      } else {
        console.warn(`⚠ ${target.email}: 凭据有效但未解析到 project（账号可能尚未开通 Cloud Code）`)
      }
    } catch (error) {
      console.error(`✗ 验证失败: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
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
  .command('serve')
  .description('Start the local gateway (OpenAI + Anthropic compatible APIs)')
  .option('--host <host>', 'listen host (default 127.0.0.1)')
  .option('--port <port>', 'listen port (default 8045)')
  .action(async (options: { host?: string; port?: string }) => {
    // loadConfig reads AGY_HOST/AGY_PORT, so set them before resolving.
    if (options.host) process.env.AGY_HOST = options.host
    if (options.port) process.env.AGY_PORT = options.port
    const config = loadConfig()
    const store = openStore(config.dataDir)
    const running = await startServer(config, store)

    console.log('')
    console.log(`🚀 agy-proxy 已启动  http://${config.host}:${running.port}`)
    console.log(`   账号数     : ${store.list().filter((r) => r.enabled).length}/${store.size}`)
    console.log(`   数据目录   : ${resolveDataDir()}`)
    console.log('')
    console.log('   API Key    : ****' + config.apiKey.slice(-6))
    console.log(`                （完整值见 ${resolveDataDir()}/config.json 的 apiKey 字段）`)
    console.log('')
    console.log('   OpenAI 兼容 : POST /v1/chat/completions')
    console.log('   Anthropic   : POST /v1/messages')
    console.log('   模型列表    : GET  /v1/models')
    console.log('   健康检查    : GET  /healthz')
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
