/**
 * Tool schema sanitizer enforcing the upstream protobuf-Schema contract:
 * unknown keywords or invalid value shapes fail the whole request with 400,
 * so anything outside the allowlist is normalized away before sending.
 */

import { createHash } from 'node:crypto'
import type { FunctionDeclaration, UpstreamSchema } from '../../types.js'
import { ApiError } from './errors.js'

/** Keys the upstream Schema proto accepts; everything else is dropped. */
const ALLOWED_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'items',
  'enum', 'default', 'properties', 'required', 'additionalProperties',
])

const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

/**
 * Native-tool names the upstream treats as builtin Google tools; a client
 * declaring these collides with server-side tool config (400), so drop them.
 */
const BUILTIN_TOOL_NAMES = new Set(['google_search', 'web_search', 'search_web', 'googleSearch'])

function normalizeType(value: unknown, target: UpstreamSchema): void {
  if (typeof value === 'string') {
    if (value === 'null') {
      target.nullable = true
    } else if (VALID_TYPES.has(value)) {
      target.type = value
    }
    return
  }
  if (Array.isArray(value)) {
    // Union types: first non-null member wins, "null" becomes nullable.
    const members = value.filter((v): v is string => typeof v === 'string')
    if (members.includes('null')) target.nullable = true
    const primary = members.find((v) => v !== 'null' && VALID_TYPES.has(v))
    if (primary) target.type = primary
  }
}

function sanitizeNode(input: unknown): UpstreamSchema | undefined {
  if (input === null || input === undefined) return undefined
  if (typeof input !== 'object' || Array.isArray(input)) return undefined
  const source = input as Record<string, unknown>
  const output: UpstreamSchema = {}

  for (const [key, value] of Object.entries(source)) {
    if (!ALLOWED_KEYS.has(key)) continue
    switch (key) {
      case 'type':
        normalizeType(value, output)
        break
      case 'format':
      case 'title':
      case 'description':
        if (typeof value === 'string') (output as Record<string, unknown>)[key] = value
        break
      case 'nullable':
        if (value === true) output.nullable = true
        break
      case 'enum': {
        if (Array.isArray(value)) {
          const strings = value.filter((v): v is string => typeof v === 'string')
          // Empty enum after filtering is omitted entirely (upstream rejects []).
          if (strings.length > 0) output.enum = strings
        }
        break
      }
      case 'default':
        output.default = value
        break
      case 'items':
        output.items = sanitizeNode(value)
        break
      case 'properties': {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const props: Record<string, UpstreamSchema> = {}
          for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
            const sanitizedChild = sanitizeNode(child)
            if (sanitizedChild) props[name] = sanitizedChild
          }
          output.properties = props
        }
        break
      }
      case 'required': {
        if (Array.isArray(value)) {
          const names = value.filter((v): v is string => typeof v === 'string')
          if (names.length > 0) output.required = names
        }
        break
      }
      case 'additionalProperties':
        if (typeof value === 'boolean') {
          output.additionalProperties = value
        } else if (value && typeof value === 'object') {
          const nested = sanitizeNode(value)
          if (nested) output.additionalProperties = nested
        }
        break
    }
  }

  return output
}

export interface SanitizedTool {
  declaration: FunctionDeclaration
  /** original client-visible tool name */
  originalName: string
}

export interface SanitizedToolSet {
  declarations: FunctionDeclaration[]
  /** upstream-safe name -> original name (for response mapping). */
  nameMap: Map<string, string>
}

function sanitizeToolName(name: string, used: Set<string>): string {
  let cleaned = name.replace(/[^a-zA-Z0-9_]/g, '_')
  if (cleaned.length > 64 || used.has(cleaned) || (cleaned !== name && cleaned.length > 56)) {
    const tail = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 8)
    cleaned = `${cleaned.slice(0, 55)}_${tail}`
  }
  while (used.has(cleaned)) cleaned = `_${cleaned}`.slice(0, 64)
  used.add(cleaned)
  return cleaned
}

/**
 * Sanitize a client `tools` array (OpenAI or Anthropic shape — both carry
 * `{name, description?, parameters|input_schema?}`). Returns the upstream
 * functionDeclarations plus the sanitized→original name map.
 */
export function sanitizeTools(
  tools: ReadonlyArray<{ name?: unknown; description?: unknown; parameters?: unknown; input_schema?: unknown }>,
): SanitizedToolSet {
  const used = new Set<string>()
  const declarations: FunctionDeclaration[] = []
  const nameMap = new Map<string, string>()

  for (const tool of tools) {
    if (typeof tool.name !== 'string' || tool.name.length === 0) continue
    if (BUILTIN_TOOL_NAMES.has(tool.name)) continue
    const safeName = sanitizeToolName(tool.name, used)
    const schema = sanitizeNode(tool.parameters ?? tool.input_schema)
    declarations.push({
      name: safeName,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      ...(schema && Object.keys(schema).length > 0 ? { parameters: schema } : {}),
    })
    nameMap.set(safeName, tool.name)
  }

  return { declarations, nameMap }
}

/** Look up the original client-facing name for an upstream tool call. */
export function originalToolName(nameMap: Map<string, string>, upstreamName: string | undefined): string {
  if (!upstreamName) return 'unknown_tool'
  return nameMap.get(upstreamName) ?? upstreamName
}

/** Parse OpenAI `arguments` JSON strings defensively. */
export function parseArgumentsJson(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed }
  } catch {
    throw new ApiError(400, 'invalid_request_error', 'tool call arguments are not valid JSON')
  }
}
