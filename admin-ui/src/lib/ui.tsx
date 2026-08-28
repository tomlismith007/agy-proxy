/** Shared small UI utilities: clipboard, error extraction, copy button, blob download. */

import { useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError } from '@/lib/api'

/** Extract a human-readable message from an arbitrary throw. */
export function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      /* ignore */
    }
    ta.remove()
    return ok
  }
}

/** Button with built-in "copied" feedback; renders nothing when text is empty. */
export function CopyButton({
  text,
  label = '复制',
  copiedLabel = '已复制',
  ...props
}: {
  text: string | undefined | null
  label?: string
  copiedLabel?: string
} & Omit<React.ComponentProps<typeof Button>, 'onClick' | 'children'>) {
  const [copied, setCopied] = useState(false)
  if (!text) return null
  return (
    <Button
      {...props}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        }
      }}
    >
      {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      {copied ? copiedLabel : label}
    </Button>
  )
}

/**
 * POST a JSON body and save the response as a file download, honoring the
 * backend's Content-Disposition filename.
 */
export async function postDownload(path: string, body?: unknown): Promise<void> {
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  } catch (e) {
    throw new ApiError(`网络请求失败：${e instanceof Error ? e.message : String(e)}`, 0)
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const data = (await res.json()) as { error?: string | { message?: string } }
      message = typeof data.error === 'string' ? data.error : (data.error?.message ?? message)
    } catch {
      /* no body */
    }
    throw new ApiError(message, res.status)
  }
  const filename =
    res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'agy-proxy-export.json'
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Six-cell loading placeholder; pass the same grid classes as the real content. */
export function SkeletonGrid({ className = 'grid-cols-2 gap-3 sm:grid-cols-3' }: { className?: string }) {
  return (
    <div className={`grid ${className}`}>
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-14 rounded-lg" />
      ))}
    </div>
  )
}
