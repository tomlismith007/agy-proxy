/**
 * Outbound request URL guard (SSRF protection, mandatory for every server-side fetch).
 *
 * Rules:
 * - only http / https schemes;
 * - validate the host before sending: reject localhost and loopback,
 *   private and reserved addresses;
 * - resolve DNS before connecting and re-check every resolved IP
 *   (basic DNS-rebinding mitigation);
 * - fake-IP carve-out: TUN-mode proxy clients (Clash et al.) answer local DNS
 *   with placeholder addresses from 198.18.0.0/15; these are aliases assigned
 *   by the user's own trusted proxy, not reachable infrastructure, so they are
 *   allowed through (the TUN device routes them);
 * - when AGY_PROXY_PROXY / HTTPS_PROXY is set, all traffic is dispatched
 *   through that proxy and the local DNS re-check is skipped entirely —
 *   resolution happens at the proxy.
 */

import { promises as dns } from 'node:dns'
import net from 'node:net'
import { ProxyAgent } from 'undici'
import { createLogger } from './log.js'

const log = createLogger('urlguard')

export class OutboundUrlBlockedError extends Error {
  constructor(url: string, reason: string) {
    super(`outbound URL blocked (${reason}): ${url}`)
    this.name = 'OutboundUrlBlockedError'
  }
}

interface V4Range {
  network: number
  prefix: number
  label: string
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value >>> 0
}

/** Private / reserved IPv4 ranges (network, prefix length, label). */
const BLOCKED_V4_RANGES: readonly V4Range[] = [
  { network: ipv4ToInt('0.0.0.0')!, prefix: 8, label: 'this-network' },
  { network: ipv4ToInt('10.0.0.0')!, prefix: 8, label: 'private' },
  { network: ipv4ToInt('100.64.0.0')!, prefix: 10, label: 'cgnat' },
  { network: ipv4ToInt('127.0.0.0')!, prefix: 8, label: 'loopback' },
  { network: ipv4ToInt('169.254.0.0')!, prefix: 16, label: 'link-local' },
  { network: ipv4ToInt('172.16.0.0')!, prefix: 12, label: 'private' },
  { network: ipv4ToInt('192.0.0.0')!, prefix: 24, label: 'reserved' },
  { network: ipv4ToInt('192.0.2.0')!, prefix: 24, label: 'documentation' },
  { network: ipv4ToInt('192.88.99.0')!, prefix: 24, label: 'reserved' },
  { network: ipv4ToInt('192.168.0.0')!, prefix: 16, label: 'private' },
  { network: ipv4ToInt('198.18.0.0')!, prefix: 15, label: 'benchmark' },
  { network: ipv4ToInt('198.51.100.0')!, prefix: 24, label: 'documentation' },
  { network: ipv4ToInt('203.0.113.0')!, prefix: 24, label: 'documentation' },
  { network: ipv4ToInt('224.0.0.0')!, prefix: 4, label: 'multicast' },
  { network: ipv4ToInt('240.0.0.0')!, prefix: 4, label: 'reserved' },
]

/** Fake-IP ranges used by TUN proxy clients' DNS (placeholder aliases, not real destinations). */
const FAKEIP_V4_RANGES: readonly V4Range[] = [
  { network: ipv4ToInt('198.18.0.0')!, prefix: 15, label: 'fake-ip' },
]

export function isForbiddenIpv4(ip: string): string | null {
  const value = ipv4ToInt(ip)
  if (value === null) return 'malformed-ipv4'
  for (const range of BLOCKED_V4_RANGES) {
    const mask = range.prefix === 0 ? 0 : (0xffffffff << (32 - range.prefix)) >>> 0
    if ((value & mask) === (range.network & mask)) return range.label
  }
  return null
}

function inFakeIpRange(ip: string): boolean {
  const value = ipv4ToInt(ip)
  if (value === null) return false
  for (const range of FAKEIP_V4_RANGES) {
    const mask = (0xffffffff << (32 - range.prefix)) >>> 0
    if ((value & mask) === (range.network & mask)) return true
  }
  return false
}

function ipv6ToBytes(ip: string): Uint8Array | null {
  // Expand via a lightweight parse; Node's net.isIPv6 validates the shape.
  try {
    const groups = new Array<number>(8).fill(0)
    let head = ip
    let tail = ''
    const dc = ip.indexOf('::')
    if (dc >= 0) {
      head = ip.slice(0, dc)
      tail = ip.slice(dc + 2)
    }
    const parseGroups = (s: string): number[] =>
      s.length === 0 ? [] : s.split(':').map((g) => parseInt(g, 16))
    const headGroups = parseGroups(head)
    const tailGroups = parseGroups(tail)
    if (headGroups.some((n) => Number.isNaN(n)) || tailGroups.some((n) => Number.isNaN(n))) return null
    if (dc >= 0) {
      if (headGroups.length + tailGroups.length > 7) return null
      headGroups.forEach((g, i) => (groups[i] = g))
      tailGroups.forEach((g, i) => (groups[8 - tailGroups.length + i] = g))
    } else {
      if (headGroups.length !== 8) return null
      headGroups.forEach((g, i) => (groups[i] = g))
    }
    const bytes = new Uint8Array(16)
    groups.forEach((g, i) => {
      bytes[i * 2] = g >> 8
      bytes[i * 2 + 1] = g & 0xff
    })
    return bytes
  } catch {
    return null
  }
}

