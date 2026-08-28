import { useEffect, useState } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import { StatBlock } from '@/components/stat-block'
import { Skeleton } from '@/components/ui/skeleton'
import { SkeletonGrid, errMsg } from '@/lib/ui'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { get, fmtTokens, type DayUsage, type DayUsageSummary, type StatsSnapshot, type UsageTotals } from '@/lib/api'

/** Client-side local day key — mirrors the backend's localDateKey. */
function localTodayKey(): string {
  const d = new Date()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** The six standard usage metrics as a stat grid. */
function UsageStatRow({ t }: { t: UsageTotals }) {
  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
      <StatBlock label="请求">{t.requests}</StatBlock>
      <StatBlock label="成功">
        <span className="text-emerald-600 dark:text-emerald-400">{t.success}</span>
      </StatBlock>
      <StatBlock label="失败">
        <span className={t.failures > 0 ? 'text-red-600 dark:text-red-400' : ''}>{t.failures}</span>
      </StatBlock>
      <StatBlock label="输入 tokens">{fmtTokens(t.promptTokens)}</StatBlock>
      <StatBlock label="输出 tokens">{fmtTokens(t.outputTokens)}</StatBlock>
      <StatBlock label="思考 tokens">{fmtTokens(t.thoughtsTokens)}</StatBlock>
    </div>
  )
}

/** Sorted [key, totals] pairs for a day's byModel / byAccount maps. */
function sortedTotals(map: Record<string, UsageTotals>): Array<[string, UsageTotals]> {
  return Object.entries(map).sort((a, b) => b[1].requests - a[1].requests)
}

