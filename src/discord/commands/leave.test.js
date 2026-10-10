import { test } from 'node:test'
import assert from 'node:assert/strict'
import leave from './leave.js'

function makeInteraction() {
  return {
    guildId: 'g1',
    channelId: 'vc-1',
    member: {
      displayName: '光希',
      voice: { channelId: 'vc-1' },
    },
    replies: [],
    async reply(payload) {
      this.replies.push(payload)
    },
  }
}

test('/leave stops the player before destroying the voice connection', async () => {
  const order = []
  const session = {
    player: {
      stop: async () => { order.push('stop') },
    },
    connection: {
      joinConfig: { channelId: 'vc-1' },
      destroy() { order.push('destroy') },
    },
  }
  const sessions = new Map([['g1', session]])
  const interaction = makeInteraction()

  await leave.execute(interaction, sessions)

  assert.equal(sessions.has('g1'), false)
  assert.deepEqual(order, ['stop', 'destroy'])
  assert.equal(interaction.replies.length, 1)
})
