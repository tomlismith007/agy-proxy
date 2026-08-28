/**
 * Server-Sent Events parser for the upstream `:streamGenerateContent?alt=sse`
 * channel: yields one event per `data:` frame, joined across continuation lines.
 */

export interface SseEvent {
  data: string
}

const DECODER = new TextDecoder('utf-8')

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader()
  let buffer = ''
  let dataLines: string[] = []

  const flush = function* (): Generator<SseEvent, void, undefined> {
    if (dataLines.length === 0) return
    yield { data: dataLines.join('\n') }
    dataLines = []
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += DECODER.decode(value, { stream: true })

      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)

        if (line === '') {
          yield* flush()
          continue
        }
        if (line.startsWith(':')) continue // comment / keep-alive
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart())
        }
      }
    }
    // Flush whatever remains without a trailing blank line.
    buffer += DECODER.decode()
    if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart())
    yield* flush()
  } finally {
    reader.releaseLock()
  }
}
