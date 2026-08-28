import { useEffect, useRef, useState } from 'react'
import {
  BadgeCheckIcon,
  CheckIcon,
  DownloadIcon,
  KeyRoundIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  ShieldAlertIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { QuotaRow } from '@/components/quota-row'
import { useConfirm } from '@/components/confirm'
import { copyText, errMsg, postDownload } from '@/lib/ui'
import { cn } from '@/lib/utils'
import {
  fmtDuration,
  get,
  post,
  type AccountRec,
  type LoginStatus,
} from '@/lib/api'

// ---------------------------------------------------------------- account --

function AccountCard({
  account,
  onAction,
}: {
  account: AccountRec
  onAction: (
    act: 'verify' | 'quota' | 'toggle' | 'remove' | 'proxy-save' | 'proxy-clear' | 'proxy-test',
    email: string,
    proxyUrl?: string,
  ) => void
}) {
  const now = Date.now()
  const cooling = account.coolingDownUntil && account.coolingDownUntil > now
  const [proxyDraft, setProxyDraft] = useState('')
  return (
    <Card className={cn('gap-2.5', !account.enabled && 'opacity-60')}>
      <CardContent className="flex flex-col gap-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold" title={account.email}>
              {account.email}
            </div>
            <div className="text-muted-foreground mt-0.5 font-mono text-xs">
              project: {account.projectId ?? '—'} · tier: {account.tierId ?? '—'} · 凭据剩{' '}
              {account.expiresAt ? fmtDuration(Math.max(0, account.expiresAt - now)) : '—'}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            {!account.enabled && <Badge variant="outline">停用</Badge>}
            {account.enabled && cooling && (
              <Badge variant="outline" className="text-amber-600 dark:text-amber-400" title={account.cooldownReason}>
                <PauseIcon /> 冷却 {fmtDuration(account.coolingDownUntil! - now)}
              </Badge>
            )}
            {account.verificationRequired && (
              <Badge variant="destructive">
                <ShieldAlertIcon /> 待验证
              </Badge>
            )}
            {!account.verificationRequired && account.lastHealthOk === false && (
              <Badge
                variant="outline"
                className="text-destructive"
                title={`${account.lastHealthError ?? ''}${account.lastHealthAt ? `（${new Date(account.lastHealthAt).toLocaleString()} 探测）` : ''}`}
              >
                健康异常
              </Badge>
            )}
            {account.expiresAt && account.expiresAt - now <= 0 && <Badge variant="destructive">凭据过期</Badge>}
          </div>
        </div>

        {account.validationUrl && (
          <a
            href={account.validationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-destructive inline-flex items-center gap-1 text-xs underline underline-offset-2"
          >
            <ShieldAlertIcon className="size-3" /> 需要浏览器验证，点击打开验证链接
          </a>
        )}

        {/* Per-account egress proxy: each account can keep its own IP identity. */}
        <div className="border-t pt-2.5">
          <div className="flex items-center gap-1.5">
            <Input
              className="h-7 flex-1 font-mono text-xs"
              placeholder={account.proxyMasked ?? '未绑定独立代理（走全局代理），输入 http://… 绑定'}
              value={proxyDraft}
              onChange={(e) => setProxyDraft(e.target.value)}
            />
            <Button
              variant="outline"
              size="icon-sm"
              title="保存 / 更新出站代理"
              disabled={proxyDraft.trim() === ''}
              onClick={() => {
                onAction('proxy-save', account.email, proxyDraft.trim())
                setProxyDraft('')
              }}
            >
              <CheckIcon />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              title="清除出站代理"
              disabled={!account.proxyMasked}
              onClick={() => onAction('proxy-clear', account.email)}
            >
              <XIcon />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              title="经当前代理发出一次真实探测请求"
              disabled={!account.proxyMasked}
              onClick={() => onAction('proxy-test', account.email)}
            >
              <ZapIcon />
            </Button>
          </div>
          {account.proxyMasked && (
            <p className="text-muted-foreground mt-1 text-xs">当前绑定：{account.proxyMasked}</p>
          )}
        </div>

        <div className="flex flex-col gap-2.5 border-t pt-2.5">
          {account.cachedQuota && Object.keys(account.cachedQuota).length > 0 ? (
            Object.entries(account.cachedQuota)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([family, q]) => <QuotaRow key={family} email={account.email} family={family} quota={q} />)
          ) : (
            <p className="text-muted-foreground text-xs">
              {account.cachedQuotaUpdatedAt ? '上游未返回配额信息' : '尚无配额数据，点击「刷新配额」获取'}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="xs" onClick={() => onAction('verify', account.email)}>
            <BadgeCheckIcon data-icon="inline-start" />
            验证
          </Button>
          <Button variant="outline" size="xs" onClick={() => onAction('quota', account.email)}>
            刷新配额
          </Button>
          <Button variant="outline" size="xs" onClick={() => onAction('toggle', account.email)}>
            {account.enabled ? (
              <>
                <PauseIcon data-icon="inline-start" />
                停用
              </>
            ) : (
              <>
                <PlayIcon data-icon="inline-start" />
                启用
              </>
            )}
          </Button>
          <Button variant="destructive" size="xs" onClick={() => onAction('remove', account.email)}>
            <Trash2Icon data-icon="inline-start" />
            删除
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ----------------------------------------------------------- login dialog --

function LoginDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [status, setStatus] = useState<LoginStatus | null>(null)
  const [pasteUrl, setPasteUrl] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const doneRef = useRef(false)

  const start = async () => {
    try {
      setStatus(await post<LoginStatus>('/admin/login/start'))
    } catch (e) {
      setStatus({ phase: 'error', error: errMsg(e) })
    }
  }

  useEffect(() => {
    if (!open) {
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = null
      return
    }
    doneRef.current = false
    setStatus(null)
    setPasteUrl('')
    void start()
    timerRef.current = setInterval(async () => {
      try {
        const st = await get<LoginStatus>('/admin/login/status')
        setStatus((prev) => (prev?.phase === st.phase && st.phase !== 'waiting' ? prev : st))
      } catch {
        /* transient */
      }
    }, 1500)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open && status?.phase === 'success' && !doneRef.current) {
      doneRef.current = true
      setTimeout(() => {
        onDone()
        onOpenChange(false)
      }, 1600)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, status?.phase])

  const submitPaste = async () => {
    if (!pasteUrl.trim()) {
      toast.error('请先粘贴完整的回调 URL')
      return
    }
    try {
      setStatus(await post<LoginStatus>('/admin/login/paste', { url: pasteUrl.trim() }))
    } catch (e) {
      toast.error('提交失败：' + errMsg(e))
    }
  }

  const phase = status?.phase ?? 'waiting'
  const done = phase === 'success'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加 Google 账号</DialogTitle>
          <DialogDescription>
            使用 Antigravity 桌面版内置的公开 OAuth 客户端完成 Google 授权，凭据将以 AES-256-GCM 加密存储。
          </DialogDescription>
        </DialogHeader>

        {phase === 'error' ? (
          <div className="flex flex-col gap-3">
            <p className="text-destructive text-sm break-all">{status?.error ?? '登录失败'}</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => void start()}>
                重新开始
              </Button>
            </DialogFooter>
          </div>
        ) : done ? (
          <div className="flex flex-col items-center gap-1.5 py-4 text-center">
            <BadgeCheckIcon className="size-9 text-emerald-500" />
            <p className="text-sm font-semibold">登录成功：{status?.email}</p>
            <p className="text-muted-foreground font-mono text-xs">
              {status?.projectId ? `project ${status.projectId}` : ''} {status?.tierId ? `· tier ${status.tierId}` : ''}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {phase === 'exchanging' ? (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <Spinner /> 已收到授权，正在交换令牌并初始化 Cloud Code 项目…
              </p>
            ) : (
              <>
                <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-sm">
                  <li>
                    已在系统默认浏览器打开 Google 授权页（如未弹出，
                    <a
                      href={status?.url ?? '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2"
                    >
                      点此打开
                    </a>
                    ）
                  </li>
                  <li>选择 Google 账号并完成授权</li>
                  <li>授权成功后本页面会自动继续</li>
                </ol>
                <p className="text-muted-foreground flex items-center gap-2 text-xs">
                  <Spinner className="size-3.5" /> 等待授权回调中…（约 5 分钟超时）
                </p>
                <Field>
                  <FieldLabel>远程 / 无浏览器环境？手动粘贴回调 URL</FieldLabel>
                  <Textarea
                    className="min-h-16 font-mono text-xs"
                    placeholder="http://localhost:xxxxx/oauth-callback?code=…&state=…"
                    value={pasteUrl}
                    onChange={(e) => setPasteUrl(e.target.value)}
                  />
                  <FieldDescription>粘贴后点击下方按钮完成登录。</FieldDescription>
                </Field>
                <DialogFooter>
                  <Button size="sm" onClick={() => void submitPaste()}>
                    提交粘贴内容
                  </Button>
                </DialogFooter>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ----------------------------------------------------------- import dialog --

function ImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}) {
  const [text, setText] = useState('')

  useEffect(() => {
    if (open) setText('')
  }, [open])

  const run = async () => {
    const raw = text.trim()
    if (!raw) {
      toast.error('请先选择文件或粘贴 JSON 内容')
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch (e) {
      toast.error('JSON 解析失败：' + errMsg(e))
      return
    }
    try {
      const r = await post<{ imported: number; skipped: Array<{ email: string; reason: string }> }>(
        '/admin/accounts/import',
        payload,
      )
      const skippedNote = r.skipped.length
        ? `；跳过 ${r.skipped.length} 条（${r.skipped.map((s) => `${s.email}: ${s.reason}`).join('；')}）`
        : ''
      if (r.imported > 0) {
        toast.success(`导入完成：新增/更新 ${r.imported} 个账号${skippedNote}`, { duration: 7000 })
        onImported()
        onOpenChange(false)
      } else {
        toast.error('导入失败：' + skippedNote, { duration: 8000 })
      }
    } catch (e) {
      toast.error('导入失败：' + errMsg(e))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>导入账号</DialogTitle>
          <DialogDescription>
            粘贴 agy-proxy 导出的 JSON（须含 refreshToken），或选择备份文件。凭据将以 AES-256-GCM 加密落盘。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="import-file">从文件导入</FieldLabel>
            <input
              id="import-file"
              type="file"
              accept=".json,application/json"
              className="text-muted-foreground file:bg-muted file:hover:bg-muted/70 file:text-foreground -ml-1.5 w-full text-xs file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-1.5 file:text-xs"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (file) setText(await file.text())
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="import-text">或粘贴 JSON 内容</FieldLabel>
            <Textarea
              id="import-text"
              className="min-h-28 font-mono text-xs"
              spellCheck={false}
              placeholder={`{ "kind": "agy-proxy.accounts", "accounts": [ … ] }`}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void run()}>开始导入</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ----------------------------------------------------------- accounts card --

export function AccountsCard({
  accounts,
  onChanged,
}: {
  accounts: AccountRec[]
  onChanged: () => void
}) {
  const confirm = useConfirm()
  const [loginOpen, setLoginOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const act = async (
    action: 'verify' | 'quota' | 'toggle' | 'remove' | 'proxy-save' | 'proxy-clear' | 'proxy-test',
    email: string,
    proxyUrl?: string,
  ) => {
    try {
      if (action === 'toggle') {
        await post('/admin/accounts/toggle', { email })
        toast.success('已切换启用状态：' + email)
      } else if (action === 'remove') {
        const ok = await confirm({
          title: '删除账号',
          text: `将从本地加密存储中删除 ${email}。\n注意：这不会撤销 Google 侧的授权。`,
          yes: '删除',
          danger: true,
        })
        if (!ok) return
        await post('/admin/accounts/remove', { email })
        toast.success('已删除 ' + email)
      } else if (action === 'verify') {
        const r = await post<{ ok: boolean; projectId?: string; tierId?: string; error?: string }>(
          '/admin/accounts/verify',
          { email },
        )
        if (r.ok) toast.success(`验证通过：project=${r.projectId ?? '—'} tier=${r.tierId ?? '—'}`)
        else toast.error('验证失败：' + r.error, { duration: 6000 })
      } else if (action === 'quota') {
        const r = await post<{ results: Array<{ ok: boolean; modelCount?: number; error?: string }> }>(
          '/admin/quota/refresh',
          { email },
        )
        const one = r.results[0]
        if (one?.ok) toast.success(`配额已更新（${one.modelCount ?? '?'} 个模型）`)
        else toast.error('刷新失败：' + (one?.error ?? '未知错误'), { duration: 6000 })
      } else if (action === 'proxy-save') {
        const r = await post<{ ok: boolean; proxyMasked: string | null }>('/admin/accounts/proxy', {
          email,
          proxyUrl: proxyUrl ?? null,
        })
        toast.success(`出站代理已绑定 ${email}：${r.proxyMasked ?? '(未绑定)'}`)
      } else if (action === 'proxy-clear') {
        await post('/admin/accounts/proxy', { email, proxyUrl: null })
        toast.success('已清除出站代理绑定：' + email)
      } else if (action === 'proxy-test') {
        toast.info('正在经代理发出真实探测请求…')
        const r = await post<{ ok: boolean; latencyMs?: number; error?: string }>('/admin/accounts/proxy/test', {
          email,
        })
        if (r.ok) toast.success(`代理可用，出口探测 ${r.latencyMs}ms`)
        else toast.error('探测失败：' + (r.error ?? '未知错误'), { duration: 6000 })
      }
      onChanged()
    } catch (e) {
      toast.error('操作失败：' + errMsg(e))
    }
  }

  const refreshAllQuotas = async () => {
    if (accounts.filter((a) => a.enabled).length === 0) {
      toast.error('没有启用的账号')
      return
    }
    try {
      const r = await post<{ results: Array<{ ok: boolean; error?: string }> }>('/admin/quota/refresh', {})
      const okCount = r.results.filter((x) => x.ok).length
      if (okCount > 0) toast.success(`已刷新 ${okCount}/${r.results.length} 个账号的配额`)
      else toast.error('刷新失败：' + (r.results[0]?.error ?? '未知错误'))
      onChanged()
    } catch (e) {
      toast.error('刷新失败：' + errMsg(e))
    }
  }

  const exportAccounts = async () => {
    const mode = await new Promise<'redacted' | 'full' | null>((resolve) => {
      // 两次确认：先选模式，含凭据时再确认风险
      void (async () => {
        const wantFull = await confirm({
          title: '导出账号',
          text: '「含凭据」导出包含 refreshToken 等敏感凭据（明文！），可用于迁移，请妥善保管。\n「脱敏」只包含账号结构与状态。',
          yes: '含凭据（敏感）',
          no: '仅脱敏导出',
          danger: true,
        })
        if (!wantFull) resolve('redacted')
        else {
          const again = await confirm({
            title: '再次确认',
            text: '即将下载包含 refreshToken 明文的完整备份，任何拿到该文件的人都可以直接使用你的 Google 账号额度。确定继续？',
            yes: '我已知晓风险，继续导出',
            danger: true,
          })
          resolve(again ? 'full' : null)
        }
      })()
    })
    if (mode) {
      try {
        await postDownload('/admin/accounts/export', { credentials: mode === 'full' })
      } catch (e) {
        toast.error('导出失败：' + errMsg(e))
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="账号池" description="Google 账号凭据、配额与轮换状态">
        <Button size="sm" onClick={() => setLoginOpen(true)}>
          <PlusIcon data-icon="inline-start" />
          添加账号
        </Button>
        <Button variant="outline" size="sm" onClick={() => void refreshAllQuotas()}>
          刷新配额
        </Button>
        <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
          <UploadIcon data-icon="inline-start" />
          导入
        </Button>
        <Button variant="outline" size="sm" onClick={() => void exportAccounts()}>
          <DownloadIcon data-icon="inline-start" />
          导出
        </Button>
      </PageHeader>

      <Card>
        <CardContent>
          {accounts.length === 0 ? (
            <Empty className="border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <KeyRoundIcon />
                </EmptyMedia>
                <EmptyTitle>尚未登录任何 Google 账号</EmptyTitle>
                <EmptyDescription>
                  点击「添加账号」在浏览器中完成 Google 授权；也可以使用 CLI：agy-proxy login
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button size="sm" onClick={() => setLoginOpen(true)}>
                  <PlusIcon data-icon="inline-start" />
                  添加账号
                </Button>
                <Button variant="outline" size="sm" onClick={() => void copyText('agy-proxy login')}>
                  复制 CLI 命令
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {accounts.map((a) => (
                <AccountCard key={a.email} account={a} onAction={(act2, email) => void act(act2, email)} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} onDone={onChanged} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={onChanged} />
    </div>
  )
}
