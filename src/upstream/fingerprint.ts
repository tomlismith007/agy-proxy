/**
 * Per-account client identity (device fingerprint). Values must track the real
 * Antigravity product; pools are externalized here so stale versions never get
 * compiled into logic. Selection is stable per account (hash-seeded) so an
 * account keeps one consistent identity across requests by default.
 *
 * Pools can be refreshed without a rebuild via `<dataDir>/fingerprint.json`
 * (loaded once at startup by `loadFingerprintOverrides`): when the product
 * ships new versions, drop them into that file instead of editing code.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { safeFetch } from '../util/urlguard.js'
import { createLogger } from '../util/log.js'

const log = createLogger('fingerprint')

interface Fingerprint {
  version: string
  platform: 'windows' | 'darwin'
  arch: 'amd64' | 'arm64'
  osVersion: string
  sdkClient: string
}

const DEFAULT_VERSION_POOL = ['1.18.3', '1.17.0', '1.16.0'] as const

const DEFAULT_PLATFORM_POOL = [
  { platform: 'windows', arch: 'amd64' },
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'amd64' },
] as const

const DEFAULT_SDK_CLIENTS = [
  'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'google-cloud-sdk vscode/1.86.0',
  'google-cloud-sdk vscode/1.87.0',
  'google-cloud-sdk vscode/1.96.0',
] as const

/**
 * Electron-chrome layer of the bootstrap UA. A stale Chromium/Electron version
 * is just as detectable as a stale product version, so both are pool-driven.
 * NOTE: the Antigravity release feeds tracked by refreshVersionPool do not
 * carry Electron/Chrome versions — today these two pools can only be updated
 * manually via `<dataDir>/fingerprint.json`.
 */
const DEFAULT_CHROME_VERSIONS = ['138.0.7204.235'] as const
const DEFAULT_ELECTRON_VERSIONS = ['37.3.1'] as const

interface FingerprintPools {
  versions: readonly string[]
  platforms: readonly { platform: 'windows' | 'darwin'; arch: 'amd64' | 'arm64' }[]
  sdkClients: readonly string[]
  osVersions: { windows: readonly string[]; darwin: readonly string[] }
  chromeVersions: readonly string[]
  electronVersions: readonly string[]
}

let pools: FingerprintPools = {
  versions: DEFAULT_VERSION_POOL,
  platforms: DEFAULT_PLATFORM_POOL,
  sdkClients: DEFAULT_SDK_CLIENTS,
  osVersions: {
    windows: ['10.0.19045', '10.0.22621', '10.0.22631'],
    darwin: ['13.5.2', '14.2.1', '14.5'],
  },
  chromeVersions: DEFAULT_CHROME_VERSIONS,
  electronVersions: DEFAULT_ELECTRON_VERSIONS,
}

/**
 * Merge optional overrides from `<dataDir>/fingerprint.json`. Accepted shape:
 * `{ "versions": [...], "sdkClients": [...], "osVersions": { "windows": [...],
 * "darwin": [...] }, "versionFeeds": ["https://…"] }` — every field optional,
 * arrays of non-empty strings (feeds must be https URLs). Returns true when
 * overrides were applied.
 */
export function loadFingerprintOverrides(dataDir: string): boolean {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'fingerprint.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return false
  }
  const stringList = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.trim() !== '')
      ? (value as string[])
      : undefined

  const versions = stringList(raw.versions)
  const sdkClients = stringList(raw.sdkClients)
  const chromeVersions = stringList(raw.chromeVersions)
  const electronVersions = stringList(raw.electronVersions)
  const osRaw = raw.osVersions as Record<string, unknown> | undefined
  const osVersions = osRaw
    ? {
        windows: stringList(osRaw.windows) ?? [...pools.osVersions.windows],
        darwin: stringList(osRaw.darwin) ?? [...pools.osVersions.darwin],
      }
    : pools.osVersions
  const feedsRaw = Array.isArray(raw.versionFeeds)
    ? (raw.versionFeeds as unknown[]).filter(
        (u): u is string => typeof u === 'string' && /^https:\/\//i.test(u.trim()),
      )
    : undefined
  if (feedsRaw && feedsRaw.length > 0) versionFeeds = feedsRaw.map((u) => u.trim())

  if (!versions && !sdkClients && !osRaw && !feedsRaw && !chromeVersions && !electronVersions) return false
  pools = {
    versions: versions ?? pools.versions,
    platforms: pools.platforms,
    sdkClients: sdkClients ?? pools.sdkClients,
    osVersions,
    chromeVersions: chromeVersions ?? pools.chromeVersions,
    electronVersions: electronVersions ?? pools.electronVersions,
  }
  return true
}

function hashIndex(seed: string, modulus: number): number {
  if (modulus <= 0) return 0
  const digest = createHash('sha256').update(seed, 'utf8').digest()
  // Enough entropy in the first bytes for these tiny pools.
  return digest[0]! % modulus
}

/** Stable identity for an account key (email); unknown keys get the default. */
export function pickFingerprint(accountKey?: string): Fingerprint {
  if (!accountKey || accountKey.trim().length === 0) {
    return {
      version: pools.versions[0]!,
      platform: pools.platforms[0]!.platform,
      arch: pools.platforms[0]!.arch,
      osVersion: pools.osVersions[pools.platforms[0]!.platform][0]!,
      sdkClient: pools.sdkClients[0]!,
    }
  }
  const seed = accountKey.trim().toLowerCase()
  const version = pools.versions[hashIndex(`${seed}:version`, pools.versions.length)]!
  const platformPair = pools.platforms[hashIndex(`${seed}:platform`, pools.platforms.length)]!
  const sdkClient = pools.sdkClients[hashIndex(`${seed}:sdk`, pools.sdkClients.length)]!
  const osList = pools.osVersions[platformPair.platform]
  const osVersion = osList[hashIndex(`${seed}:os`, osList.length)]!
  return {
    version,
    platform: platformPair.platform,
    arch: platformPair.arch,
    osVersion,
    sdkClient,
  }
}

