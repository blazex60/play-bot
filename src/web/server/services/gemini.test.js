import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPrompt,
  createGeminiClient,
  createRefineRateLimiter,
  createGenerateRateLimiter,
  isGeminiGenerateAvailable,
  withGenerateLimit,
  REFINE_TIMEOUT_MS,
} from './gemini.js'

test('buildPrompt includes only title, channel, and duration', () => {
  const tracks = [
    {
      title: 'Song A',
      channel: 'Artist',
      duration: 210,
      analysis: { bpm: 128, headKey: '8B', harmonicConfidence: 0.9 },
    },
    {
      title: 'Song B',
      channel: 'Band',
      duration: 180,
      analysis: { bpm: 90, headKey: '5A' },
    },
  ]
  const prompt = buildPrompt(tracks, [0, 1])
  assert.match(prompt, /Song A/)
  assert.match(prompt, /Artist/)
  assert.match(prompt, /210s/)
  assert.doesNotMatch(prompt, /BPM/)
  assert.doesNotMatch(prompt, /8B/)
  assert.doesNotMatch(prompt, /head:/)
  assert.doesNotMatch(prompt, /128/)
})

test('refineOrder returns null when the API hangs past timeout', async () => {
  const fetchImpl = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      reject(err)
    })
  })
  const gemini = createGeminiClient({
    apiKey: 'test-key',
    fetchImpl,
    timeoutMs: 50,
  })
  const started = Date.now()
  const result = await gemini.refineOrder({
    tracks: [{ title: 'A', duration: 100 }, { title: 'B', duration: 100 }],
    algorithmOrder: [0, 1],
    timeoutMs: 50,
  })
  assert.equal(result, null)
  assert.ok(Date.now() - started < 1000)
})

test('createRefineRateLimiter enforces cooldown and single in-flight', () => {
  const limiter = createRefineRateLimiter({ cooldownMs: 60_000 })
  assert.equal(limiter.tryBegin('g1'), true)
  assert.equal(limiter.tryBegin('g1'), false, 'second concurrent acquire must fail')
  limiter.end('g1')
  assert.equal(limiter.tryBegin('g1'), false, 'cooldown must block immediate retry')
  assert.equal(limiter.tryBegin('g2'), true, 'other guilds remain independent')
  limiter.end('g2')
})

test('REFINE_TIMEOUT_MS stays under the bot webClient 5s abort', () => {
  assert.ok(REFINE_TIMEOUT_MS < 5000)
})

test('createGeminiClient without an API key is not available for generation', () => {
  const gemini = createGeminiClient({})
  assert.equal(gemini.available, false)
  assert.equal(isGeminiGenerateAvailable(gemini), false)
})

test('createGeminiClient with an API key is available for generation', () => {
  const gemini = createGeminiClient({ apiKey: 'test-key' })
  assert.equal(gemini.available, true)
  assert.equal(isGeminiGenerateAvailable(gemini), true)
})

test('createGenerateRateLimiter enforces per-user in-flight, cooldown, and global cap', () => {
  const limiter = createGenerateRateLimiter({ cooldownMs: 60_000, maxConcurrent: 2 })
  assert.equal(limiter.tryBegin('u1'), true)
  assert.equal(limiter.tryBegin('u1'), false, 'second concurrent acquire for the same user must fail')
  assert.equal(limiter.tryBegin('u2'), true)
  assert.equal(limiter.tryBegin('u3'), false, 'global cap must block a third concurrent job')
  limiter.end('u1')
  assert.equal(limiter.tryBegin('u1'), false, 'cooldown must block immediate retry')
  assert.equal(limiter.tryBegin('u3'), true, 'ending a job frees a global slot')
  limiter.end('u2')
  limiter.end('u3')
})

test('withGenerateLimit throws 429 when the limiter rejects', async () => {
  const limiter = createGenerateRateLimiter({ cooldownMs: 60_000, maxConcurrent: 1 })
  assert.equal(limiter.tryBegin('u1'), true)
  await assert.rejects(
    () => withGenerateLimit(limiter, 'u1', async () => 'ok'),
    (err) => err.statusCode === 429 && err.code === 'rate_limited',
  )
  limiter.end('u1')
})

