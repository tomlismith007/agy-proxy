/**
 * Upstream wire-envelope handling: the v1internal API wraps generation payloads
 * in a top-level `{ response: … }` object. Owned here (upstream layer) so the
 * upstream client does not reach into adapters for it.
 */

/** Strip the upstream `{response: …}` wrapper if present. */
export function unwrapResponseEnvelope<T>(raw: T): T {
  if (raw && typeof raw === 'object') {
    const inner = (raw as Partial<Record<'response', T>>).response
    if (inner !== undefined) return inner
  }
  return raw
}
