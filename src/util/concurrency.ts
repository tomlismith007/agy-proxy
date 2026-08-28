/**
 * Counting semaphore bounding concurrent upstream calls. Keeps request bursts
 * from fanning out into many simultaneous Google connections — a burst of
 * parallel sockets is itself a risk-control signal, and per-account pacing
 * depends on there being few in-flight requests at once.
 */

export class GateFullError extends Error {
  constructor(limit: number) {
    super(`upstream concurrency limit reached (${limit} active, queue full)`)
    this.name = 'GateFullError'
  }
}

export class Semaphore {
  limit: number
  readonly maxQueue: number
  private active = 0
  private waiters: Array<() => void> = []

  constructor(limit: number, maxQueue = 32) {
    this.limit = Math.max(1, Math.trunc(limit) || 1)
    this.maxQueue = Math.max(0, Math.trunc(maxQueue))
  }

  get activeCount(): number {
    return this.active
  }

  /** Hot-adjust the capacity (admin config reload); wakes waiters on growth. */
  setCapacity(limit: number): void {
    this.limit = Math.max(1, Math.trunc(limit) || 1)
    while (this.active < this.limit && this.waiters.length > 0) {
      this.waiters.shift()!()
    }
  }

  /**
   * Acquire one slot; resolves with the release function. Rejects with
   * GateFullError immediately when the waiting queue is saturated.
   */
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1
      return () => this.release()
    }
    if (this.waiters.length >= this.maxQueue) {
      throw new GateFullError(this.limit)
    }
    return new Promise((resolve, reject) => {
      const waiter = (): void => {
        this.active += 1
        resolve(() => this.release())
      }
      this.waiters.push(waiter)
      if (this.waiters.length > this.maxQueue) {
        // Raced past the cap between the check and the push — unwind.
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new GateFullError(this.limit))
      }
    })
  }

  private release(): void {
    this.active -= 1
    const next = this.waiters.shift()
    if (next) next()
  }
}
