/**
 * Emergency hot stop. While `<dataDir>/KILL` exists every /v1/* request is
 * refused without touching upstream (api/middleware). Create/remove the file
 * to toggle — `agy-proxy pause` / `agy-proxy resume` and the admin console
 * pause/resume endpoints do exactly that.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Path of the kill-switch sentinel file inside the data directory. */
export function killFilePath(dataDir: string): string {
  return path.join(dataDir, 'KILL')
}

export function killSwitchEngaged(dataDir: string): boolean {
  return fs.existsSync(killFilePath(dataDir))
}

export function engageKillSwitch(dataDir: string): void {
  fs.writeFileSync(killFilePath(dataDir), new Date().toISOString(), { mode: 0o600 })
}

export function clearKillSwitch(dataDir: string): void {
  if (killSwitchEngaged(dataDir)) fs.unlinkSync(killFilePath(dataDir))
}
