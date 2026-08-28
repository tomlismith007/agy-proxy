/**
 * Copy the built admin console (admin-ui/dist, produced by `npm run build:ui`)
 * into dist/admin/public so the compiled gateway bundle is self-contained.
 * Falls back to the legacy static assets when the UI has not been built.
 */

import { cp, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const uiDist = path.join(root, 'admin-ui', 'dist')
const legacy = path.join(root, 'src', 'admin', 'public')
const dest = path.join(root, 'dist', 'admin', 'public')

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

if (await exists(uiDist)) {
  await cp(uiDist, dest, { recursive: true, force: true })
  console.log(`copied admin UI: ${uiDist} -> ${dest}`)
} else if (await exists(legacy)) {
  await cp(legacy, dest, { recursive: true, force: true })
  console.warn(`WARN: admin-ui/dist 不存在，回退使用旧版静态页 ${legacy}（请先运行 npm run build:ui）`)
} else {
  console.error('ERROR: 没有可用的管理页资源。请先运行 npm run build:ui 构建 admin-ui。')
  process.exit(1)
}
