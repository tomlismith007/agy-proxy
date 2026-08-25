/**
 * Per-account client identity (device fingerprint). Values must track the real
 * Antigravity product; pools are externalized here so stale versions never get
 * compiled into logic. Selection is stable per account (hash-seeded) so an
 * account keeps one consistent identity across requests by default.
 */

import { createHash } from 'node:crypto'

interface Fingerprint {
  version: string
  platform: 'windows' | 'darwin'
  arch: 'amd64' | 'arm64'
  osVersion: string
  sdkClient: string
}

const VERSION_POOL = ['1.18.3', '1.17.0', '1.16.0'] as const

const PLATFORM_POOL = [
  { platform: 'windows', arch: 'amd64' },
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'amd64' },
] as const

const SDK_CLIENTS = [
  'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'google-cloud-sdk vscode/1.86.0',
  'google-cloud-sdk vscode/1.87.0',
  'google-cloud-sdk vscode/1.96.0',
] as const

const DEFAULT_FINGERPRINT: Fingerprint = {
  version: VERSION_POOL[0],
  platform: PLATFORM_POOL[0].platform,
  arch: PLATFORM_POOL[0].arch,
  osVersion: '10.0.22631',
  sdkClient: SDK_CLIENTS[0],
}

function hashIndex(seed: string, modulus: number): number {
  if (modulus <= 0) return 0
  const digest = createHash('sha256').update(seed, 'utf8').digest()
  // Enough entropy in the first bytes for these tiny pools.
  return digest[0]! % modulus
}

/** Stable identity for an account key (email); unknown keys get the default. */
export function pickFingerprint(accountKey?: string): Fingerprint {
  if (!accountKey || accountKey.trim().length === 0) return DEFAULT_FINGERPRINT
  const seed = accountKey.trim().toLowerCase()
  const version = VERSION_POOL[hashIndex(`${seed}:version`, VERSION_POOL.length)]!
  const platformPair = PLATFORM_POOL[hashIndex(`${seed}:platform`, PLATFORM_POOL.length)]!
  const sdkClient = SDK_CLIENTS[hashIndex(`${seed}:sdk`, SDK_CLIENTS.length)]!
  const osVersion =
    platformPair.platform === 'windows'
      ? ['10.0.19045', '10.0.22621', '10.0.22631'][hashIndex(`${seed}:os`, 3)]!
      : ['13.5.2', '14.2.1', '14.5'][hashIndex(`${seed}:os`, 3)]!
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

/** Electron-style UA for bootstrap calls (loadCodeAssist / onboardUser / discovery). */
export function getBootstrapUserAgent(accountKey?: string): string {
  const fp = pickFingerprint(accountKey)
  const osPart =
    fp.platform === 'windows'
      ? 'Windows NT 10.0; Win64; x64'
      : `Macintosh; Intel Mac OS X 10_15_7`
  return `Mozilla/5.0 (${osPart}) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${fp.version} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`
}

/** Client-Metadata header — ideType only; extra keys are rejected upstream. */
export function getClientMetadataHeader(): string {
  return '{"ideType":"ANTIGRAVITY"}'
}

export function getXGoogApiClient(accountKey?: string): string {
  return pickFingerprint(accountKey).sdkClient
}
