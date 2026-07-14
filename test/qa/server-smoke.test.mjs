import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { z } from 'zod'

test('P0 Fastify and Zod server harness responds through inject', async () => {
  const responseSchema = z.object({ status: z.literal('p0-ready') })
  const app = Fastify({ logger: false })
  app.get('/p0-smoke', async () => ({ status: 'p0-ready' }))
  try {
    const response = await app.inject({ method: 'GET', url: '/p0-smoke' })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(responseSchema.parse(response.json()), { status: 'p0-ready' })
  } finally {
    await app.close()
  }
})
