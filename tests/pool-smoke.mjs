/**
 * Offline pool/pool-adjacent smoke test (no network): selection ranking +
 * reset grace, session affinity, rotation decision matrix, failure
 * classification, semaphore and request pacing. Run:
 *   npm run build:api && node tests/pool-smoke.mjs
 */
import assert from 'node:assert'

// The pacer resolves its interval at module load — set the env before import.
process.env.AGY_MIN_INTERVAL_MS = '80'

const { rankAccounts, RESET_GRACE_MS } = await import('../dist/pool/selector.js')
const { pinAccount, takeAffinity, clearAffinity, applyAffinity, resetAffinity } = await import(
  '../dist/pool/affinity.js'
)
const {
  decideRotation,
  markSuccess,
  recordRateLimit,
  RATE_LIMIT_COOLDOWN_MS,
  FULL_QUOTA_COOLDOWN_MS,
  VALIDATION_BLOCK_COOLDOWN_MS,
} = await import('../dist/pool/ratelimit.js')
const { classifyHttpError, classifyRateLimit } = await import('../dist/util/classify.js')
const { Semaphore, GateFullError } = await import('../dist/util/concurrency.js')
const { paceUpstreamCall, resetPacer, MIN_INTERVAL_MS } = await import('../dist/util/pacer.js')
const { pickFingerprint } = await import('../dist/upstream/fingerprint.js')

function account(overrides = {}) {
  return {
    email: 'user@example.com',
    refreshToken: 'r',
    enabled: true,
    createdAt: 0,
    ...overrides,
  }
}

// --- 1. rankAccounts ordering ------------------------------------------------
{
  const now = Date.now()
  const healthy = account({ email: 'healthy@test' })
  const hot = account({ email: 'hot@test', cachedQuota: { google: { remainingFraction: 0.1 } } })
  const cooling = account({ email: 'cooling@test', coolingDownUntil: now + 60_000, cooldownReason: 'x' })
  const disabled = account({ email: 'disabled@test', enabled: false })

  const ranked = rankAccounts([cooling, hot, disabled, healthy], 'gemini-2.5-flash', now)
  const emails = ranked.map((c) => c.record.email)
  assert.deepEqual(emails, ['healthy@test', 'hot@test', 'cooling@test'], 'healthy < hot < blocked; disabled excluded')
  assert.equal(ranked[0].blockedUntil, null)
  assert.ok(ranked[1].drained, 'remaining<=15% counts as drained')
}

// --- 2. reset grace window ----------------------------------------------------
{
  const now = Date.now()
  // Cooldown expired less than RESET_GRACE_MS ago → still blocked.
  const justExpired = account({ email: 'a@test', coolingDownUntil: now - (RESET_GRACE_MS - 500) })
  // Cooldown expired well beyond the grace → free.
  const longExpired = account({ email: 'b@test', coolingDownUntil: now - (RESET_GRACE_MS + 5_000) })

  const [a] = rankAccounts([justExpired], 'gemini-2.5-flash', now)
  assert.ok(a.blockedUntil !== null, 'within grace window the account stays blocked')
  const [b] = rankAccounts([longExpired], 'gemini-2.5-flash', now)
  assert.equal(b.blockedUntil, null, 'beyond grace window the account is usable')

  // Family rate-limit reset gets the same treatment.
  const rec = account({ email: 'c@test' })
  recordRateLimit(rec, 'google', now + 30_000)
  const [c] = rankAccounts([rec], 'gemini-2.5-flash', now)
  assert.equal(c.blockedUntil, now + 30_000 + RESET_GRACE_MS)
}

