/**
 * Zero-dependency concurrency & cache primitives for verifier-brain.
 *
 * Why inline instead of p-limit / lru-cache packages:
 * 1. npm peer-dependency resolution against the DSH installation is fragile
 *    (junction-linked node_modules get wiped by plain `npm install`);
 * 2. Both primitives are <60 lines and fully testable offline.
 *
 * - Semaphore: bounds concurrent bridge scoring calls (prevents API rate-limit
 *   storms when multiple verifier tools fire at once). Mirrors p-limit usage:
 *   `const run = sem.wrap(fn); await run(...)`.
 * - LRUCache: bounded result cache replacing the unbounded Map in tools.ts
 *   (long-running DSH sessions previously leaked memory; entries never
 *   expired so stale escalated composites could also be served forever).
 */

/** Counts pending + in-flight acquisitions for diagnostics. */
export interface SemaphoreStats {
  /** Max concurrent holders. */
  readonly limit: number
  /** Currently executing holders. */
  active: number
  /** Callers waiting for a slot. */
  queued: number
}

export class Semaphore {
  private readonly limit: number
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(limit: number) {
    if (!Number.isFinite(limit) || limit < 1) throw new Error(`Semaphore limit must be >= 1 (got ${limit})`)
    this.limit = Math.floor(limit)
  }

  get stats(): SemaphoreStats {
    return { limit: this.limit, active: this.active, queued: this.queue.length }
  }

  /** Acquire a slot; resolves with the release function. */
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++
      return () => this.release()
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active++
        resolve(() => this.release())
      })
    })
  }

  /**
   * Run `fn` under the semaphore. If `signal` aborts while queued, the
   * caller is dequeued and the signal reason is thrown (in-flight fn is NOT
   * cancelled — the bridge request carries its own signal handling).
   */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted before acquiring semaphore slot')
    const release = await new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const idx = this.queue.indexOf(dequeue)
        if (idx >= 0) this.queue.splice(idx, 1)
        reject(signal!.reason ?? new Error('aborted while waiting for semaphore slot'))
      }
      const dequeue = () => {
        signal?.removeEventListener('abort', onAbort)
        this.active++
        resolve(() => this.release())
      }
      if (this.active < this.limit) {
        dequeue()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(dequeue)
    })
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

interface LRUEntry<V> {
  value: V
  /** Insertion tick for LRU ordering (refreshed on get). */
  tick: number
  /** Absolute expiry (Date.now()-based); Infinity when ttlMs <= 0. */
  expiresAt: number
}

/**
 * Bounded LRU cache with per-entry TTL.
 *
 * - `maxEntries` caps memory (default 500): evicts least-recently-used entry.
 * - `ttlMs` bounds staleness (default 30min): expired entries are dropped on
 *   access AND opportunistically swept on write (max 32 per sweep to keep
 *   writes O(1)-ish).
 * - Values may be promises (tools.ts caches in-flight requests to dedupe).
 */
export class LRUCache<K, V> {
  private readonly map = new Map<K, LRUEntry<V>>()
  private tick = 0

  constructor(
    private readonly maxEntries = 500,
    private readonly ttlMs = 30 * 60_000,
  ) {
    if (!Number.isFinite(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be >= 1')
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('ttlMs must be >= 0')
  }

  get size(): number {
    return this.map.size
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key)
    if (entry === undefined) return undefined
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key)
      return undefined
    }
    // Refresh recency.
    entry.tick = ++this.tick
    // Re-insert to move to insertion-order tail (Map iteration order).
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    // Opportunistic expiry sweep (bounded work per write).
    if (this.ttlMs > 0 && this.map.size > 0) {
      let swept = 0
      const now = Date.now()
      for (const [k, e] of this.map) {
        if (now > e.expiresAt) {
          this.map.delete(k)
          if (++swept >= 32) break
        }
      }
    }
    // Capacity eviction: oldest tail entry (least recently used).
    while (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey === undefined) break
      this.map.delete(oldestKey)
    }
    this.map.set(key, { value, tick: ++this.tick, expiresAt: this.ttlMs > 0 ? Date.now() + this.ttlMs : Number.POSITIVE_INFINITY })
  }

  has(key: K): boolean {
    return this.get(key) !== undefined
  }

  delete(key: K): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }
}
