/**
 * Admin console page serving: the compiled React SPA (admin-ui, copied to
 * admin/public at build time) plus JSON data from /admin/* endpoints.
 * Assets resolve relative to this module, so they work both from src/
 * (tsx dev) and dist/ (compiled) layouts.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, Hono } from 'hono'

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** Resolve a request path inside PUBLIC_DIR; null when it escapes or is missing. */
function safeAsset(rel: string): { file: string; type: string } | null {
  const resolved = path.resolve(PUBLIC_DIR, rel)
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) return null
  const type = MIME_BY_EXT[path.extname(resolved).toLowerCase()]
  if (!type) return null
  try {
    fs.readFileSync(resolved)
    return { file: resolved, type }
  } catch {
    return null
  }
}

function sendFile(c: Context, asset: { file: string; type: string }, cache: string): Response {
  const body = fs.readFileSync(asset.file)
  return c.body(new Uint8Array(body), 200, {
    'Content-Type': asset.type,
    'Cache-Control': cache,
  })
}

/** Register `/` (console SPA), `/assets/*` (hashed bundles) and root statics. */
export function registerAdminPage(app: Hono): void {
  app.get('/assets/*', (c) => {
    const rel = c.req.path.slice('/assets/'.length)
    const asset = safeAsset(path.join('assets', rel))
    if (!asset) return c.text('not found', 404)
    // Vite content-hashes bundle filenames, so they can be cached forever.
    return sendFile(c, asset, 'public, max-age=31536000, immutable')
  })

  app.get('/:file{favicon.svg|favicon.ico|robots.txt}', (c) => {
    const asset = safeAsset(c.req.param('file'))
    return asset ? sendFile(c, asset, 'no-store') : c.text('not found', 404)
  })

  app.get('/', (c) => {
    const asset = safeAsset('index.html')
    if (!asset) {
      return c.text(
        '管理页资源缺失：' + PUBLIC_DIR + ' 下没有 index.html。\n' +
          '请先构建前端：npm run build:ui（或直接 npm run build）。',
        500,
      )
    }
    return sendFile(c, asset, 'no-store')
  })
}
