/**
 * AES-256-GCM helpers for the encrypted account store and API key generation.
 * Payload format: v1.<iv-b64url>.<tag-b64url>.<data-b64url>
 */

import crypto from 'node:crypto'

export function generateMasterKey(): string {
  return crypto.randomBytes(32).toString('base64')
}

export function generateApiKey(): string {
  return `sk-agy-${crypto.randomBytes(24).toString('base64url')}`
}

function keyFrom(masterKeyB64: string): Buffer {
  const key = Buffer.from(masterKeyB64, 'base64')
  if (key.length !== 32) {
    throw new Error('master key must decode to 32 bytes')
  }
  return key
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

export function aesEncrypt(plaintext: string, masterKeyB64: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(masterKeyB64), iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${b64url(iv)}.${b64url(tag)}.${b64url(data)}`
}

export function aesDecrypt(payload: string, masterKeyB64: string): string {
  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('malformed encrypted payload')
  }
  const iv = Buffer.from(parts[1]!, 'base64url')
  const tag = Buffer.from(parts[2]!, 'base64url')
  const data = Buffer.from(parts[3]!, 'base64url')
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(masterKeyB64), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
