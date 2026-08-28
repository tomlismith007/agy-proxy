/** Page-level header: the stable anchor every section hangs its title off. */
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string
  description?: React.ReactNode
  /** Right-aligned action area (buttons live here, not inside cards). */
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-lg leading-none font-semibold tracking-tight">{title}</h1>
        {description !== undefined && (
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}
