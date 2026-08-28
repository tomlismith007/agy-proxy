/**
 * Google OAuth login machinery shared by the CLI (`agy-proxy login`) and the
 * web console (add-account wizard): loopback callback listener, browser
 * launch, token exchange + bootstrap, and a web-drivable LoginManager that
 * tracks one login session at a time.
 *
 * Network calls rely on the egress proxy already being resolved
 * (ensureEgressProxy) by whichever entry point runs them.
 */

import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import {
  buildAuthorizationUrl,
  decodeState,
  ensureClientSecret,
  exchangeCodeForTokens,
  fetchUserEmail,
} from './oauth.js'
import { bootstrapAccount } from './bootstrap.js'
import type { AccountStore } from './store.js'

export interface CallbackResult {
  code: string
  verifier: string
}

export function openInBrowser(url: string): void {
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

/** Find a free loopback port starting at `start`, trying up to 20 ports. */
export async function findFreePort(start: number): Promise<number> {
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

/** One-shot loopback HTTP listener that captures the OAuth redirect. */
export function waitForLoopbackCallback(
  port: number,
  expectedState: string,
  timeoutMs = 5 * 60_000,
): Promise<CallbackResult> {
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
        const verifier = decodeState<{ verifier?: string }>(state).verifier ?? ''
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

export interface LoginSummary {
  email: string
  projectId?: string
  tierId?: string
}

/**
 * Finish a login: exchange the code, resolve the email and Cloud Code
 * project, persist the account. Throws on any failure (nothing is stored).
 * `onStep` receives human-readable progress lines for CLI output.
 */
export async function completeLogin(
  store: AccountStore,
  code: string,
  verifier: string,
  redirectUri: string,
  onStep?: (step: string) => void,
): Promise<LoginSummary> {
  onStep?.('resolving OAuth client credentials…')
  const clientSecret = await ensureClientSecret()
  onStep?.('exchanging authorization code for tokens…')
  const exchange = await exchangeCodeForTokens(code, verifier, redirectUri, clientSecret)
  onStep?.('fetching account email…')
  const email = (await fetchUserEmail(exchange.grant.accessToken)) ?? `google-user-${Date.now()}`
  onStep?.('resolving Cloud Code project (may onboard a fresh account)…')
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
    // Kept encrypted at rest so token refresh works without re-exporting env.
    clientSecret,
  })

  return { email, projectId: boot.projectId || undefined, tierId: boot.tierId || undefined }
}

// ---------------------------------------------------------------------------
// Web-console login sessions
// ---------------------------------------------------------------------------

export type LoginPhase = 'idle' | 'waiting' | 'exchanging' | 'success' | 'error'

export interface LoginStatus {
  phase: LoginPhase
  /** Authorize URL while waiting (the UI links to it as a manual fallback). */
  url?: string
  email?: string
  projectId?: string
  tierId?: string
  error?: string
  startedAt?: number
}

interface PendingSession {
  state: string
  port: number
  url: string
  redirectUri: string
}

/** Tracks at most one web-initiated login at a time; safe to poll from the UI. */
export class LoginManager {
  private status: LoginStatus = { phase: 'idle' }
  private pending: PendingSession | undefined

  constructor(private readonly store: AccountStore) {}

  getStatus(): LoginStatus {
    return { ...this.status }
  }

  /**
   * Start a browser login: build the authorize URL, open the default browser,
   * then complete in the background once Google redirects back. The UI polls
   * {@link getStatus} for progress.
   */
  async start(): Promise<LoginStatus> {
    if (this.status.phase === 'waiting' || this.status.phase === 'exchanging') {
      return this.getStatus()
    }
    const port = await findFreePort(51121)
    const redirectUri =
      port === 51121 ? 'http://localhost:51121/oauth-callback' : `http://localhost:${port}/oauth-callback`
    const auth = buildAuthorizationUrl(redirectUri)
    this.pending = { state: auth.state, port, url: auth.url, redirectUri }
    this.status = { phase: 'waiting', url: auth.url, startedAt: Date.now() }

    void this.waitForCallback().catch((error: unknown) => {
      this.status = {
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
        url: auth.url,
      }
    })
    openInBrowser(auth.url)
    return this.getStatus()
  }

  private async waitForCallback(): Promise<void> {
    const pending = this.pending
    if (!pending) throw new Error('no pending login session')
    try {
      const result = await waitForLoopbackCallback(pending.port, pending.state)
      await this.finish(result.code, result.verifier, pending.redirectUri)
    } finally {
      this.pending = undefined
    }
  }

  /** Headless fallback: complete from a pasted full redirect URL. */
  async completePaste(rawUrl: string): Promise<LoginStatus> {
    const normalized = rawUrl.trim().startsWith('http')
      ? rawUrl.trim()
      : `http://localhost/?${rawUrl.trim().replace(/^[?&]+/, '')}`
    let code: string | null
    let verifier = ''
    try {
      const url = new URL(normalized)
      code = url.searchParams.get('code')
      verifier = decodeState<{ verifier?: string }>(url.searchParams.get('state') ?? '').verifier ?? ''
    } catch {
      code = null
    }
    if (!code || !verifier) {
      this.status = {
        phase: 'error',
        error: '粘贴的内容里缺少 code 或 PKCE state，请复制完整的回调 URL',
        url: this.status.url,
      }
      return this.getStatus()
    }
    const redirectUri = this.pending?.redirectUri ?? 'http://localhost:51121/oauth-callback'
    await this.finish(code, verifier, redirectUri)
    this.pending = undefined
    return this.getStatus()
  }

  private async finish(code: string, verifier: string, redirectUri: string): Promise<void> {
    this.status = { ...this.status, phase: 'exchanging', error: undefined }
    try {
      const summary = await completeLogin(this.store, code, verifier, redirectUri)
      this.status = {
        phase: 'success',
        email: summary.email,
        ...(summary.projectId ? { projectId: summary.projectId } : {}),
        ...(summary.tierId ? { tierId: summary.tierId } : {}),
        url: this.status.url,
      }
    } catch (error) {
      this.status = {
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
        url: this.status.url,
      }
    }
  }
}
