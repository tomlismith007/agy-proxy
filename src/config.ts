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
  /** Log full request/response exchanges to dataDir/debug/ for troubleshooting. */
  debugLog: boolean
  /** Exact-match request model id -> upstream model id remapping. */
  modelAliases: Record<string, string>
  /** Hide alias models in /v1/models when discovery is available. */
  onlyRealModels: boolean
}

const DEFAULT_PORT = 8045

interface RawConfigFile {
  host?: unknown
  port?: unknown
  apiKey?: unknown
  debugLog?: unknown
  modelAliases?: unknown
  onlyRealModels?: unknown
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
  const modelAliases =
    raw.modelAliases && typeof raw.modelAliases === 'object' && !Array.isArray(raw.modelAliases)
      ? (raw.modelAliases as Record<string, string>)
      : {}

  return { host, port, dataDir, apiKey, debugLog, modelAliases, onlyRealModels }
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
