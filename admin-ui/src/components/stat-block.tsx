import { cn } from '@/lib/utils'

/**
 * Metric item for the overview/stats strips: small label above a large
 * tabular number, no box chrome — grouping comes from the grid gap alone.
 */
export function StatBlock({
  label,
  children,
  mono,
  className,
}: {
  label: string
  children: React.ReactNode
  /** Render the value in mono (ids, addresses, counters). */
  mono?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div
        className={cn(
          'truncate text-xl leading-none font-semibold tracking-tight',
          mono ? 'font-mono text-lg font-medium' : 'tabular-nums',
        )}
      >
        {children}
      </div>
    </div>
  )
}

/** Small trailing annotation inside a StatBlock value ("活跃 x / max", units). */
export function StatHint({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground text-sm font-normal tracking-normal">{children}</span>
  )
}
