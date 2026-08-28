/**
 * Persistent daily usage history: per-day aggregate records (request counts,
 * token totals, per-format / per-model / per-account breakdowns and an hourly
 * trend) stored as <dataDir>/usage/YYYY-MM-DD.json. record() mutates memory
 * only; a trailing debounced timer writes the day atomically (tmp + rename).
 * The local timezone defines the day boundary, and no payload content is ever
 * kept here — counts only.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createLogger, errText } from './log.js'

const log = createLogger('usage')

const STORE_VERSION = 1
const DEFAULT_FLUSH_DELAY_MS = 3_000

/** Aggregated counters for one slice of usage (day, format, model, account). */
export interface UsageTotals {
  requests: number
  success: number
  failures: number
  promptTokens: number
  outputTokens: number
  thoughtsTokens: number
}

/** Hourly trend bucket within a day. */
export interface UsageHourBucket {
  requests: number
  promptTokens: number
  outputTokens: number
  thoughtsTokens: number
}

/** One persisted day file (<dataDir>/usage/YYYY-MM-DD.json). */
export interface DayUsage {
  version: number
  /** Local-timezone date key: YYYY-MM-DD. */
  date: string
  totals: UsageTotals
  byFormat: Record<string, UsageTotals>
  byModel: Record<string, UsageTotals>
  byAccount: Record<string, UsageTotals>
  byHour: UsageHourBucket[]
  updatedAt: number
}

/** Reduced day entry for listings. */
export interface DayUsageSummary {
  date: string
  totals: UsageTotals
  updatedAt: number
}

/** Structural subset of stats.RequestStat accepted by record(). */
export interface UsageRecordInput {
  /** Epoch ms when the request finished (drives the day/hour bucket). */
  time: number
  format: string
  model: string
  account?: string
  ok: boolean
  promptTokens?: number
  outputTokens?: number
  thoughtsTokens?: number
}

const DAY_PARTS_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/

/**
 * Canonicalize a loosely formatted day string (YYYY-M-D or YYYY-MM-DD) into a
 * YYYY-MM-DD key. Only digit-only regex capture groups are re-emitted, so a
 * request-supplied value can never contribute anything but digits to a usage
 * file path. Returns null for anything that is not a pure digit key.
 */
export function parseDayKey(input: string): string | null {
  const m = input.trim().match(DAY_PARTS_RE)
  if (!m) return null
  return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
}

function emptyTotals(): UsageTotals {
  return { requests: 0, success: 0, failures: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0 }
}

function emptyHourBuckets(): UsageHourBucket[] {
  return Array.from({ length: 24 }, () => ({ requests: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0 }))
}

