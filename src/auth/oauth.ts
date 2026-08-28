/**
 * Google OAuth for the Antigravity desktop client's public OAuth client.
 * Scopes must NOT include `openid` — it routes this client into the hanging
 * `firstparty/nativeapp` consent flow (verified by upstream reference tools).
 *
 * The client_id is a public identifier and safe to embed. The client_secret
 * is deliberately NOT committed: supply it via AGY_CLIENT_SECRET (extract it
 * from the Antigravity desktop app or the reference projects); when absent it
 * is omitted from token exchanges, which Google accepts for installed-app
 * clients.
 */

import { createHash, randomBytes } from 'node:crypto'
import { safeFetch } from '../util/urlguard.js'
import { createLogger } from '../util/log.js'

const log = createLogger('oauth')

/** Public consumer-OAuth client id embedded in the Antigravity product. */
export const AGY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'

export const AGY_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

export const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo'

export const DEFAULT_CALLBACK_PORT = 51121
export const DEFAULT_REDIRECT_URI = `http://localhost:${DEFAULT_CALLBACK_PORT}/oauth-callback`

export function resolveClientCredentials(): { clientId: string; clientSecret?: string } {
  return {
    clientId: process.env.AGY_CLIENT_ID?.trim() || AGY_CLIENT_ID,
    clientSecret: process.env.AGY_CLIENT_SECRET?.trim() || undefined,
  }
}

// ---------------------------------------------------------------------------
// Client-secret provisioning
//
// The Antigravity desktop app is an installed-app OAuth client: its
// id/secret are public identifiers baked into the shipped product (dsh-agy
// and Antigravity-Manager both embed the very same values verbatim and treat
// them as non-secret). This repository deliberately carries no credential
// literal, so when AGY_CLIENT_SECRET is unset we provision the public
// constant at login time from those reference sources — memory only; it is
// later persisted inside the encrypted account store by the normal login path.
// ---------------------------------------------------------------------------

const PUBLIC_SECRET_SOURCES = [
  'https://raw.githubusercontent.com/chaos-03x/dsh-agy/main/src/oauth/constants.ts',
  'https://raw.githubusercontent.com/lbjlaq/Antigravity-Manager/main/src-tauri/src/modules/oauth.rs',
]

let cachedPublicSecret: string | undefined

/** Pull the well-known public client secret out of a reference project source. */
function extractPublicSecret(text: string): string | undefined {
  const match = text.match(
    /(?:AGY_)?CLIENT_SECRET["']?\s*(?::\s*&str\s*)?[:=]\s*["']([A-Za-z0-9\-_]{20,})["']/,
  )
  return match?.[1]
}

async function fetchPublicClientSecret(): Promise<string | undefined> {
  if (cachedPublicSecret) return cachedPublicSecret
  for (const url of PUBLIC_SECRET_SOURCES) {
    try {
      const response = await safeFetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) continue
      const secret = extractPublicSecret(await response.text())
      if (secret) {
        cachedPublicSecret = secret
        log.info('public OAuth client credentials provisioned')
        return cachedPublicSecret
      }
    } catch {
      // source unreachable — try the next one
    }
  }
  return undefined
}

/**
 * Client secret for token exchanges: explicit environment override first,
 * then the runtime-provisioned public constant. Undefined only when neither
 * is reachable (offline); callers may still proceed — some installed-app
 * clients are accepted without a secret.
 */
export async function ensureClientSecret(): Promise<string | undefined> {
  const fromEnv = process.env.AGY_CLIENT_SECRET?.trim()
  if (fromEnv) return fromEnv
  return fetchPublicClientSecret()
}

// ---------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------

export interface PkcePair {
  verifier: string
  challenge: string
}

export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
  return { verifier, challenge }
}

interface OAuthStatePayload {
  verifier: string
  projectId?: string
}

