import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWebClient } from './webClient.js'

function fakeFetch(responses) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: url.toString(), options })
    const next = responses.shift()
    if (!next) throw new Error(`Unexpected fetch call: ${url}`)
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      text: async () => JSON.stringify(next.body ?? {}),
    }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function hangingFetch() {
  return (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      reject(err)
    })
  })
}

test('recordPlay posts to /internal/play-history with a bearer token', async () => {
  const fetchImpl = fakeFetch([{ body: { ok: true } }])
  const client = createWebClient({ baseUrl: 'http://127.0.0.1:9', token: 'tok', fetchImpl })

  await client.recordPlay({ guildId: 'g1', discordUserId: 'u1', username: 'user', trackTitle: 'T', trackUrl: 'https://example.com/t', videoId: 'v1', channel: 'C' })

  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(new URL(fetchImpl.calls[0].url).pathname, '/internal/play-history')
  assert.equal(fetchImpl.calls[0].options.method, 'POST')
  assert.equal(fetchImpl.calls[0].options.headers.authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body), {
    guildId: 'g1', discordUserId: 'u1', username: 'user', trackTitle: 'T', trackUrl: 'https://example.com/t', videoId: 'v1', channel: 'C',
  })
})

test('recordPlay never throws, even when the Web API is unreachable', async () => {
  const fetchImpl = async () => { throw new Error('network down') }
  const client = createWebClient({ baseUrl: 'http://127.0.0.1:9', token: 'tok', fetchImpl })

  await assert.doesNotReject(() => client.recordPlay({ guildId: 'g1', discordUserId: 'u1', trackTitle: 'T', trackUrl: 'https://example.com/t' }))
})

test('recordPlay never throws on a non-2xx response', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 500, body: { error: 'boom' } }])
  const client = createWebClient({ baseUrl: 'http://127.0.0.1:9', token: 'tok', fetchImpl })

  await assert.doesNotReject(() => client.recordPlay({ guildId: 'g1', discordUserId: 'u1', trackTitle: 'T', trackUrl: 'https://example.com/t' }))
})

test('getRecentHistory fetches the recent endpoint with comma-joined userIds', async () => {
  const fetchImpl = fakeFetch([{ body: { u1: [{ videoId: 'v1', channel: 'C', playedAt: 100 }] } }])
  const client = createWebClient({ baseUrl: 'http://127.0.0.1:9', token: 'tok', fetchImpl })

  const result = await client.getRecentHistory({ guildId: 'g1', userIds: ['u1', 'u2'], limit: 50 })

  assert.deepEqual(result, { u1: [{ videoId: 'v1', channel: 'C', playedAt: 100 }] })
  const url = new URL(fetchImpl.calls[0].url)
  assert.equal(url.pathname, '/internal/play-history/recent')
  assert.equal(url.searchParams.get('guildId'), 'g1')
  assert.equal(url.searchParams.get('userIds'), 'u1,u2')
  assert.equal(url.searchParams.get('limit'), '50')
})

test('getRecentHistory returns {} without throwing when the Web API fails', async () => {
  const fetchImpl = async () => { throw new Error('network down') }
  const client = createWebClient({ baseUrl: 'http://127.0.0.1:9', token: 'tok', fetchImpl })

  const result = await client.getRecentHistory({ guildId: 'g1', userIds: ['u1'] })
  assert.deepEqual(result, {})
})

test('getRecentHistory returns {} for an empty userIds list without calling fetch', async () => {
  const fetchImpl = fakeFetch([])
  const client = createWebClient({ baseUrl: 'http://127.0.0.1:9', token: 'tok', fetchImpl })

  const result = await client.getRecentHistory({ guildId: 'g1', userIds: [] })
  assert.deepEqual(result, {})
  assert.equal(fetchImpl.calls.length, 0)
})

test('recordPlay aborts a hung request after the configured timeout instead of hanging forever', async () => {
  const client = createWebClient({ baseUrl: 'http://127.0.0.1:9', token: 'tok', fetchImpl: hangingFetch(), requestTimeoutMs: 20 })

  await assert.doesNotReject(() => client.recordPlay({ guildId: 'g1', discordUserId: 'u1', trackTitle: 'T', trackUrl: 'https://example.com/t' }))
})

test('getRecentHistory aborts a hung request after the configured timeout and returns {}', async () => {
  const client = createWebClient({ baseUrl: 'http://127.0.0.1:9', token: 'tok', fetchImpl: hangingFetch(), requestTimeoutMs: 20 })

  const result = await client.getRecentHistory({ guildId: 'g1', userIds: ['u1'] })
  assert.deepEqual(result, {})
})
