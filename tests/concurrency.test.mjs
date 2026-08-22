/**
 * Offline unit tests for verifier-brain core primitives.
 * Zero-dependency: uses the built-in node:test runner (Node >= 18).
 * Run: node --test tests/
 * These import the COMPILED lib/ output â€?run `bash scripts/build.sh` first,
 * or `npx tsc -p tsconfig.json` for a host-only build.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { Semaphore, LRUCache } from '../lib/concurrency.js'

/* ----------------------------- Semaphore ----------------------------- */

test('semaphore: enforces concurrency limit', async () => {
  const sem = new Semaphore(2)
  let active = 0
  let peak = 0
  await Promise.all(Array.from({ length: 6 }, () =>
    sem.run(async () => {
      active++
      peak = Math.max(peak, active)
      await delay(10)
      active--
    }),
  ))
  assert.equal(peak, 2, 'peak concurrency must never exceed the limit')
})

test('semaphore: preserves FIFO ordering of queued callers', async () => {
  const sem = new Semaphore(1)
  const order = []
  // First call occupies the only slot.
  const first = sem.run(async () => { await delay(20); return 'a' })
  const rest = ['b', 'c', 'd'].map((tag) =>
    sem.run(async () => { order.push(tag); return tag }),
  )
  await Promise.all([first, ...rest])
  assert.deepEqual(order, ['b', 'c', 'd'])
})

test('semaphore: abort while queued rejects and frees nothing', async () => {
  const sem = new Semaphore(1)
  const controller = new AbortController()
  // Occupy the slot.
  const blocker = sem.run(() => delay(50))
  const queued = sem.run(async () => 'never', controller.signal)
  controller.abort(new Error('caller gave up'))
  await assert.rejects(queued, /gave up/)
  await blocker // slot releases cleanly afterwards
  // Semaphore still usable.
  const after = await sem.run(async () => 'ok')
  assert.equal(after, 'ok')
})

test('semaphore: rejects invalid limits at construction', () => {
  assert.throws(() => new Semaphore(0))
  assert.throws(() => new Semaphore(-1))
  assert.throws(() => new Semaphore(Number.NaN))
})

test('semaphore: stats reflect active/queued', async () => {
  const sem = new Semaphore(1)
  assert.deepEqual(sem.stats, { limit: 1, active: 0, queued: 0 })
  const blocker = sem.run(() => delay(30))
  const queued = sem.run(async () => 1)
  await delay(5) // let the second call enqueue
  assert.equal(sem.stats.active, 1)
  assert.equal(sem.stats.queued, 1)
  await blocker
  await queued
  assert.equal(sem.stats.active, 0)
  assert.equal(sem.stats.queued, 0)
})

/* ------------------------------ LRUCache ------------------------------ */

test('lru: evicts least-recently-used entry beyond capacity', () => {
  const cache = new LRUCache(2)
  cache.set('a', 1)
  cache.set('b', 2)
  cache.get('a') // refresh a â†?b becomes LRU
  cache.set('c', 3) // must evict b
  assert.equal(cache.size, 2)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('b'), undefined, 'b was LRU and must be evicted')
  assert.equal(cache.get('c'), 3)
})

test('lru: expires entries after ttl', async () => {
  const cache = new LRUCache(10, 25) // 25ms ttl
  cache.set('k', 'v')
  assert.equal(cache.get('k'), 'v')
  await delay(40)
  assert.equal(cache.get('k'), undefined, 'entry must expire after ttl')
})

test('lru: ttl=Infinity semantics when ttlMs=0 (no expiry)', async () => {
  const cache = new LRUCache(4, 0)
  cache.set('k', 'v')
  await delay(20)
  assert.equal(cache.get('k'), 'v', 'ttlMs=0 disables expiry')
})

test('lru: bounded sweep keeps writes cheap under churn', () => {
  const cache = new LRUCache(100)
  for (let i = 0; i < 1000; i++) cache.set(i, i)
  assert.ok(cache.size <= 100, `size must stay bounded (got ${cache.size})`)
})

test('lru: promise values are stored and deduped by identity', async () => {
  const cache = new LRUCache(8)
  const p = (async () => 42)()
  cache.set('req', p)
  assert.equal(cache.get('req'), p, 'same promise identity returned')
})

test('lru: rejects invalid construction args', () => {
  assert.throws(() => new LRUCache(0))
  assert.throws(() => new LRUCache(10, -1))
})