// --- 3. session affinity -------------------------------------------------------
{
  resetAffinity()
  assert.equal(takeAffinity(), null, 'no pin initially')

  pinAccount('pinned@test')
  assert.equal(takeAffinity(), 'pinned@test')
  assert.equal(takeAffinity(Date.now() + 10 * 60_000), 'pinned@test', 'inside the 10min window')
  assert.equal(takeAffinity(Date.now() + 11 * 60_000), null, 'window expiry drops the pin')

  // Reorder only when usable.
  const candidates = [
    { record: { email: 'other@test' }, blockedUntil: null, drained: false },
    { record: { email: 'pinned@test' }, blockedUntil: null, drained: false },
    { record: { email: 'third@test' }, blockedUntil: null, drained: false },
  ]
  pinAccount('pinned@test')
  applyAffinity(candidates)
  assert.equal(candidates[0].record.email, 'pinned@test')

  // Blocked pinned account keeps its position (ranking stands).
  const withBlocked = [
    { record: { email: 'first@test' }, blockedUntil: null, drained: false },
    { record: { email: 'pinned@test' }, blockedUntil: Date.now() + 9_000, drained: false },
  ]
  applyAffinity(withBlocked)
  assert.equal(withBlocked[0].record.email, 'first@test', 'blocked pin is not promoted')
  assert.equal(withBlocked[1].record.email, 'pinned@test')

  clearAffinity()
  assert.equal(takeAffinity(), null)
  resetAffinity()
}

// --- 4. rotation decision matrix ----------------------------------------------
{
  const fresh = () => account({ email: 'r@test' })

  const soft = decideRotation('rate-limit', fresh(), {
    rateLimitCategory: 'soft_rate_limit',
    retryAfterMs: 800,
  })
  assert.equal(soft.action, 'retry-same')
  assert.ok((soft.backoffMs ?? 0) <= 3_000)

  const quota = decideRotation('rate-limit', fresh(), {
    rateLimitCategory: 'quota_exhausted',
    resetTime: new Date(Date.now() + 3 * 3600_000).toISOString(),
  })
  assert.equal(quota.action, 'rotate')
  assert.ok((quota.backoffMs ?? 0) <= FULL_QUOTA_COOLDOWN_MS)

  const perMinuteNoReset = decideRotation('rate-limit', fresh(), { rateLimitCategory: 'rate_limited' })
  assert.equal(perMinuteNoReset.action, 'rotate')
  assert.ok(Math.abs((perMinuteNoReset.backoffMs ?? 0) - RATE_LIMIT_COOLDOWN_MS) < 2_000)

  const auth = fresh()
  const authDecision = decideRotation('auth-failure', auth)
  assert.equal(authDecision.action, 'fail')
  assert.equal(auth.enabled, false, 'confirmed auth failure disables the account')

  const validation = fresh()
  validation.enabled = true
  const vDecision = decideRotation('validation-blocked', validation, {
    validationUrl: 'https://accounts.example/validate',
  })
  assert.equal(vDecision.action, 'rotate')
  assert.equal(validation.enabled, true, 'validation-blocked is NOT a credential death')
  assert.equal(validation.coolingDownUntil !== undefined, true)
  assert.equal(validation.validationUrl, 'https://accounts.example/validate')

  const badRequest = fresh()
  assert.equal(decideRotation('request-error', badRequest).action, 'fail')

  // markSuccess clears expired cooldown state.
  const healed = fresh()
  healed.coolingDownUntil = Date.now() - 1_000
  healed.cooldownReason = 'old'
  markSuccess(healed)
  assert.equal(healed.coolingDownUntil, undefined)
  assert.equal(healed.cooldownReason, undefined)
  assert.equal(VALIDATION_BLOCK_COOLDOWN_MS, 600_000)
}

// --- 5. classification ----------------------------------------------------------
{
  const headers429 = new Headers()
  assert.equal(classifyRateLimit(undefined, 1_500), 'soft_rate_limit')
  assert.equal(classifyRateLimit(undefined, 20_000), 'rate_limited')
  assert.equal(classifyHttpError(429, headers429, '{"error":"quota exhausted for today"}').rateLimitCategory, 'quota_exhausted')
  assert.equal(classifyHttpError(401, new Headers(), '{}').kind, 'auth-failure')

  const validationBody = JSON.stringify({
    error: { status: 'PERMISSION_DENIED', message: 'validation_required', validationUrl: 'https://x.test/v' },
  })
  const classified403 = classifyHttpError(403, new Headers(), validationBody)
  assert.equal(classified403.kind, 'validation-blocked')
  assert.equal(classified403.validationUrl, 'https://x.test/v')

  const quotaWall = classifyHttpError(403, new Headers(), '{"error":{"status":"RESOURCE_EXHAUSTED","message":"individual quota reached"}}')
  assert.equal(quotaWall.kind, 'rate-limit')

  const recoverable400 = classifyHttpError(400, new Headers(), '{"message":"context length exceeded"}')
  assert.equal(recoverable400.kind, 'transient')
  const permanent400 = classifyHttpError(400, new Headers(), '{"message":"invalid JSON payload"}')
  assert.equal(permanent400.kind, 'request-error')
  assert.equal(classifyHttpError(503, new Headers(), '').kind, 'transient')
}

