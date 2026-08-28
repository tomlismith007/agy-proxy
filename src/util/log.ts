/**
 * Minimal leveled logger. AGY_PROXY_LOG_LEVEL=debug|info|warn|error (default info).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const configured = ((): LogLevel => {
  const raw = (process.env.AGY_PROXY_LOG_LEVEL ?? 'info').toLowerCase()
  return raw === 'debug' || raw === 'warn' || raw === 'error' ? raw : 'info'
})()

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[configured]
}

function write(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (!enabled(level)) return
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] (${scope}) ${message}`
  const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (extra !== undefined) target(line, extra)
  else target(line)
}

export interface Logger {
  debug(message: string, extra?: unknown): void
  info(message: string, extra?: unknown): void
  warn(message: string, extra?: unknown): void
  error(message: string, extra?: unknown): void
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
  }
}

/** Strip bearer tokens / api keys from text destined for logs. */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer ***')
    .replace(/sk-agy-[A-Za-z0-9._\-]+/g, 'sk-agy-***')
    .replace(/ya29\.[A-Za-z0-9._\-]+/g, 'ya29.***')
}

/** Human-readable message from an arbitrary thrown value. */
export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