/** Local-timezone day key (YYYY-MM-DD) for an epoch-ms timestamp. */
export function localDateKey(time: number): string {
  const d = new Date(time)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

function addTotals(into: UsageTotals, stat: UsageRecordInput): void {
  into.requests += 1
  if (stat.ok) into.success += 1
  else into.failures += 1
  into.promptTokens += stat.promptTokens ?? 0
  into.outputTokens += stat.outputTokens ?? 0
  into.thoughtsTokens += stat.thoughtsTokens ?? 0
}

function bucketFor(map: Record<string, UsageTotals>, key: string): UsageTotals {
  const existing = map[key]
  if (existing) return existing
  const created = emptyTotals()
  map[key] = created
  return created
}

function isValidDayShape(value: unknown): value is DayUsage {
  if (!value || typeof value !== 'object') return false
  const day = value as DayUsage
  return (
    typeof day.date === 'string' &&
    typeof day.totals === 'object' &&
    day.totals !== null &&
    Array.isArray(day.byHour)
  )
}

export class UsageHistory {
  private readonly usageDir: string
  /** Days of history to keep; 0 keeps everything forever. */
  private readonly retentionDays: number
  private readonly flushDelayMs: number
  private current: DayUsage | null = null
  private dirty = false
  private flushTimer: NodeJS.Timeout | null = null

  constructor(dataDir: string, options: { retentionDays?: number; flushDelayMs?: number } = {}) {
    this.usageDir = path.join(dataDir, 'usage')
    this.retentionDays = Number.isFinite(options.retentionDays) ? Math.max(0, Math.trunc(options.retentionDays!)) : 0
    this.flushDelayMs = Number.isFinite(options.flushDelayMs)
      ? Math.max(0, Math.trunc(options.flushDelayMs!))
      : DEFAULT_FLUSH_DELAY_MS
    this.pruneExpiredDays()
  }

  /** Record one finished request into the current (or rolled-over) day. Never throws. */
  record(stat: UsageRecordInput): void {
    try {
      this.recordInto(stat)
    } catch (error) {
      log.warn(`usage record failed: ${errText(error)}`)
    }
  }

  /** Flush any pending day to disk; a no-op when nothing changed. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.current || !this.dirty) return
    if (this.writeFile(this.current)) this.dirty = false
  }

  /** Most recent days, newest first. The live in-memory day wins over disk. */
  listDays(limit = 30): DayUsageSummary[] {
    // Clamp the caller-supplied limit here so no request-derived number
    // reaches the slicing logic unvalidated.
    const max = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 366) : 30
    const byDate = new Map<string, DayUsageSummary>()
    try {
      const files = fs
        .readdirSync(this.usageDir)
        .filter((name) => DAY_FILE_RE.test(name))
        .sort((a, b) => a.localeCompare(b))
        .reverse()
      for (const name of files) {
        if (byDate.size >= max) break
        const day = this.readDayFileByName(name)
        if (day) byDate.set(day.date, { date: day.date, totals: day.totals, updatedAt: day.updatedAt })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        log.warn(`usage listing failed: ${errText(error)}`)
      }
    }
    if (this.current) {
      byDate.set(this.current.date, {
        date: this.current.date,
        totals: this.current.totals,
        updatedAt: this.current.updatedAt,
      })
    }
    return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, max)
  }

  /** Full breakdown for one day (YYYY-MM-DD); the live in-memory day wins. */
  getDay(date: string): DayUsage | null {
    const key = parseDayKey(date)
    if (!key) return null
    if (this.current?.date === key) return this.current
    // Resolve the canonical key against actual directory entries so the file
    // path is built only from filesystem names, never from request data.
    const name = this.findDayFile(key)
    return name ? this.readDayFileByName(name) : null
  }

  // ------------------------------------------------------------- internals --

  private recordInto(stat: UsageRecordInput): void {
    if (!Number.isFinite(stat.time)) return
    const date = localDateKey(stat.time)
    if (!this.current || this.current.date !== date) {
      if (this.current) this.flush() // rollover: persist the finished day first
      this.current = this.loadOrStartDay(date)
    }
    const day = this.current
    addTotals(day.totals, stat)
    addTotals(bucketFor(day.byFormat, stat.format), stat)
    addTotals(bucketFor(day.byModel, stat.model || '-'), stat)
    if (stat.account) addTotals(bucketFor(day.byAccount, stat.account), stat)
    const hour = day.byHour[new Date(stat.time).getHours()]!
    hour.requests += 1
    hour.promptTokens += stat.promptTokens ?? 0
    hour.outputTokens += stat.outputTokens ?? 0
    hour.thoughtsTokens += stat.thoughtsTokens ?? 0
    day.updatedAt = Date.now()
    this.scheduleFlush()
  }

  private loadOrStartDay(date: string): DayUsage {
    const existing = this.readDayFileByName(`${date}.json`)
    return (
      existing ?? {
        version: STORE_VERSION,
        date,
        totals: emptyTotals(),
        byFormat: {},
        byModel: {},
        byAccount: {},
        byHour: emptyHourBuckets(),
        updatedAt: Date.now(),
      }
    )
  }

  /**
   * Directory entry for a canonical day key, if one exists on disk. Returns
   * the name taken from the listing itself, so callers never build a path
   * from a request-derived string.
   */
  private findDayFile(key: string): string | null {
    const wanted = `${key}.json`
    if (!DAY_FILE_RE.test(wanted)) return null
    try {
      for (const entry of fs.readdirSync(this.usageDir)) {
        if (entry === wanted) return entry
      }
      return null
    } catch {
      return null
    }
  }

  /** Read one day file by its directory-entry name (never raw request data). */
  private readDayFileByName(name: string): DayUsage | null {
    if (!DAY_FILE_RE.test(name)) return null
    // Same containment rule as the admin page's safeAsset: resolve and prove
    // the result stayed inside the usage directory.
    const file = path.resolve(this.usageDir, name)
    if (!file.startsWith(this.usageDir + path.sep)) return null
    const key = name.slice(0, -'.json'.length)
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!isValidDayShape(parsed) || parsed.date !== key) {
        log.warn(`usage file for ${key} is malformed; ignoring`)
        return null
      }
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        log.warn(
          `usage file for ${key} unreadable (${errText(error)}); ignoring`,
        )
      }
      return null
    }
  }

  /** Atomic write: temp file + rename so a crash never truncates the day. */
  private writeFile(day: DayUsage): boolean {
    try {
      fs.mkdirSync(this.usageDir, { recursive: true })
      const file = path.join(this.usageDir, `${day.date}.json`)
      if (path.dirname(file) !== this.usageDir) return false
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(day, null, 2) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, file)
      return true
    } catch (error) {
      log.warn(`usage write failed for ${day.date}: ${errText(error)}`)
      return false
    }
  }

  private scheduleFlush(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, this.flushDelayMs)
    // Never keep the process alive just for a pending flush.
    this.flushTimer.unref()
  }

  /** Drop day files older than the retention window (0 disables). */
  private pruneExpiredDays(): void {
    if (this.retentionDays <= 0) return
    const cutoff = localDateKey(Date.now() - this.retentionDays * 86_400_000)
    let files: string[]
    try {
      files = fs.readdirSync(this.usageDir)
    } catch {
      return
    }
    for (const name of files) {
      if (!DAY_FILE_RE.test(name) || name.slice(0, 10) >= cutoff) continue
      try {
        fs.unlinkSync(path.join(this.usageDir, name))
        log.info(`pruned expired usage file ${name}`)
      } catch {
        // best-effort cleanup
      }
    }
  }
}