function isForbiddenIpv6(ip: string): string | null {
  // IPv4-mapped (::ffff:a.b.c.d) — apply IPv4 rules to the embedded address.
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isForbiddenIpv4(mapped[1]!)
  const bytes = ipv6ToBytes(ip)
  if (!bytes) return 'malformed-ipv6'
  const allZero = bytes.every((b) => b === 0)
  if (allZero) return 'unspecified'
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0 && bytes[12] === 127) return 'loopback'
  if (bytes[0] === 0xff) return 'multicast'
  if ((bytes[0]! & 0xfe) === 0xfc) return 'ula-private'
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return 'link-local'
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return 'documentation'
  return null
}

export function isForbiddenIp(ip: string): string | null {
  if (net.isIPv4(ip)) return isForbiddenIpv4(ip)
  if (net.isIPv6(ip)) return isForbiddenIpv6(ip)
  return 'not-an-ip'
}

/**
 * Validate an outbound URL synchronously (scheme + hostname shape).
 * Throws OutboundUrlBlockedError when the URL must not be requested.
 */
export function assertSafeOutboundUrl(rawUrl: string | URL): URL {
  let url: URL
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl)
  } catch {
    throw new OutboundUrlBlockedError(String(rawUrl), 'unparseable-url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundUrlBlockedError(url.toString(), `scheme ${url.protocol} not allowed`)
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new OutboundUrlBlockedError(url.toString(), 'localhost host')
  }
  if (net.isIP(host)) {
    const reason = isForbiddenIp(host)
    if (reason) throw new OutboundUrlBlockedError(url.toString(), `${reason} address`)
  }
  return url
}

async function assertSafeHostResolved(url: URL): Promise<void> {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (net.isIP(host)) return // literal already validated by assertSafeOutboundUrl
  let resolved: { address: string }[]
  try {
    resolved = await dns.lookup(host, { all: true, verbatim: true })
  } catch (error) {
    throw new OutboundUrlBlockedError(
      url.toString(),
      `dns resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (resolved.length === 0) {
    throw new OutboundUrlBlockedError(url.toString(), 'dns resolved to no addresses')
  }
  let fakeIpSeen = false
  for (const entry of resolved) {
    if (inFakeIpRange(entry.address)) {
      fakeIpSeen = true
      continue // TUN proxy placeholder — routed by the local proxy device
    }
    const reason = isForbiddenIp(entry.address)
    if (reason) {
      throw new OutboundUrlBlockedError(url.toString(), `resolves to ${reason} address ${entry.address}`)
    }
  }
  if (fakeIpSeen) warnFakeIpOnce(host)
}

let fakeIpWarned = false
function warnFakeIpOnce(host: string): void {
  if (fakeIpWarned) return
  fakeIpWarned = true
  log.warn(
    `detected fake-IP DNS for ${host} (TUN-mode proxy client); allowing through the tunnel. ` +
      'Set AGY_PROXY_PROXY / HTTPS_PROXY to route egress explicitly.',
  )
}

// ---------------------------------------------------------------------------
// Optional explicit egress proxy
// ---------------------------------------------------------------------------

let cachedAgent: { proxy: string; agent: ProxyAgent } | undefined

function resolveProxyDispatcher(): ProxyAgent | undefined {
  const proxy =
    process.env.AGY_PROXY_PROXY?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim()
  if (!proxy) return undefined
  if (!cachedAgent || cachedAgent.proxy !== proxy) {
    cachedAgent = { proxy, agent: new ProxyAgent(proxy) }
  }
  return cachedAgent.agent
}

/**
 * The only sanctioned way to issue server-side HTTP requests in this codebase.
 * Validates scheme/host; with an explicit proxy configured, dispatches through
 * it and skips local DNS re-check (resolution happens at the proxy);
 * otherwise resolves and re-checks DNS IPs, then performs the fetch.
 */
export async function safeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = assertSafeOutboundUrl(input)
  const dispatcher = resolveProxyDispatcher()
  if (dispatcher) {
    return fetch(url, { ...init, dispatcher } as unknown as RequestInit)
  }
  await assertSafeHostResolved(url)
  return fetch(url, init)
}
