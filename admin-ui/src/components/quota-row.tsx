import { useState } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { FAMILY_LABELS, fmtDuration, get, type FamilyQuota, type QuotaDetail } from '@/lib/api'
import { errMsg } from '@/lib/ui'
import { cn } from '@/lib/utils'

function levelOf(pct: number | null): string {
  if (pct === null) return 'ok'
  if (pct >= 50) return 'ok'
  if (pct >= 15) return 'mid'
  return 'low'
}

/** Literal strings so the Tailwind scanner picks the variants up. */
const LEVEL_INDICATOR: Record<string, string> = {
  ok: '[&_[data-slot=progress-indicator]]:bg-emerald-500',
  mid: '[&_[data-slot=progress-indicator]]:bg-amber-500',
  low: '[&_[data-slot=progress-indicator]]:bg-red-500',
}

function resetSuffix(resetTime?: string): string {
  if (!resetTime) return ''
  const ms = Date.parse(resetTime) - Date.now()
  return Number.isFinite(ms) && ms > 0 ? ` · 重置 ${fmtDuration(ms)}` : ''
}

/** One expandable model-family quota bar; expanding lists each model's quota. */
export function QuotaRow({ email, family, quota }: { email: string; family: string; quota: FamilyQuota }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<QuotaDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remain = typeof quota.remainingFraction === 'number' ? quota.remainingFraction : null
  const pct = remain === null ? null : Math.round(remain * 100)
  const level = levelOf(pct)

  let right: string = '—'
  if (pct !== null) right = `${pct}%${resetSuffix(quota.resetTime)}`

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setDetail(await get<QuotaDetail>(`/admin/quota/detail?email=${encodeURIComponent(email)}`))
    } catch (e) {
      setError(errMsg(e))
      toast.error('模型明细加载失败：' + errMsg(e))
    } finally {
      setLoading(false)
    }
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    // Refetch on every open so a fresh 刷新配额 is reflected immediately;
    // the server-side discovery cache keeps this cheap.
    if (next) void load()
  }

  const models = detail?.models.filter((m) => m.family === family) ?? []

  return (
    <div>
      <div className="text-muted-foreground flex items-baseline justify-between text-xs">
        <button
          type="button"
          onClick={toggle}
          className="hover:text-foreground -mx-1 inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2"
          aria-expanded={open}
        >
          <ChevronDownIcon
            className={cn('text-muted-foreground/70 size-3 shrink-0 transition-transform', open && 'rotate-180')}
          />
          {FAMILY_LABELS[family] ?? family}
          {quota.modelCount ? (
            <span className="text-muted-foreground/60">（{quota.modelCount} 个模型）</span>
          ) : null}
        </button>
        <span className="font-mono">{right}</span>
      </div>
      <Progress
        value={pct ?? 100}
        aria-label={`${family} 配额`}
        className={cn(
          'mt-1.5 w-full gap-0',
          '[&_[data-slot=progress-track]]:h-1.5',
          '[&_[data-slot=progress-indicator]]:transition-all',
          LEVEL_INDICATOR[level],
        )}
      />

      {open && (
        <div className="bg-muted/30 mt-2 flex flex-col gap-2 rounded-lg border px-3 py-2.5">
          {loading && !detail ? (
            [0, 1, 2].map((i) => <Skeleton key={i} className="h-3.5 w-full" />)
          ) : error ? (
            <p className="text-destructive text-xs">
              {error}
              <button type="button" onClick={() => void load()} className="ml-2 underline underline-offset-2">
                重试
              </button>
            </p>
          ) : models.length === 0 ? (
            <p className="text-muted-foreground text-xs">该分组暂无模型明细，可点击「刷新配额」获取</p>
          ) : (
            models.map((m) => {
              const mpct = m.remaining === null ? null : Math.round(m.remaining * 100)
              return (
                <div key={m.id} title={m.id}>
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate">{m.name}</span>
                    <span className="font-mono whitespace-nowrap">
                      {mpct === null ? (
                        <span className="text-muted-foreground">无数据</span>
                      ) : (
                        `${mpct}%${resetSuffix(m.resetTime)}`
                      )}
                    </span>
                  </div>
                  <Progress
                    value={mpct ?? 0}
                    aria-label={`${m.id} 配额`}
                    className={cn(
                      'mt-1 w-full gap-0',
                      '[&_[data-slot=progress-track]]:h-1',
                      '[&_[data-slot=progress-indicator]]:transition-all',
                      LEVEL_INDICATOR[levelOf(mpct)],
                    )}
                  />
                </div>
              )
            })
          )}
          {detail && !error && (
            <p className="text-muted-foreground/60 mt-0.5 text-[10px]">
              数据来源：{detail.source === 'cache' ? '5 分钟内缓存' : '上游实时发现'}
              {loading ? ' · 更新中…' : ''}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
