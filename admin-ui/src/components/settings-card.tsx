import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { patch, type GatewayConfig } from '@/lib/api'
import { errMsg } from '@/lib/ui'

export function SettingsCard({
  config,
  onSaved,
}: {
  config: GatewayConfig | null
  onSaved: () => void
}) {
  const [debugLog, setDebugLog] = useState(false)
  const [onlyReal, setOnlyReal] = useState(false)
  const [concurrency, setConcurrency] = useState('2')
  const [proxy, setProxy] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [aliases, setAliases] = useState('{}')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!config) return
    setDebugLog(config.debugLog)
    setOnlyReal(config.onlyRealModels)
    setConcurrency(String(config.maxConcurrentUpstream))
    setProxy(config.proxy ?? '')
    setHost(config.host)
    setPort(String(config.port))
    setAliases(JSON.stringify(config.modelAliases ?? {}, null, 2))
  }, [config])

  const save = async () => {
    let parsedAliases: unknown
    try {
      parsedAliases = aliases.trim() === '' ? {} : JSON.parse(aliases)
      if (typeof parsedAliases !== 'object' || parsedAliases === null || Array.isArray(parsedAliases)) {
        throw new Error('必须是字符串到字符串的对象')
      }
    } catch (e) {
      toast.error('模型别名 JSON 无效：' + errMsg(e))
      return
    }
    setSaving(true)
    try {
      const r = await patch<{ applied: string[]; restartRequired: string[] }>('/admin/config', {
        debugLog,
        onlyRealModels: onlyReal,
        maxConcurrentUpstream: Number(concurrency),
        proxy: proxy.trim(),
        host: host.trim(),
        port: Number(port),
        modelAliases: parsedAliases,
      })
      if (r.restartRequired.length > 0) {
        toast.info(`已保存；${r.restartRequired.join('、')} 需重启网关后生效`, { duration: 6000 })
      } else {
        toast.success('配置已保存并即时生效')
      }
      onSaved()
    } catch (e) {
      toast.error('保存失败：' + errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="网关设置" description="保存即热生效，无需重启（监听地址/端口除外）">
        <Button size="sm" onClick={() => void save()} disabled={saving || config === null}>
          {saving && <Spinner data-icon="inline-start" />}
          保存配置
        </Button>
      </PageHeader>
      <Card>
        <CardContent>
          {config === null ? (
            <p className="text-muted-foreground text-sm">加载中…</p>
          ) : (
            <FieldSet>
              <FieldLegend>运行行为</FieldLegend>
              <FieldGroup>
                <Field orientation="horizontal">
                  <Switch id="cfg-debuglog" checked={debugLog} onCheckedChange={(v) => setDebugLog(v)} />
                  <FieldLabel htmlFor="cfg-debuglog" className="font-normal">
                    调试交换日志
                    <FieldDescription>把完整的上游请求/响应写入数据目录 debug/，用于排查协议问题</FieldDescription>
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <Switch id="cfg-onlyreal" checked={onlyReal} onCheckedChange={(v) => setOnlyReal(v)} />
                  <FieldLabel htmlFor="cfg-onlyreal" className="font-normal">
                    只显示真实模型
                    <FieldDescription>开启后 /v1/models 不再附加 modelAliases 中的别名条目</FieldDescription>
                  </FieldLabel>
                </Field>
              </FieldGroup>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="cfg-concurrency">上游并发上限（1–64）</FieldLabel>
                  <Input
                    id="cfg-concurrency"
                    type="number"
                    min={1}
                    max={64}
                    value={concurrency}
                    onChange={(e) => setConcurrency(e.target.value)}
                  />
                  <FieldDescription>同时进行的上游请求数，控制风控节奏</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="cfg-proxy">出站代理 URL</FieldLabel>
                  <Input
                    id="cfg-proxy"
                    value={proxy}
                    placeholder="http://127.0.0.1:7890"
                    onChange={(e) => setProxy(e.target.value)}
                  />
                  <FieldDescription>留空 = 自动探测本地代理</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="cfg-host">
                    监听地址<Badge variant="outline" className="ml-1.5 font-normal text-amber-600">需重启</Badge>
                  </FieldLabel>
                  <Input id="cfg-host" value={host} onChange={(e) => setHost(e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="cfg-port">
                    监听端口<Badge variant="outline" className="ml-1.5 font-normal text-amber-600">需重启</Badge>
                  </FieldLabel>
                  <Input
                    id="cfg-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="cfg-aliases">模型别名映射（JSON）</FieldLabel>
                <Textarea
                  id="cfg-aliases"
                  className="min-h-24 font-mono text-xs"
                  spellCheck={false}
                  placeholder={'{ "gpt-4o": "gemini-3.7-flash-tiered" }'}
                  value={aliases}
                  onChange={(e) => setAliases(e.target.value)}
                />
                <FieldDescription>客户端请求别名时自动改写到真实上游模型</FieldDescription>
              </Field>
            </FieldSet>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
