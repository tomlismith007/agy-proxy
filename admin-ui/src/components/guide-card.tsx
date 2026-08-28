import { useMemo } from 'react'
import { PageHeader } from '@/components/page-header'
import type { GatewayConfig } from '@/lib/api'
import { CopyButton } from '@/lib/ui'

function CodeBlock({ caption, code }: { caption: string; code: string }) {
  return (
    <div className="bg-muted/40 group relative overflow-x-auto rounded-lg border">
      <div className="text-muted-foreground flex items-center justify-between px-3.5 pt-2.5 text-xs">
        <span>{caption}</span>
        <CopyButton
          text={code}
          variant="ghost"
          size="xs"
          className="opacity-0 transition-opacity group-hover:opacity-100"
        />
      </div>
      <pre className="text-foreground/90 px-3.5 pb-3 font-mono text-xs leading-relaxed">{code}</pre>
    </div>
  )
}

export function GuideCard({ config }: { config: GatewayConfig | null }) {
  const blocks = useMemo(() => {
    const base = window.location.origin
    const key = config?.apiKeyFull ?? '<APIKEY>'
    return {
      openai: {
        caption: 'OpenAI 兼容 · 流式对话',
        code:
          `curl -N ${base}/v1/chat/completions \\\n` +
          `  -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n` +
          `  -d '{"model":"gemini-3.7-flash-tiered","stream":true,"messages":[{"role":"user","content":"你好"}]}'`,
      },
      anthropic: {
        caption: 'Anthropic 兼容 · Claude 格式',
        code:
          `curl -N ${base}/v1/messages \\\n` +
          `  -H "x-api-key: ${key}" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" \\\n` +
          `  -d '{"model":"claude-sonnet-4-6","max_tokens":1024,"stream":true,"messages":[{"role":"user","content":"你好"}]}'`,
      },
      claudeCode: {
        caption: 'Claude Code CLI 接入',
        code:
          `export ANTHROPIC_BASE_URL=${base}\n` +
          `export ANTHROPIC_API_KEY=${key}\n` +
          `export ANTHROPIC_MODEL=claude-sonnet-4-6\n` +
          `claude`,
      },
    }
  }, [config?.apiKeyFull])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="接入指南"
        description={
          <>
            网关地址 <code className="bg-muted rounded px-1 font-mono">{window.location.origin}</code>
            （命令可直接复制执行，密钥已自动代入）
          </>
        }
      />
      <div className="flex flex-col gap-3">
        <CodeBlock {...blocks.openai} />
        <CodeBlock {...blocks.anthropic} />
        <CodeBlock {...blocks.claudeCode} />
        <p className="text-muted-foreground text-xs">
          Cherry Studio 等桌面客户端：供应商类型选 OpenAI 兼容，API 地址填上方网关地址（部分客户端需补{' '}
          <code className="bg-muted rounded px-1 font-mono">/v1</code>），密钥填 API Key，模型从列表选择或手动填写。
        </p>
      </div>
    </div>
  )
}
