/**
 * Offline adapter smoke test (no network): drives a fake upstream SSE event
 * stream through both streaming adapters and validates request-side
 * sanitization + envelope assembly. Run: node tests/adapter-smoke.mjs
 */
import assert from 'node:assert'

const { buildAnthropicResponse } = await import('../dist/adapters/anthropic/response.js')
const { streamAnthropicEvents } = await import('../dist/adapters/anthropic/stream.js')
const { streamOpenAiChunks } = await import('../dist/adapters/openai/stream.js')
const { finalizeEnvelope } = await import('../dist/adapters/shared/finalize.js')
const { sanitizeTools, originalToolName } = await import('../dist/adapters/shared/tools.js')

// --- 1. tool schema sanitization -------------------------------------------
const tools = [
  {
    name: 'weird name with spaces!',
    description: 'd',
    input_schema: {
      type: 'object',
      properties: {
        union: { type: ['string', 'null'], description: 'x' },
        flags: { type: 'array', items: { type: ['boolean', 'string'] } },
        badEnum: { enum: [1, true, 'ok'] },
      },
      required: ['union'],
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      patternProperties: { '^x': {} },
    },
  },
  { name: 'google_search', input_schema: {} }, // builtin → dropped
]
const sanitized = sanitizeTools(tools)
assert.equal(sanitized.declarations.length, 1)
const decl = sanitized.declarations[0]
assert.match(decl.name, /^[a-zA-Z0-9_]{1,64}$/)
assert.equal(decl.parameters.properties.union.nullable, true)
assert.equal(decl.parameters.properties.union.type, 'string')
assert.equal(decl.parameters.properties.flags.items.type, 'boolean')
assert.deepEqual(decl.parameters.properties.badEnum.enum, ['ok'])
assert.ok(!('$schema' in decl.parameters))
assert.ok(!('patternProperties' in decl.parameters))
assert.equal(originalToolName(sanitized.nameMap, decl.name), 'weird name with spaces!')
console.log('✓ tool schema sanitizer enforces upstream contract')

// --- 2. envelope assembly ----------------------------------------------------
const draft = {
  model: 'gemini-3.7-flash-tiered',
  contents: [
    { role: 'user', parts: [{ text: 'hello' }] },
    { role: 'model', parts: [{ functionCall: { id: 'call_1', name: decl.name, args: { q: 1 } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'call_1', response: { result: 'ok' } } }] },
  ],
  systemInstructionText: 'be brief',
  declarations: sanitized.declarations,
  toolNameMap: sanitized.nameMap,
  generationConfig: {},
  reasoningEffort: 'medium',
}
const call = finalizeEnvelope(draft, { accountKey: 'user@test', projectId: 'proj-1' })
assert.equal(call.envelope.project, 'proj-1')
assert.equal(call.envelope.userAgent, 'antigravity')
assert.equal(call.envelope.requestType, 'agent')
assert.ok(call.envelope.request.sessionId.startsWith('-'))
assert.equal(call.envelope.request.generationConfig.thinkingConfig.thinkingLevel, 'medium')
assert.equal(call.envelope.request.toolConfig.functionCallingConfig.mode, 'VALIDATED')
// signature sentinel injected on history tool calls
const fc = call.envelope.request.contents[1].parts[0].functionCall
const part = call.envelope.request.contents[1].parts[0]
assert.equal(part.thoughtSignature, 'skip_thought_signature_validator')
console.log('✓ envelope: project/sessionId/thinkingLevel/toolConfig/signature sentinel')

// claude strip trailing model turn
const draftClaude = { ...draft, model: 'claude-sonnet-4-6', contents: [...draft.contents, { role: 'model', parts: [{ text: 'prefill' }] }] }
const callClaude = finalizeEnvelope(draftClaude, { accountKey: 'user@test' })
const roles = callClaude.envelope.request.contents.map((c) => c.role)
assert.ok(!roles.includes('model') || roles[roles.length - 1] !== 'model')
console.log('✓ claude trailing model turn stripped')

// --- 3. fake upstream SSE -> adapters ---------------------------------------
function sseGen(frames) {
  return (async function* () {
    for (const f of frames) yield { data: JSON.stringify(f) }
  })()
}
const upstreamFrames = [
  { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
  { candidates: [{ content: { parts: [{ text: 'lo' }, { thought: true, text: 'hmm' }] } }] },
  { candidates: [{ content: { parts: [{ thoughtSignature: 'sig123', functionCall: { id: 'c9', name: decl.name, args: { x: 2 } } }] } }] },
  { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } },
]

let out = ''
for await (const frame of streamAnthropicEvents(sseGen(upstreamFrames), { requestedModel: 'claude-sonnet-4-6', toolNameMap: sanitized.nameMap, responseId: 'msg_x', created: 1 })) {
  out += frame
}
for (const expected of [
  'event: message_start',
  'event: ping',
  '"type":"thinking"',
  'thinking_delta',
  'event: content_block_stop',
  '"type":"text"',
  '"type":"text_delta","text":"Hel"',
  '"type":"text_delta","text":"lo"',
  '"tool_use"',
  `"id":"c9"`,
  `"name":"weird name with spaces!"`,
  'input_json_delta',
  'message_delta',
  '"stop_reason":"tool_use"',
  '"output_tokens":5',
  'message_stop',
]) {
  assert.ok(out.includes(expected), `anthropic stream missing: ${expected}`)
}
const blockStarts = out.match(/content_block_start/g)?.length ?? 0
const blockStops = out.match(/content_block_stop/g)?.length ?? 0
assert.equal(blockStarts, blockStops, 'block start/stop must pair')
// "Hel" + "lo" must land in ONE open text block (merged, not re-started)
assert.equal((out.match(/"type":"text","text":""/g) ?? []).length, 1, 'consecutive text parts merge into one block')
console.log('✓ anthropic stream lifecycle strict + tool_use mapping')

let oai = ''
for await (const frame of streamOpenAiChunks(sseGen(upstreamFrames), { requestedModel: 'gemini-3.7-flash-tiered', toolNameMap: sanitized.nameMap, responseId: 'chatcmpl_x', created: 1 })) {
  oai += frame
}
assert.ok(oai.includes('"reasoning_content"'))
assert.ok(oai.includes('"finish_reason":"tool_calls"'))
assert.ok(oai.includes('"prompt_tokens":10'))
assert.ok(oai.endsWith('data: [DONE]\n\n'))
console.log('✓ openai stream chunks + usage + [DONE]')

// signature remembered from upstream replay
const { signatureForCall } = await import('../dist/adapters/shared/thinking.js')
assert.equal(signatureForCall('c9'), 'sig123')
console.log('✓ thought_signature captured by call id')

// --- 4. non-streaming anthropic response shape ------------------------------
const parsedResp = {
  text: 'answer',
  thoughtText: '',
  calls: [{ id: 'c1', name: decl.name, args: {} }],
  finishReason: 'STOP',
  usage: { promptTokenCount: 7, candidatesTokenCount: 3 },
}
const msg = buildAnthropicResponse(parsedResp, { requestedModel: 'claude-sonnet-4-6', toolNameMap: sanitized.nameMap, responseId: 'msg_1', created: 1 })
assert.equal(msg.stop_reason, 'tool_use')
assert.equal(msg.content.find((b) => b.type === 'tool_use').name, 'weird name with spaces!')
assert.deepEqual(msg.usage, { input_tokens: 7, output_tokens: 3 })
console.log('✓ anthropic non-stream message shape')

console.log('\nALL ADAPTER SMOKE TESTS PASSED')
