/**
 * SSE response writer: pull-based ReadableStream over an async generator of
 * ready-encoded frame strings, with standard no-buffering headers.
 */

const ENCODER = new TextEncoder()

export function sseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }
}

export function sseResponse(frames: AsyncGenerator<string>): Response {
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await frames.next()
        if (done) {
          controller.close()
        } else {
          controller.enqueue(ENCODER.encode(value))
        }
      } catch {
        // Generators emit their own error frames; anything escaping here is
        // unrecoverable — close the stream so the client sees a truncation.
        try {
          controller.close()
        } catch {
          // already closed by the runtime on client disconnect
        }
      }
    },
    cancel() {
      void frames.return(undefined)
    },
  })
  return new Response(stream, { headers: sseHeaders() })
}
