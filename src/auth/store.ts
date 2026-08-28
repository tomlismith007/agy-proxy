/**
 * Encrypted account store: accounts live AES-256-GCM encrypted in
 * <dataDir>/accounts.enc.json; the master key lives separately in
 * <dataDir>/.credentials.yaml (0600). Deleting local files does NOT revoke
 * Google-side authorization — surface that to users on logout.
 */

import fs from 'node:fs'
import path from 'node:path'
import { aesDecrypt, aesEncrypt, generateMasterKey } from '../util/crypto.js'
import { createLogger, errText } from '../util/log.js'
import type { AccountRecord } from '../types.js'

const log = createLogger('store')

const STORE_VERSION = 1

interface EncryptedStoreFile {
  version: number
  payload: string
}

function masterKeyPath(dataDir: string): string {
  return path.join(dataDir, '.credentials.yaml')
}

function accountsPath(dataDir: string): string {
  return path.join(dataDir, 'accounts.enc.json')
}

function loadMasterKey(dataDir: string): string {
  const file = masterKeyPath(dataDir)
  try {
    const text = fs.readFileSync(file, 'utf8')
    const match = text.match(/^AGY_MASTER_KEY:\s*(\S+)\s*$/m)
    if (match?.[1]) return match[1]
  } catch {
    // fall through to creation
  }
  const key = generateMasterKey()
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file, `AGY_MASTER_KEY: ${key}\n`, { mode: 0o600 })
  restrictPermissions(file)
  log.info(`generated new master key at ${file}`)
  return key
}

/** Best-effort permission tightening; Windows ACLs are not POSIX modes. */
function restrictPermissions(file: string): void {
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // ignore — non-POSIX filesystems
  }
}

export class AccountStore {
  private readonly dataDir: string
  private readonly masterKey: string
  private accounts: Map<string, AccountRecord> = new Map()

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.masterKey = loadMasterKey(dataDir)
    this.load()
  }

  private load(): void {
    const file = accountsPath(this.dataDir)
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as EncryptedStoreFile
      if (raw.version !== STORE_VERSION || typeof raw.payload !== 'string') {
        throw new Error('unsupported store file')
      }
      const plaintext = aesDecrypt(raw.payload, this.masterKey)
      const records = JSON.parse(plaintext) as AccountRecord[]
      this.accounts = new Map(records.map((record) => [record.email, record]))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
      if (error instanceof Error && error.message.includes('unsupported store file')) throw error
      // Corrupt or undecryptable store: start empty rather than crash the CLI/server.
      log.warn(`account store unreadable (${errText(error)}); starting empty`)
      this.accounts = new Map()
    }
  }

  persist(): void {
    fs.mkdirSync(this.dataDir, { recursive: true })
    const payload = aesEncrypt(JSON.stringify([...this.accounts.values()], null, 0), this.masterKey)
    const body: EncryptedStoreFile = { version: STORE_VERSION, payload }
    fs.writeFileSync(accountsPath(this.dataDir), JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
  }

  list(): AccountRecord[] {
    return [...this.accounts.values()]
  }

  get(email: string): AccountRecord | undefined {
    return this.accounts.get(email)
  }

  upsert(record: AccountRecord): void {
    this.accounts.set(record.email, record)
    this.persist()
  }

  /** Mutate one account in place and persist. Returns false when missing. */
  update(email: string, mutate: (record: AccountRecord) => void): boolean {
    const record = this.accounts.get(email)
    if (!record) return false
    mutate(record)
    this.persist()
    return true
  }

  remove(email: string): boolean {
    const removed = this.accounts.delete(email)
    if (removed) this.persist()
    return removed
  }

  get size(): number {
    return this.accounts.size
  }
}

export function openStore(dataDir: string): AccountStore {
  return new AccountStore(dataDir)
}
