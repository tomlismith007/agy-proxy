/**
 * Request accounting for the admin console: lifetime counters, per-format
 * breakdowns and a ring of recent requests. The live counters stay
 * process-local (restart resets them); a UsageHistory sink attached during
 * server wiring additionally persists every request into per-day usage files
 * so daily token/request totals survive restarts. No payload content is kept.
 */

import type { UsageHistory } from './usage-history.js'

export interface RequestStat {
  /** Epoch ms when the request finished. */
  time: number
  format: string
  model: string
  /** Account that served the successful attempt, when one got that far. */
  account?: string
  status: number
  ok: boolean
  latencyMs: number
  stream?: boolean
  promptTokens?: number
  outputTokens?: number
  thoughtsTokens?: number
  error?: string
}

export interface StatsSnapshot {
  startedAt: number
  totals: {
    requests: number
    success: number
    failures: number
    promptTokens: number
    outputTokens: number
    thoughtsTokens: number
  }
  byFormat: Record<string, { requests: number; failures: number }>
  recent: RequestStat[]
}

const MAX_RECENT = 100

class StatsTracker {
  readonly startedAt = Date.now()
  /** Persistent daily-usage sink, attached once during server wiring. */
  private history: UsageHistory | null = null
  private requests = 0
  private success = 0
  private failures = 0
  private promptTokens = 0
  private outputTokens = 0
  private thoughtsTokens = 0
  private byFormat = new Map<string, { requests: number; failures: number }>()
  private recent: RequestStat[] = []

  /** Attach the persistent daily-usage sink (server wiring; last one wins). */
  attachHistory(history: UsageHistory): void {
    this.history = history
  }

  record(stat: RequestStat): void {
    this.requests += 1
    if (stat.ok) this.success += 1
    else this.failures += 1
    this.promptTokens += stat.promptTokens ?? 0
    this.outputTokens += stat.outputTokens ?? 0
    this.thoughtsTokens += stat.thoughtsTokens ?? 0

    const entry = this.byFormat.get(stat.format) ?? { requests: 0, failures: 0 }
    entry.requests += 1
    if (!stat.ok) entry.failures += 1
    this.byFormat.set(stat.format, entry)

    this.recent.push(stat)
    if (this.recent.length > MAX_RECENT) this.recent.shift()

    // Forward into the persistent per-day history (kept in memory there,
    // flushed to <dataDir>/usage/ on a debounce). Never throws.
    this.history?.record(stat)
  }

  snapshot(): StatsSnapshot {
    return {
      startedAt: this.startedAt,
      totals: {
        requests: this.requests,
        success: this.success,
        failures: this.failures,
        promptTokens: this.promptTokens,
        outputTokens: this.outputTokens,
        thoughtsTokens: this.thoughtsTokens,
      },
      byFormat: Object.fromEntries(this.byFormat),
      recent: [...this.recent].reverse(),
    }
  }
}

/** Process-wide tracker shared by every chat request. */
export const stats = new StatsTracker()
