import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BotApiError, createBotClient } from './botClient.js'

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

test('createBotClient requires baseUrl and token', () => {
  assert.throws(() => createBotClient({ token: 'x' }), /BOT_API_URL/)
  assert.throws(() => createBotClient({ baseUrl: 'http://127.0.0.1:1' }), /BOT_API_TOKEN/)
})

test('botClient.request is a generic passthrough used by route-utils#callBot', async () => {
  const fetchImpl = fakeFetch([{ body: { ok: true } }])
  const client = createBotClient({ baseUrl: 'http://127.0.0.1:9', token: 'tok', fetchImpl })

  const result = await client.request('POST', '/control/g1/pause', { level: 5 })

  assert.deepEqual(result, { ok: true })
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(new URL(fetchImpl.calls[0].url).pathname, '/control/g1/pause')
  assert.equal(fetchImpl.calls[0].options.method, 'POST')
  assert.equal(fetchImpl.calls[0].options.headers.authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body), { level: 5 })
})

test('botClient named methods hit the expected bot API paths', async () => {
  const fetchImpl = fakeFetch([
    { body: { current: null } },
    { body: { basic: true } },
    { body: { ok: true } },
    { body: { ok: true } },
    { body: { jobId: 1 } },
  ])
  const client = createBotClient({ baseUrl: 'http://127.0.0.1:9', token: 'tok', fetchImpl })

  await client.state('g1')
  await client.permission({ guildId: 'g1', userId: 'u1' })
  await client.control('g1', 'pause', {})
  await client.queue('g1', 'remove', { index: 0 })
  await client.enqueueImport('g1', { tracks: [] })

  assert.deepEqual(
    fetchImpl.calls.map((call) => new URL(call.url).pathname + new URL(call.url).search),
    [
      '/state/g1',
      '/permission?guildId=g1&userId=u1',
      '/control/g1/pause',
      '/queue/g1/remove',
      '/import/g1/enqueue',
    ]
  )
})

test('botClient surfaces non-ok bot API responses as BotApiError', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 403, body: { error: 'forbidden' } }])
  const client = createBotClient({ baseUrl: 'http://127.0.0.1:9', token: 'tok', fetchImpl })

  await assert.rejects(
    () => client.state('g1'),
    (error) => {
      assert.ok(error instanceof BotApiError)
      assert.equal(error.status, 403)
      assert.deepEqual(error.body, { error: 'forbidden' })
      return true
    }
  )
})
