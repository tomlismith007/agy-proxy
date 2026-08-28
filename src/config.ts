/**
 * Configuration resolution: defaults < config.json < environment variables.
 * Data lives under ~/.agy-proxy by default (override: AGY_PROXY_HOME).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateApiKey } from './util/crypto.js'

export interface AppConfig {
  host: string
  port: number
  dataDir: string
  apiKey: string
  /** Named gateway keys (client-facing label -> key) accepted alongside apiKey on /v1/*. */
  apiKeys: Record<string, string>
  /**
   * Log full request/response exchanges to dataDir/debug/ for troubleshooting.
   * CAUTION: payloads include conversation content — do not share or commit
   * that directory when enabled.
   */
  debugLog: boolean
  /** Exact-match request model id -> upstream model id remapping. */
  modelAliases: Record<string, string>
  /** Hide alias models in /v1/models when discovery is available. */
  onlyRealModels: boolean
  /** Egress HTTP proxy URL (e.g. http://127.0.0.1:7890); env AGY_PROXY_PROXY wins. */
  proxy?: string
  /** Max simultaneous in-flight upstream requests (risk-control pacing). */
  maxConcurrentUpstream: number
  /** When true, `serve` refuses to start (emergency stop). Runtime hot switch: KILL file. */
  killSwitch?: boolean
  /** Days of daily usage history to keep in <dataDir>/usage (0 = forever). */
  usageRetentionDays?: number
}

const DEFAULT_PORT = 8045

interface RawConfigFile {
  host?: unknown
  port?: unknown
  apiKey?: unknown
  apiKeys?: unknown
  debugLog?: unknown
  modelAliases?: unknown
  onlyRealModels?: unknown
  proxy?: unknown
  maxConcurrentUpstream?: unknown
  killSwitch?: unknown
  usageRetentionDays?: unknown
}

export function resolveDataDir(): string {
  const env = process.env.AGY_PROXY_HOME?.trim()
  if (env) return path.resolve(env)
  return path.join(os.homedir(), '.agy-proxy')
}

function readConfigFile(dataDir: string): RawConfigFile {
  const file = path.join(dataDir, 'config.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RawConfigFile
  } catch {
    return {}
  }
}

/**
 * Resolve configuration, creating the data directory on first run.
 * When no API key exists yet, one is generated and persisted into config.json
 * so clients keep a stable key across restarts.
 */
export function loadConfig(): AppConfig {
  const dataDir = resolveDataDir()
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, 'config.json')

  const raw = readConfigFile(dataDir)

  let apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : ''
  if (!apiKey) apiKey = process.env.AGY_API_KEY?.trim() || ''
  if (!apiKey) {
    apiKey = generateApiKey()
    let existing: RawConfigFile = {}
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8')) as RawConfigFile
    } catch {
      existing = {}
    }
    fs.writeFileSync(file, JSON.stringify({ ...existing, apiKey }, null, 2) + '\n', { mode: 0o600 })
  }

  const host = str(process.env.AGY_HOST) ?? str(raw.host) ?? '127.0.0.1'
  const port = int(process.env.AGY_PORT) ?? int(raw.port) ?? DEFAULT_PORT
  const debugLog = bool(process.env.AGY_DEBUG_LOG) ?? bool(raw.debugLog) ?? false
  const onlyRealModels = bool(raw.onlyRealModels) ?? false
  const proxy =
    str(process.env.AGY_PROXY_PROXY) ??
    (typeof raw.proxy === 'string' && raw.proxy.trim() !== '' ? raw.proxy.trim() : undefined)
  // Single source of truth for urlguard's dispatcher.
  if (proxy) process.env.AGY_PROXY_PROXY = proxy
  const modelAliases =
    raw.modelAliases && typeof raw.modelAliases === 'object' && !Array.isArray(raw.modelAliases)
      ? (raw.modelAliases as Record<string, string>)
      : {}
  const maxConcurrentUpstream =
    int(process.env.AGY_MAX_CONCURRENT) ?? int(raw.maxConcurrentUpstream) ?? 2
  const killSwitch = bool(raw.killSwitch) ?? false
  const usageRetentionDays =
    int(process.env.AGY_USAGE_RETENTION_DAYS) ?? int(raw.usageRetentionDays) ?? 0
  const apiKeys =
    raw.apiKeys && typeof raw.apiKeys === 'object' && !Array.isArray(raw.apiKeys)
      ? Object.fromEntries(
          Object.entries(raw.apiKeys as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
          ),
        )
      : {}

  return {
    host,
    port,
    dataDir,
    apiKey,
    apiKeys,
    debugLog,
    modelAliases,
    onlyRealModels,
    ...(proxy ? { proxy } : {}),
    maxConcurrentUpstream,
    ...(killSwitch ? { killSwitch: true } : {}),
    ...(usageRetentionDays > 0 ? { usageRetentionDays } : {}),
  }
}

/**
 * Merge a patch into config.json, preserving unknown keys. Callers remain
 * responsible for applying the same patch to the in-memory AppConfig.
 */
export function persistConfigPatch(
  dataDir: string,
  patch: Partial<Omit<AppConfig, 'dataDir'>>,
): void {
  const file = path.join(dataDir, 'config.json')
  let existing: RawConfigFile = {}
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8')) as RawConfigFile
  } catch {
    existing = {}
  }
  fs.writeFileSync(file, JSON.stringify({ ...existing, ...patch }, null, 2) + '\n', { mode: 0o600 })
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
function int(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}
function bool(value: unknown): boolean | undefined {
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
  return undefined
}
