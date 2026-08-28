import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { StatBlock, StatHint } from '@/components/stat-block'
import { SkeletonGrid } from '@/lib/ui'
import type { Overview } from '@/lib/api'

/** System facts that read poorly as big metrics live in this quiet list. */
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-6">
      <span className="text-muted-foreground shrink-0 text-sm">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs">{children}</span>
    </div>
  )
}

export function OverviewCard({ overview, uptime }: { overview: Overview | null; uptime: string }) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="服务概览" description="本地 Antigravity 反向代理的实时状态" />

      {overview === null ? (
        <SkeletonGrid className="grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-5" />
      ) : (
        <div className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
          <StatBlock label="监听地址" mono>
            {overview.host}:{overview.port}
          </StatBlock>
          <StatBlock label="账号">
            {overview.accounts.enabled}
            <StatHint> / 共 {overview.accounts.total} 个</StatHint>
          </StatBlock>
          <StatBlock label="上游并发">
            {overview.activeUpstreamRequests}
            <StatHint> / 上限 {overview.maxConcurrentUpstream}</StatHint>
          </StatBlock>
          <StatBlock label="运行时长" mono>
            {uptime.replace(' 运行', '')}
          </StatBlock>
          <StatBlock label="网关版本" mono>
            v{overview.version}
          </StatBlock>
        </div>
      )}

      {overview?.paused && (
        <p className="text-destructive text-sm">
          网关已暂停：所有 /v1/* 请求返回 503，不产生上游流量。点击侧栏底部「恢复服务」解除。
        </p>
      )}

      {overview === null ? (
        <Skeleton className="h-28 w-full rounded-xl" />
      ) : (
        <Card size="sm">
          <CardContent className="flex flex-col gap-2.5">
            <InfoRow label="出站代理">{overview.proxy ?? '直连（自动探测）'}</InfoRow>
            <Separator />
            <InfoRow label="数据目录">
              <span title={overview.dataDir}>{overview.dataDir}</span>
            </InfoRow>
            <Separator />
            <div className="flex items-center justify-between gap-6">
              <span className="text-muted-foreground text-sm">调试交换日志</span>
              <Badge variant={overview.debugLog ? 'secondary' : 'outline'} className="font-normal">
                {overview.debugLog ? '开启' : '关闭'}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
