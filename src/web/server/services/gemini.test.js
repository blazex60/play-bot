import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPrompt,
  createGeminiClient,
  createRefineRateLimiter,
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
