/**
 * Thought-signature session cache. The upstream requires every outbound
 * `functionCall` part to carry a sibling `thoughtSignature`; signatures are
 * issued per tool call on the response side and must be replayed by id on the
 * next turn. When nothing is cached, the documented sentinel is injected.
 */

/** Sentinel accepted by upstream when no real signature exists yet. */
export const THOUGHT_SIGNATURE_SENTINEL = 'skip_thought_signature_validator'

const MAX_ENTRIES = 2_000

const cache = new Map<string, string>()

/** Store the signature issued for a tool-call id (LRU-bounded). */
export function rememberSignature(callId: string | undefined, signature: string | undefined): void {
  if (!callId || !signature) return
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(callId, signature)
}

/** Signature for an outbound functionCall: replayed value or the sentinel. */
export function signatureForCall(callId: string | undefined): string {
  if (!callId) return THOUGHT_SIGNATURE_SENTINEL
  return cache.get(callId) ?? THOUGHT_SIGNATURE_SENTINEL
}

/** Test-only: drop every cached signature. */
export function clearSignatureCache(): void {
  cache.clear()
}