export function encodeState(payload: OAuthStatePayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeState<T extends Partial<OAuthStatePayload>>(state: string): T {
  return JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as T
}

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

export interface AuthorizationRequest {
  url: string
  verifier: string
  state: string
  redirectUri: string
}

export function buildAuthorizationUrl(redirectUri: string): AuthorizationRequest {
  const { verifier, challenge } = generatePkcePair()
  const { clientId } = resolveClientCredentials()
  const url = new URL(OAUTH_AUTHORIZE_URL)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', AGY_SCOPES.join(' '))
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  const state = encodeState({ verifier })
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return { url: url.toString(), verifier, state, redirectUri }
}

// ---------------------------------------------------------------------------
// Token endpoints
// ---------------------------------------------------------------------------

interface TokenPayload {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  error?: string
  error_description?: string
}

export interface TokenGrant {
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

const TOKEN_TIMEOUT_MS = 15_000

function tokenRequestBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString()
}

async function postToken(
  params: Record<string, string>,
  clientSecretOverride?: string,
  proxyUrl?: string,
): Promise<TokenPayload> {
  const { clientId, clientSecret } = resolveClientCredentials()
  const effectiveSecret = clientSecretOverride?.trim() || clientSecret
  const credentials = { client_id: clientId, ...(effectiveSecret ? { client_secret: effectiveSecret } : {}) }
  const response = await safeFetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Accept: '*/*',
    },
    body: tokenRequestBody({ ...credentials, ...params }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    ...(proxyUrl ? { agyProxy: proxyUrl } : {}),
  })
  const payload = (await response.json().catch(() => ({}))) as TokenPayload
  if (!response.ok) {
    const detail = payload.error_description ?? payload.error ?? `HTTP ${response.status}`
    const hint = /client_secret/i.test(detail)
      ? '（自动获取公开凭据失败？检查网络/代理，或手动 export AGY_CLIENT_SECRET）'
      : ''
    throw new Error(`token endpoint rejected request: ${detail}${hint}`)
  }
  return payload
}

export interface ExchangeResult {
  grant: TokenGrant
}

/** Exchange an authorization code for tokens (refresh_token required). */
export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  redirectUri: string,
  clientSecretOverride?: string,
): Promise<ExchangeResult> {
  const payload = await postToken(
    {
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    },
    clientSecretOverride,
  )
  if (!payload.access_token) throw new Error('token response missing access_token')
  if (!payload.refresh_token) throw new Error('token response missing refresh_token')
  return {
    grant: {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + (typeof payload.expires_in === 'number' ? payload.expires_in : 3600) * 1000,
    },
  }
}

/**
 * Refresh an access token. `clientSecret` comes from the account record when
 * available (stored encrypted at login); falls back to the env-based resolver.
 * `proxyUrl` honors the account's own egress binding — token exchanges leave
 * the same IP identity as generation calls for that account.
 * Throws Error with message containing `invalid_grant` when Google has revoked
 * the refresh token (caller decides on backoff/re-confirm).
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientSecret?: string,
  proxyUrl?: string,
): Promise<TokenGrant> {
  const payload = await postToken({ refresh_token: refreshToken, grant_type: 'refresh_token' }, clientSecret, proxyUrl)
  if (!payload.access_token) throw new Error('refresh response missing access_token')
  return {
    accessToken: payload.access_token,
    // Google may omit refresh_token on refresh; keep the stored one.
    refreshToken,
    expiresAt: Date.now() + (typeof payload.expires_in === 'number' ? payload.expires_in : 3600) * 1000,
  }
}

export async function fetchUserEmail(accessToken: string, proxyUrl?: string): Promise<string | undefined> {
  try {
    const response = await safeFetch(`${OAUTH_USERINFO_URL}?alt=json`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
      ...(proxyUrl ? { agyProxy: proxyUrl } : {}),
    })
    if (!response.ok) return undefined
    const data = (await response.json()) as { email?: string }
    log.debug('userinfo fetched')
    return typeof data.email === 'string' && data.email ? data.email : undefined
  } catch {
    return undefined
  }
}