function BreakdownTable({ title, keyHeader, rows }: { title: string; keyHeader: string; rows: Array<[string, UsageTotals]> }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground mb-1.5 text-xs font-medium">{title}</p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground/60 text-xs">无记录</p>
      ) : (
        <Table className="[&_td]:py-1.5 [&_th]:py-1">
          <TableHeader>
            <TableRow>
              <TableHead>{keyHeader}</TableHead>
              <TableHead>请求</TableHead>
              <TableHead>失败</TableHead>
              <TableHead>输入</TableHead>
              <TableHead>输出</TableHead>
              <TableHead>思考</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(([key, u]) => (
              <TableRow key={key}>
                <TableCell className="max-w-44 truncate font-mono text-xs" title={key}>
                  {key}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums">{u.requests}</TableCell>
                <TableCell
                  className={cn('font-mono text-xs tabular-nums', u.failures > 0 && 'text-red-600 dark:text-red-400')}
                >
                  {u.failures}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums">{fmtTokens(u.promptTokens)}</TableCell>
                <TableCell className="font-mono text-xs tabular-nums">{fmtTokens(u.outputTokens)}</TableCell>
                <TableCell className="font-mono text-xs tabular-nums">{fmtTokens(u.thoughtsTokens)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

/** Expanded day detail: hourly trend + per-model / per-account breakdowns. Self-fetches like QuotaRow. */
function DayDetail({ date }: { date: string }) {
  const [detail, setDetail] = useState<DayUsage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    get<DayUsage>(`/admin/usage/day?date=${encodeURIComponent(date)}`)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((e) => {
        if (!cancelled) {
          setError(errMsg(e))
          toast.error('当日明细加载失败：' + errMsg(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [date])

  if (loading && !detail) return <Skeleton className="h-36 w-full rounded-xl" />
  if (error) return <p className="text-destructive text-sm">{error}</p>
  if (!detail) return null

  const maxHour = Math.max(1, ...detail.byHour.map((h) => h.requests))

  return (
    <div className="bg-muted/30 flex flex-col gap-4 rounded-lg border px-3 py-3">
      <div>
        <div className="flex h-16 items-end gap-[3px]">
          {detail.byHour.map((h, i) => (
            <div
              key={i}
              title={`${String(i).padStart(2, '0')}:00 · ${h.requests} 次请求 · 输入 ${h.promptTokens} / 输出 ${h.outputTokens} / 思考 ${h.thoughtsTokens}`}
              className="bg-primary/70 hover:bg-primary min-h-[2px] flex-1 rounded-t-[2px] transition-colors"
              style={{ height: `${(h.requests / maxHour) * 100}%` }}
            />
          ))}
        </div>
        <p className="text-muted-foreground/60 mt-1 text-[10px]">按小时请求分布（当地时间 0–23 点）</p>
      </div>

      {Object.keys(detail.byFormat).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(detail.byFormat).map(([name, u]) => (
            <Badge key={name} variant="outline" className="font-normal">
              {name} · {u.requests} 次{u.failures > 0 ? ` · 失败 ${u.failures}` : ''}
            </Badge>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownTable title="按模型" keyHeader="模型" rows={sortedTotals(detail.byModel)} />
        <BreakdownTable title="按账号" keyHeader="账号" rows={sortedTotals(detail.byAccount)} />
      </div>
    </div>
  )
}

/** One expandable day row in the usage history list. */
function DayRow({
  day,
  maxRequests,
  isToday,
  open,
  onToggle,
}: {
  day: DayUsageSummary
  maxRequests: number
  isToday: boolean
  open: boolean
  onToggle: () => void
}) {
  const pct = Math.min(100, Math.round((day.totals.requests / maxRequests) * 100))
  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="hover:bg-muted/40 -mx-2 w-[calc(100%+1rem)] cursor-pointer rounded-md px-2 py-2.5 text-left transition-colors"
      >
        <div className="flex items-center gap-3 text-xs">
          <ChevronDownIcon
            className={cn('text-muted-foreground/70 size-3.5 shrink-0 transition-transform', open && 'rotate-180')}
          />
          <span className="w-20 shrink-0 font-mono">{day.date}</span>
          <span className="flex w-9 shrink-0">
            {isToday && (
              <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                今日
              </Badge>
            )}
          </span>
          <span className="w-14 shrink-0 text-right font-mono tabular-nums">{day.totals.requests}</span>
          <span className="w-12 shrink-0 text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
            {day.totals.success}
          </span>
          <span
            className={cn(
              'w-10 shrink-0 text-right font-mono tabular-nums',
              day.totals.failures > 0 && 'text-red-600 dark:text-red-400',
            )}
          >
            {day.totals.failures}
          </span>
          <span className="w-14 shrink-0 text-right font-mono tabular-nums">{fmtTokens(day.totals.promptTokens)}</span>
          <span className="w-14 shrink-0 text-right font-mono tabular-nums">{fmtTokens(day.totals.outputTokens)}</span>
          <span className="w-14 shrink-0 text-right font-mono tabular-nums">{fmtTokens(day.totals.thoughtsTokens)}</span>
          <div className="bg-muted hidden h-1.5 min-w-8 flex-1 overflow-hidden rounded-full md:block">
            <div className="bg-primary/70 h-full rounded-full" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </button>
      {open && (
        <div className="px-6 pb-3">
          <DayDetail date={day.date} />
        </div>
      )}
    </div>
  )
}

export function StatsCard({ stats, usageDays }: { stats: StatsSnapshot | null; usageDays: DayUsageSummary[] | null }) {
  const t = stats?.totals
  const recent = stats?.recent.slice(0, 30) ?? []
  const formats = Object.entries(stats?.byFormat ?? {})
  const [openDate, setOpenDate] = useState<string | null>(null)
  const todayKey = localTodayKey()
  const today = usageDays?.find((d) => d.date === todayKey)
  const maxRequests = Math.max(1, ...(usageDays ?? []).map((d) => d.totals.requests))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="请求统计" description="每日用量已持久化落盘，重启不丢失；「本次运行」为实时内存数据" />

      {/* ------------------- persisted daily usage history ------------------- */}
      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">每日用量</h3>
          <span className="text-muted-foreground text-xs">本地时区 · 最近 30 天 · 点击行查看明细</span>
        </div>

        {today ? (
          <UsageStatRow t={today.totals} />
        ) : usageDays === null ? (
          <SkeletonGrid className="grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-6" />
        ) : (
          <p className="text-muted-foreground text-sm">今天还没有请求记录。</p>
        )}

        <Card size="sm">
          <CardContent>
            {usageDays === null ? (
              <Skeleton className="h-24 w-full rounded-xl" />
            ) : usageDays.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">暂无历史记录</p>
            ) : (
              <div>
                <div className="text-muted-foreground/70 flex items-center gap-3 px-2 pb-1.5 text-[10px]">
                  <span className="size-3.5 shrink-0" />
                  <span className="w-20 shrink-0">日期</span>
                  <span className="w-9 shrink-0" />
                  <span className="w-14 shrink-0 text-right">请求</span>
                  <span className="w-12 shrink-0 text-right">成功</span>
                  <span className="w-10 shrink-0 text-right">失败</span>
                  <span className="w-14 shrink-0 text-right">输入</span>
                  <span className="w-14 shrink-0 text-right">输出</span>
                  <span className="w-14 shrink-0 text-right">思考</span>
                  <span className="hidden flex-1 md:block">用量占比</span>
                </div>
                {usageDays.map((d) => (
                  <DayRow
                    key={d.date}
                    day={d}
                    maxRequests={maxRequests}
                    isToday={d.date === todayKey}
                    open={openDate === d.date}
                    onToggle={() => setOpenDate(openDate === d.date ? null : d.date)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ------------------- live session counters ------------------- */}
      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">本次运行</h3>
          <span className="text-muted-foreground text-xs">实时内存数据 · 重启清零</span>
        </div>

        {t === undefined ? (
          <SkeletonGrid className="grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-6" />
        ) : (
          <div className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
            <StatBlock label="总请求">{t.requests}</StatBlock>
            <StatBlock label="成功">
              <span className="text-emerald-600 dark:text-emerald-400">{t.success}</span>
            </StatBlock>
            <StatBlock label="失败">
              <span className={t.failures > 0 ? 'text-red-600 dark:text-red-400' : ''}>{t.failures}</span>
            </StatBlock>
            <StatBlock label="输入 tokens">{fmtTokens(t.promptTokens)}</StatBlock>
            <StatBlock label="输出 tokens">{fmtTokens(t.outputTokens)}</StatBlock>
            <StatBlock label="思考 tokens">{fmtTokens(t.thoughtsTokens)}</StatBlock>
          </div>
        )}

      {formats.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {formats.map(([name, entry]) => (
            <Badge key={name} variant="outline" className="font-normal">
              {name} · {entry.requests} 次
              {entry.failures > 0 ? ` · 失败 ${entry.failures}` : ''}
            </Badge>
          ))}
        </div>
      )}

      <Card>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">暂无请求记录</p>
          ) : (
            <Table className="[&_td]:py-2.5 [&_th]:py-2">
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>协议</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>账号</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>耗时</TableHead>
                  <TableHead>tokens</TableHead>
                  <TableHead className="min-w-56">错误</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((r, i) => (
                  <TableRow key={r.time + '-' + i}>
                    <TableCell className="font-mono text-xs">
                      {new Date(r.time).toLocaleTimeString('zh-CN', { hour12: false })}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.format}
                      {r.stream && (
                        <span className="text-muted-foreground ml-1 text-[10px] uppercase">流</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-44 truncate font-mono text-xs" title={r.model}>
                      {r.model}
                    </TableCell>
                    <TableCell className="max-w-40 truncate font-mono text-xs" title={r.account}>
                      {r.account ?? '—'}
                    </TableCell>
                    <TableCell
                      className={`font-mono text-xs tabular-nums ${r.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
                    >
                      {r.status}
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums">{r.latencyMs}ms</TableCell>
                    <TableCell className="font-mono text-xs tabular-nums">
                      {r.promptTokens != null ? `${r.promptTokens}/${r.outputTokens ?? '-'}` : '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-72 truncate text-xs" title={r.error}>
                      {r.error ?? ''}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      </section>
    </div>
  )
}