// --- 6. semaphore -----------------------------------------------------------------
{
  const sem = new Semaphore(2, 1)
  const release1 = await sem.acquire()
  const release2 = await sem.acquire()
  assert.equal(sem.activeCount, 2)

  let released = false
  const waiter = sem.acquire().then((release) => {
    released = true
    return release
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(released, false, 'third acquire waits while full')
  release1()
  const release3 = await waiter
  assert.equal(sem.activeCount, 2)

  release2()
  release3()

  const tight = new Semaphore(1, 0)
  const hold = await tight.acquire()
  await assert.rejects(() => tight.acquire(), GateFullError)
  hold()
}

// --- 7. pacer spacing ---------------------------------------------------------------
{
  assert.equal(MIN_INTERVAL_MS, 80, 'env override applied at module load')
  resetPacer()
  const t0 = Date.now()
  await paceUpstreamCall(t0)
  assert.ok(Date.now() - t0 < 40, 'cold pacer lets the first call through immediately')
  const afterFirst = Date.now()
  await paceUpstreamCall()
  const gap1 = Date.now() - afterFirst
  assert.ok(gap1 >= MIN_INTERVAL_MS - 25 && gap1 <= MIN_INTERVAL_MS + 500, `calls are spaced ~interval (gap=${gap1}ms)`)
  const afterSecond = Date.now()
  await paceUpstreamCall()
  const gap2 = Date.now() - afterSecond
  assert.ok(gap2 >= MIN_INTERVAL_MS - 25, `spacing holds for the third call (gap=${gap2}ms)`)
}

// --- 8. fingerprint stability ---------------------------------------------------------
{
  const fpA = pickFingerprint('acc-a@x.com')
  const fpB = pickFingerprint('acc-b@x.com')
  assert.deepEqual(pickFingerprint('acc-a@x.com'), fpA, 'identity is stable per account key')
  assert.notDeepEqual(fpA, fpB)
  assert.match(fpA.version, /^\d+\.\d+\.\d+$/)
}

// --- 9. per-account proxy fail-closed gating ------------------------------------------
{
  const { isProxyPathOutage } = await import('../dist/pool/ratelimit.js')
  const { classifyFetchError } = await import('../dist/util/classify.js')

  assert.equal(isProxyPathOutage('network-error', true), true, 'proxy-bound + connect error → skip cooldown bookkeeping')
  assert.equal(isProxyPathOutage('network-error', false), false, 'unbound account → normal rotation engine')
  assert.equal(isProxyPathOutage('rate-limit', true), false, 'HTTP-level failures always go through the engine')
  assert.equal(isProxyPathOutage('validation-blocked', true), false)
  assert.equal(isProxyPathOutage('auth-failure', true), false)

  // Undici wraps connect-layer codes inside cause chains — the classifier digs them out.
  const refused = classifyFetchError(
    Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
  )
  assert.equal(refused.kind, 'network-error')
  assert.equal(refused.connectCode, 'ECONNREFUSED', 'cause-chain code surfaced for fail-closed logging')

  const plainTimeout = classifyFetchError(Object.assign(new Error('This operation was aborted'), { name: 'TimeoutError' }))
  assert.equal(plainTimeout.kind, 'network-error')

  // ClassifiedUpstreamError preserves validationUrl across the throw boundary
  // so decideRotationFromClassified can still record re-validation links.
  const { ClassifiedUpstreamError } = await import('../dist/util/classify.js')
  const carried = new ClassifiedUpstreamError({
    kind: 'validation-blocked',
    status: 403,
    message: 'validation_required',
    validationUrl: 'https://v.test/a',
  })
  assert.equal(carried.validationUrl, 'https://v.test/a')
}

console.log('\nALL POOL SMOKE TESTS PASSED')
