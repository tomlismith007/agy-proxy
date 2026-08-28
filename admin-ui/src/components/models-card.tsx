import { useEffect, useState } from 'react'
import { FlaskConicalIcon, RefreshCwIcon } from 'lucide-react'
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
import { PageHeader } from '@/components/page-header'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { fmtContext, fmtTokens, post, type ModelEntry, type TestChatResult } from '@/lib/api'
import { errMsg } from '@/lib/ui'

function TestDialog({
  model,
  onClose,
}: {
  model: string | null
  onClose: () => void
}) {
  const [prompt, setPrompt] = useState('你好！请用一句话介绍你自己。')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TestChatResult | null>(null)

  useEffect(() => {
    if (model) {
      setResult(null)
      setRunning(false)
    }
  }, [model])

  const run = async () => {
    if (!model) return
    setRunning(true)
    setResult(null)
    try {
      const r = await post<TestChatResult>('/admin/test-chat', { model, prompt })
      setResult(r)
    } catch (e) {
      setResult({ ok: false, error: errMsg(e) })
    } finally {
      setRunning(false)
    }
  }

  const usage = result?.usage
  const metaBits = [
    result?.ok ? '成功' : '失败',
    result?.latencyMs != null ? `上游 ${result.latencyMs}ms` : null,
    result?.account ? `账号 ${result.account}` : null,
    Number.isFinite(usage?.promptTokenCount)
      ? `in ${fmtTokens(usage!.promptTokenCount!)} / out ${fmtTokens(usage?.candidatesTokenCount ?? 0)} tok`
      : null,
    result?.finishReason ?? null,
  ].filter(Boolean) as string[]

  return (
    <Dialog open={model !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>模型测试</DialogTitle>
          <DialogDescription>向上游发送一条真实的最小请求，验证模型可用性与延迟。</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="test-model">模型 ID</FieldLabel>
            <Input id="test-model" readOnly value={model ?? ''} className="font-mono text-xs" />
          </Field>
          <Field>
            <FieldLabel htmlFor="test-prompt">提示词</FieldLabel>
            <Textarea id="test-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </Field>
        </FieldGroup>
        {result && (
          <div className="bg-muted/40 rounded-lg border p-3">
            <div className="text-muted-foreground mb-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs">
              {metaBits.map((b) => (
                <span key={b}>{b}</span>
              ))}
            </div>
            <p
              className={`max-h-60 overflow-y-auto text-sm whitespace-pre-wrap break-words ${
                result.ok ? '' : 'text-destructive'
              }`}
            >
              {result.ok ? (result.text || '（空回复）') : (result.error ?? '未知错误')}
            </p>
            {result.ok && result.thoughtText ? (
              <p className="text-muted-foreground mt-2 border-t pt-2 text-xs whitespace-pre-wrap">
                【思考链】{result.thoughtText}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button onClick={() => void run()} disabled={running}>
            {running && <Spinner data-icon="inline-start" />}
            发送测试
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ModelsCard({
  models,
  source,
  onReload,
}: {
  models: ModelEntry[]
  source: string
  onReload: () => void
}) {
  const [testModel, setTestModel] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="模型目录"
        description={
          source === 'discovered'
            ? `${models.length} 个模型 · 来自账号真实发现`
            : source === 'catalog'
              ? `内置目录（登录后自动替换为真实列表）`
              : source
        }
      >
        <Button variant="outline" size="sm" onClick={onReload}>
          <RefreshCwIcon data-icon="inline-start" />
          重新发现
        </Button>
      </PageHeader>

      <Card>
        <CardContent>
          {models.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">没有可用模型</p>
          ) : (
            <Table className="[&_td]:py-2.5 [&_th]:py-2">
              <TableHeader>
                <TableRow>
                  <TableHead>模型 ID</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>上下文</TableHead>
                  <TableHead className="text-right">剩余配额</TableHead>
                  <TableHead className="w-12" aria-label="操作" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="max-w-72 truncate font-mono text-xs" title={m.id}>
                      {m.id}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{m.display_name}</TableCell>
                    <TableCell className="font-mono text-xs">{fmtContext(m.context_length)}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {typeof m.quota_remaining === 'number' ? (
                        <Badge variant="outline" className="font-normal tabular-nums">
                          {Math.round(m.quota_remaining * 100)}%
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="发送测试请求"
                        onClick={() => setTestModel(m.id)}
                      >
                        <FlaskConicalIcon />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <TestDialog model={testModel} onClose={() => setTestModel(null)} />
    </div>
  )
}