/** Generation-call UA shape: `antigravity/{version} {platform}/{arch}`. */
export function getGenerationUserAgent(accountKey?: string): string {
  const fp = pickFingerprint(accountKey)
  return `antigravity/${fp.version} ${fp.platform}/${fp.arch}`
}

/**
 * Electron-style UA for bootstrap calls (loadCodeAssist / onboardUser /
 * discovery). The Chromium/Electron layers are picked with the same per-account
 * stable hash so one account keeps a consistent full UA across requests.
 */
export function getBootstrapUserAgent(accountKey?: string): string {
  const fp = pickFingerprint(accountKey)
  const seed = accountKey?.trim().toLowerCase() ?? ''
  const chrome = pools.chromeVersions[hashIndex(`${seed}:chrome`, pools.chromeVersions.length)]!
  const electron = pools.electronVersions[hashIndex(`${seed}:electron`, pools.electronVersions.length)]!
  const osPart =
    fp.platform === 'windows'
      ? 'Windows NT 10.0; Win64; x64'
      : `Macintosh; Intel Mac OS X 10_15_7`
  return `Mozilla/5.0 (${osPart}) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${fp.version} Chrome/${chrome} Electron/${electron} Safari/537.36`
}

/** Client-Metadata header — ideType only; extra keys are rejected upstream. */
export function getClientMetadataHeader(): string {
  return '{"ideType":"ANTIGRAVITY"}'
}

export function getXGoogApiClient(accountKey?: string): string {
  return pickFingerprint(accountKey).sdkClient
}

// ---------------------------------------------------------------------------
// Client-version freshness (live release feeds)
// ---------------------------------------------------------------------------

/**
 * A stale UA version is the most detectable fingerprint anomaly, so the
 * version pool head is refreshed from the product's own public release feeds
 * (same sources dsh-agy tracks). 6h TTL, single in-flight dedupe; a feed
 * result only enters the pool when it is strictly newer semver.
 */

const VERSION_TTL_MS = 6 * 60 * 60_000
const VERSION_FETCH_TIMEOUT_MS = 5_000

let versionFeeds: readonly string[] = [
  // Antigravity IDE auto-update release feed (JSON array of {version}).
  'https://antigravity-auto-updater-974169037036.us-central1.run.app/releases',
  // Antigravity CLI GitHub latest release ({tag_name}).
  'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest',
]

let versionFetchedAt = 0
let versionInflight: Promise<boolean> | null = null

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0)
  const pb = b.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function isSemver(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value.trim())
}

/** Newest pure-semver from an IDE feed entry list or a GitHub release object. */
function extractFeedVersion(payload: unknown): string | null {
  if (Array.isArray(payload)) {
    let best: string | null = null
    for (const entry of payload) {
      const candidate = (entry as { version?: unknown } | undefined)?.version
      if (isSemver(candidate) && (!best || compareSemver(candidate.trim(), best) > 0)) {
        best = candidate!.trim()
      }
    }
    return best
  }
  if (payload && typeof payload === 'object') {
    const record = payload as { tag_name?: unknown; name?: unknown }
    for (const field of [record.tag_name, record.name]) {
      if (isSemver(field)) return field.trim()
    }
  }
  return null
}

async function refreshVersionPool(): Promise<boolean> {
  for (const feed of versionFeeds) {
    try {
      const response = await safeFetch(feed, {
        signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) continue
      const version = extractFeedVersion(await response.json())
      if (!version) continue
      const current = pools.versions[0] ?? ''
      if (compareSemver(version, current) > 0 && !pools.versions.includes(version)) {
        pools = { ...pools, versions: [version, ...pools.versions] }
        log.info(`fingerprint version pool refreshed: ${version}`)
      }
      return true
    } catch {
      // unreachable feed / timeout / bad JSON — try the next source
    }
  }
  return false
}

/**
 * Fetch the newest client version into the pool at most once per TTL.
 * Concurrent callers share one probe; failures leave the static pool intact.
 */
async function refreshClientVersion(now = Date.now()): Promise<boolean> {
  // Internal-only: the public surface is startVersionRefreshLoop(). Kept
  // unexported so callers go through the loop.
  if (now - versionFetchedAt < VERSION_TTL_MS) return true
  if (!versionInflight) {
    versionInflight = refreshVersionPool()
      .catch(() => false)
      .then((ok) => {
        if (ok) versionFetchedAt = now
        return ok
      })
      .finally(() => {
        versionInflight = null
      })
  }
  return versionInflight
}

export interface VersionRefresher {
  stop(): void
}

/**
 * Background loop keeping the version pool fresh while the server runs:
 * one probe at startup, then every TTL. Never blocks or crashes serving.
 */
export function startVersionRefreshLoop(): VersionRefresher {
  let stopped = false
  const run = (): void => {
    void refreshClientVersion().catch(() => {})
  }
  run()
  const timer = setInterval(() => {
    if (!stopped) run()
  }, VERSION_TTL_MS)
  timer.unref?.()
  return {
    stop(): void {
      stopped = true
      clearInterval(timer)
    },
  }
}
