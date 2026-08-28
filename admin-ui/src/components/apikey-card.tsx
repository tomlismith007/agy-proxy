import { useState } from 'react'
import { KeyRoundIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
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
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { PageHeader } from '@/components/page-header'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useConfirm } from '@/components/confirm'
import { post, type GatewayConfig } from '@/lib/api'
import { CopyButton, errMsg } from '@/lib/ui'

export function ApiKeyCard({
  config,
  onChanged,
}: {
  config: GatewayConfig | null
  onChanged: () => void
}) {
  const confirm = useConfirm()
  const [rotating, setRotating] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [revealed, setRevealed] = useState<{ name: string; keyFull: string | null } | null>(null)

  const rotate = async () => {
    const ok = await confirm({
      title: '轮换主密钥',
      text: '生成新密钥并写入配置文件，旧主密钥立即失效。\n命名密钥不受影响。请确认你已准备好更新所有使用主密钥的客户端。',
      yes: '生成新密钥',
      danger: true,
    })
    if (!ok) return
    setRotating(true)
    try {
      const r = await post<{ ok: boolean; apiKey: string | null; apiKeyTail: string }>(
        '/admin/apikey/rotate',
      )
      if (r.apiKey) setRevealed({ name: '主密钥', keyFull: r.apiKey })
      else
        toast.success(
          `主密钥已轮换（尾 6 位 ${r.apiKeyTail}），请到数据目录 config.json 查看`,
          { duration: 6000 },
        )
      onChanged()
    } catch (e) {
      toast.error('轮换失败：' + errMsg(e))
    } finally {
      setRotating(false)
    }
  }

  const createKey = async () => {
    const name = newName.trim()
    if (!name) {
      toast.error('请先填写密钥名称')
      return
    }
    setCreating(true)
    try {
      const r = await post<{ ok: boolean; name: string; keyFull: string | null }>(
        '/admin/apikeys/create',
        { name },
      )
      setNewName('')
      setRevealed({ name: r.name, keyFull: r.keyFull })
      toast.success(`已创建密钥「${r.name}」`)
      onChanged()
    } catch (e) {
      toast.error('创建失败：' + errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  const removeKey = async (name: string) => {
    const ok = await confirm({
      title: '删除命名密钥',
      text: `删除后使用「${name}」的客户端将立即收到 401。\n其它密钥不受影响。`,
      yes: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await post('/admin/apikeys/remove', { name })
      toast.success(`已删除密钥「${name}」`)
      onChanged()
    } catch (e) {
      toast.error('删除失败：' + errMsg(e))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="接入密钥"
        description="OpenAI / Anthropic 客户端接入本网关时使用的鉴权密钥；除主密钥外可为每个客户端创建独立命名的密钥并单独吊销"
      >
        <Button variant="destructive" size="sm" onClick={() => void rotate()} disabled={rotating || !config}>
          轮换主密钥
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* 主密钥 */}
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">主密钥</p>
            {config === null ? (
              <Skeleton className="h-9 w-full" />
            ) : config.apiKeyFull ? (
              <InputGroup>
                <InputGroupInput readOnly value={config.apiKeyFull} onFocus={(e) => e.target.select()} />
                <InputGroupAddon align="inline-end">
                  <CopyButton text={config.apiKeyFull} variant="outline" size="sm" />
                </InputGroupAddon>
              </InputGroup>
            ) : (
              <p className="text-muted-foreground text-sm">
                当前监听地址不是本机回环地址，出于安全考虑不在此显示完整密钥。尾 6 位：
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{config.apiKeyTail}</code>
                ，请查看数据目录 config.json 的 apiKey 字段。
              </p>
            )}
          </div>

          {config !== null && (
            <>
              <Separator />

              {/* 命名密钥 */}
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-semibold">命名密钥</p>
                  <p className="text-muted-foreground text-xs">
                    例如给 Claude Code、Cherry Studio 分别各发一把，泄露时只需吊销对应那把。
                  </p>
                </div>

                <InputGroup>
                  <InputGroupInput
                    placeholder="密钥名称，如 claude-code"
                    value={newName}
                    maxLength={40}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !creating) void createKey()
                    }}
                  />
                  <InputGroupAddon align="inline-end">
                    <Button size="sm" onClick={() => void createKey()} disabled={creating}>
                      {creating ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
                      创建密钥
                    </Button>
                  </InputGroupAddon>
                </InputGroup>

                {config.apiKeys.length === 0 ? (
                  <Empty className="border-dashed">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <KeyRoundIcon />
                      </EmptyMedia>
                      <EmptyTitle>还没有命名密钥</EmptyTitle>
                      <EmptyDescription>输入名称即可创建，所有客户端也可以继续共用上面的主密钥。</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="rounded-lg border">
                    <Table className="[&_td]:py-2.5 [&_th]:py-2">
                      <TableHeader>
                        <TableRow>
                          <TableHead>名称</TableHead>
                          <TableHead>密钥尾号</TableHead>
                          <TableHead className="w-24 text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {config.apiKeys.map((k) => (
                          <TableRow key={k.name}>
                            <TableCell className="max-w-48 truncate font-medium" title={k.name}>
                              {k.name}
                            </TableCell>
                            <TableCell className="text-muted-foreground font-mono text-xs">
                              ••••••{k.keyTail}
                            </TableCell>
                            <TableCell>
                              <div className="flex justify-end gap-0.5">
                                <CopyButton
                                  text={k.keyFull}
                                  label=""
                                  copiedLabel=""
                                  variant="ghost"
                                  size="icon-sm"
                                  title={k.keyFull ? '复制完整密钥' : '非本机监听，无法在此显示完整密钥'}
                                />
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  className="text-destructive hover:text-destructive"
                                  title="删除该密钥"
                                  onClick={() => void removeKey(k.name)}
                                >
                                  <Trash2Icon />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </>
          )}

          {config !== null && (
            <p className="text-muted-foreground text-xs">
              所有密钥都保存在数据目录的 <code className="bg-muted rounded px-1 font-mono">config.json</code>
              （apiKey / apiKeys 字段）。任何一把有效密钥均可用于 /v1/* 鉴权，权限完全相同。
            </p>
          )}
        </CardContent>
      </Card>

      {/* 新建/轮换成功后的完整密钥展示 */}
      <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{revealed?.name ?? ''} · 已生成</DialogTitle>
            <DialogDescription>请立即复制保存；离开对话框后仍可在本页复制（仅限本机回环监听时）。</DialogDescription>
          </DialogHeader>
          {revealed?.keyFull ? (
            <code className="bg-muted rounded-lg px-3 py-2.5 font-mono text-xs break-all select-all">
              {revealed.keyFull}
            </code>
          ) : (
            <p className="text-muted-foreground text-sm">
              当前监听地址不是本机回环地址，完整值只写入数据目录 config.json，请直接在该文件中查看。
            </p>
          )}
          <DialogFooter>
            {revealed?.keyFull && (
              <CopyButton text={revealed.keyFull} variant="outline" />
            )}
            <Button onClick={() => setRevealed(null)}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
