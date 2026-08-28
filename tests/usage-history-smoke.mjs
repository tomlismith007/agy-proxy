/**
 * Offline usage-history smoke test (no network): daily aggregation, per-slice
 * breakdowns, atomic flush + reload, day rollover, corrupt-file resilience
 * and retention pruning. Run:
 *   npm run build:api && node tests/usage-history-smoke.mjs
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { UsageHistory, localDateKey } = await import('../dist/util/usage-history.js')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-'))
}

function stat(overrides = {}) {
  return { time: Date.now(), format: 'openai', model: 'gemini-test', ok: true, ...overrides }
}

// --- 1. aggregation + slices + atomic flush + reload --------------------------
{
  const dir = tmpDir()
  const usage = new UsageHistory(dir, { flushDelayMs: 10 })
  const now = Date.now()
  usage.record(stat({ time: now, model: 'm1', account: 'a@x', promptTokens: 10, outputTokens: 20, thoughtsTokens: 5 }))
  usage.record(stat({ time: now, format: 'anthropic', model: 'm1', account: 'a@x', ok: false, promptTokens: 3 }))
  usage.record(stat({ time: now, model: 'm2', account: 'b@x', promptTokens: 1, outputTokens: 2, thoughtsTokens: 3 }))
  usage.flush()

  const today = localDateKey(now)
  const file = path.join(dir, 'usage', `${today}.json`)
  assert.ok(fs.existsSync(file), 'day file written on flush')
  assert.ok(!fs.existsSync(`${file}.tmp`), 'atomic write leaves no tmp file')

  const reloaded = new UsageHistory(dir)
  const day = reloaded.getDay(today)
  assert.ok(day, 'day readable after reload')
  assert.equal(day.totals.requests, 3)
  assert.equal(day.totals.success, 2)
  assert.equal(day.totals.failures, 1)
  assert.equal(day.totals.promptTokens, 14)
  assert.equal(day.totals.outputTokens, 22)
  assert.equal(day.totals.thoughtsTokens, 8)
  assert.equal(day.byFormat.openai.requests, 2)
  assert.equal(day.byFormat.anthropic.failures, 1)
  assert.equal(day.byModel.m1.requests, 2)
  assert.equal(day.byAccount['b@x'].promptTokens, 1)
  const hour = day.byHour[new Date(now).getHours()]
  assert.equal(hour.requests, 3)
  assert.equal(hour.outputTokens, 22)

  const days = reloaded.listDays(5)
  assert.equal(days.length, 1)
  assert.equal(days[0].date, today)
  assert.equal(days[0].totals.requests, 3)

  fs.rmSync(dir, { recursive: true, force: true })
}

// --- 2. day rollover persists the previous day --------------------------------
{
  const dir = tmpDir()
  const usage = new UsageHistory(dir, { flushDelayMs: 60_000 }) // no auto-flush during the test
  const now = Date.now()
  const yesterday = now - 86_400_000
  usage.record(stat({ time: yesterday, model: 'old' }))
  usage.record(stat({ time: now, model: 'new' }))
  assert.ok(
    fs.existsSync(path.join(dir, 'usage', `${localDateKey(yesterday)}.json`)),
    'previous day flushed on rollover',
  )
  const day = usage.getDay(localDateKey(now))
  assert.equal(day.totals.requests, 1)
  assert.equal(day.byModel['new'].requests, 1)
  const oldDay = usage.getDay(localDateKey(yesterday))
  assert.equal(oldDay.totals.requests, 1)
  assert.equal(oldDay.byModel['old'].requests, 1)
  fs.rmSync(dir, { recursive: true, force: true })
}

// --- 3. corrupt day file is ignored and rewritten ------------------------------
{
  const dir = tmpDir()
  const today = localDateKey(Date.now())
  const usageDir = path.join(dir, 'usage')
  fs.mkdirSync(usageDir, { recursive: true })
  fs.writeFileSync(path.join(usageDir, `${today}.json`), '{oops', 'utf8')

  const usage = new UsageHistory(dir, { flushDelayMs: 10 })
  assert.equal(usage.getDay(today), null, 'corrupt file -> null')
  assert.equal(usage.listDays(5).length, 0, 'corrupt file skipped in listing')

  usage.record(stat({ model: 'm' }))
  usage.flush()
  const day = usage.getDay(today)
  assert.equal(day.totals.requests, 1, 'fresh day started over corrupt file')
  fs.rmSync(dir, { recursive: true, force: true })
}

// --- 4. retention pruning ------------------------------------------------------
{
  const dir = tmpDir()
  const usageDir = path.join(dir, 'usage')
  fs.mkdirSync(usageDir, { recursive: true })
  const old = localDateKey(Date.now() - 30 * 86_400_000)
  const recent = localDateKey(Date.now() - 1 * 86_400_000)
  for (const d of [old, recent]) {
    fs.writeFileSync(
      path.join(usageDir, `${d}.json`),
      JSON.stringify({
        version: 1,
        date: d,
        totals: { requests: 1, success: 1, failures: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0 },
        byFormat: {},
        byModel: {},
        byAccount: {},
        byHour: [],
        updatedAt: 0,
      }),
      'utf8',
    )
  }

  new UsageHistory(dir, { retentionDays: 7 }) // constructor prunes
  assert.ok(!fs.existsSync(path.join(usageDir, `${old}.json`)), 'old day pruned')
  assert.ok(fs.existsSync(path.join(usageDir, `${recent}.json`)), 'recent day kept')

  const dir2 = tmpDir()
  const usageDir2 = path.join(dir2, 'usage')
  fs.mkdirSync(usageDir2, { recursive: true })
  fs.writeFileSync(path.join(usageDir2, `${old}.json`), '{}', 'utf8')
  new UsageHistory(dir2) // retention disabled by default
  assert.ok(fs.existsSync(path.join(usageDir2, `${old}.json`)), 'no pruning when disabled')

  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(dir2, { recursive: true, force: true })
}

// --- 5. record() never throws, invalid input ignored ---------------------------
{
  const dir = tmpDir()
  const usage = new UsageHistory(dir, { flushDelayMs: 10 })
  usage.record({ time: NaN, format: 'openai', model: 'x', ok: true })
  usage.flush()
  assert.equal(usage.listDays(5).length, 0, 'invalid timestamp ignored')
  assert.equal(usage.getDay(localDateKey(Date.now())), null, 'no day created for invalid input')
  const usageDir = path.join(dir, 'usage')
  assert.ok(!fs.existsSync(usageDir) || fs.readdirSync(usageDir).length === 0, 'no file for invalid input')
  fs.rmSync(dir, { recursive: true, force: true })
}

// --- 6. day keys are format-checked before touching the fs (path traversal) ----
{
  const dir = tmpDir()
  const usage = new UsageHistory(dir, { flushDelayMs: 10 })
  for (const evil of ['../../.credentials', '2026-08-28.json\0', '....', '2026-08-28/../../x', 'a'.repeat(300)]) {
    assert.equal(usage.getDay(evil), null, `rejected day key: ${JSON.stringify(evil.slice(0, 40))}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('usage-history smoke: all assertions passed')