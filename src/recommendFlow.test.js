import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GuildQueue, createTrack } from './queue.js'
import { PendingChoiceStore } from './views.js'
import { cancelRecommendations, handleRecommendChoice, postRecommendations } from './recommendFlow.js'

function makeCandidate(videoId) {
  return createTrack({ title: videoId, webpageUrl: `https://example.com/${videoId}`, duration: 60, videoId })
}

function makeChannel({ sendFails = false } = {}) {
  const sent = []
  return {
    sent,
    async send(payload) {
      if (sendFails) throw new Error('missing permission')
      const message = {
        id: `msg-${sent.length}`,
        components: [{ components: [{ setDisabled() {} }] }],
        editCalls: [],
        async edit(update) {
          this.editCalls.push(update)
        },
      }
      sent.push({ payload, message })
      return message
    },
  }
}

function makeSession({ voiceChannelId = 'vc-1' } = {}) {
  const queue = new GuildQueue()
  const playNextCalls = []
  return {
    connection: { joinConfig: { channelId: voiceChannelId } },
    queue,
    player: {
      async playNext() { playNextCalls.push(true) },
      playNextCalls,
    },
  }
}

function makeInteraction({ customId, messageId, userId, voiceChannelId, interactionChannelId }) {
  const replies = []
  return {
    customId,
    message: { id: messageId },
    user: { id: userId },
    member: { voice: { channelId: voiceChannelId } },
    channelId: interactionChannelId ?? voiceChannelId,
    deferred: false,
    replied: false,
    replies,
    async reply(payload) { replies.push(payload); this.replied = true },
    async followUp(payload) { replies.push(payload) },
    async deferUpdate() { this.deferred = true },
  }
}

test('postRecommendations: returns the count of successfully posted messages', async (t) => {
  const channel = makeChannel()
  const pendingStore = new PendingChoiceStore()
  const plans = [
    { userId: 'u1', candidates: [makeCandidate('v1')] },
    { userId: 'u2', candidates: [makeCandidate('v2')] },
  ]
  const count = await postRecommendations({ channel, guildId: 'g1', plans, pendingStore })
  t.after(() => {
    for (const [, entry] of pendingStore.entries()) clearTimeout(entry.timeoutHandle)
  })
  assert.equal(count, 2)
  assert.equal(channel.sent.length, 2)
})

test('postRecommendations: returns 0 when every send fails, without throwing', async () => {
  const channel = makeChannel({ sendFails: true })
  const pendingStore = new PendingChoiceStore()
  const plans = [{ userId: 'u1', candidates: [makeCandidate('v1')] }]
  const count = await postRecommendations({ channel, guildId: 'g1', plans, pendingStore })
  assert.equal(count, 0)
})

test('postRecommendations: skips plans with no candidates', async () => {
  const channel = makeChannel()
  const pendingStore = new PendingChoiceStore()
  const plans = [{ userId: 'u1', candidates: [] }]
  const count = await postRecommendations({ channel, guildId: 'g1', plans, pendingStore })
  assert.equal(count, 0)
  assert.equal(channel.sent.length, 0)
})

test('postRecommendations: discards a message whose send resolves after the round already won', async (t) => {
  const pendingStore = new PendingChoiceStore()
  let resolveSecondSend
  const secondSendGate = new Promise((resolve) => { resolveSecondSend = resolve })
  let sendCount = 0
  const channel = {
    async send() {
      sendCount += 1
      if (sendCount === 1) return makeSentMessage('msg-1')
      await secondSendGate
      return makeSentMessage('msg-2')
    },
  }
  const plans = [
    { userId: 'u1', candidates: [makeCandidate('v1')] },
    { userId: 'u2', candidates: [makeCandidate('v2')] },
  ]

  const postPromise = postRecommendations({ channel, guildId: 'g1', plans, pendingStore })

  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(pendingStore.get('msg-1'), 'first message should already be stored while the second send is still pending')
  t.after(() => {
    const entry = pendingStore.get('msg-1')
    if (entry) clearTimeout(entry.timeoutHandle)
  })

  // Simulate the first message's pick winning the round while the second
  // send is still in flight.
  cancelRecommendations('g1', pendingStore)
  resolveSecondSend()

  const postedCount = await postPromise
  assert.equal(postedCount, 1, 'the late-arriving message must not count as posted')
  assert.equal(pendingStore.get('msg-2'), null, 'the late message must not be left as a live, pickable entry')
})

test('handleRecommendChoice: rejects a click from someone other than the target user', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: { id: 'msg-1' }, timeoutHandle: null })
  const sessions = new Map([['g1', makeSession()]])
  const interaction = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-1', userId: 'someone-else', voiceChannelId: 'vc-1' })

  await handleRecommendChoice(interaction, sessions, pendingStore)

  assert.equal(interaction.replies[0].content, '❌ これはあなた宛のおすすめではありません')
  assert.ok(pendingStore.get('msg-1'), 'entry must remain so the actual target user can still pick')
})

test('handleRecommendChoice: rejects and preserves the entry if the target user left the VC', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: { id: 'msg-1' }, timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])
  const interaction = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-1', userId: 'u1', voiceChannelId: 'vc-2', interactionChannelId: 'vc-1' })

  await handleRecommendChoice(interaction, sessions, pendingStore)

  assert.equal(session.player.playNextCalls.length, 0, 'must not start playback for a user no longer in the VC')
  assert.ok(pendingStore.get('msg-1'), 'entry must survive a failed VC check so a legitimate retry still works')
})

test('handleRecommendChoice: honors a pick from a text channel other than the VC (regression: recommend prompts posted outside the VC chat were unclickable)', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: { id: 'msg-1' }, timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])
  // The recommendation was posted to session.textChannelId (wherever /play
  // was invoked), which is often a normal text channel distinct from the
  // VC's own chat channel — simulated here via interactionChannelId.
  const interaction = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-1', userId: 'u1', voiceChannelId: 'vc-1', interactionChannelId: 'general-text-channel' })

  await handleRecommendChoice(interaction, sessions, pendingStore)

  assert.equal(session.queue.current.videoId, 'v1', 'the pick must succeed even though it was clicked from a non-VC text channel')
  assert.equal(session.player.playNextCalls.length, 1)
})

test('handleRecommendChoice: valid pick on an empty queue starts playback', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: { id: 'msg-1' }, timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])
  const interaction = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-1', userId: 'u1', voiceChannelId: 'vc-1' })

  await handleRecommendChoice(interaction, sessions, pendingStore)

  assert.equal(session.queue.current.videoId, 'v1')
  assert.equal(session.player.playNextCalls.length, 1)
  assert.equal(pendingStore.get('msg-1'), null, 'entry must be consumed after a successful pick')
})

test('handleRecommendChoice: does not restart playback if the queue was already non-empty', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: { id: 'msg-1' }, timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  session.queue.add(makeCandidate('already-playing')) // a manual /play landed while the pick was pending
  const sessions = new Map([['g1', session]])
  const interaction = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-1', userId: 'u1', voiceChannelId: 'vc-1' })

  await handleRecommendChoice(interaction, sessions, pendingStore)

  assert.equal(session.player.playNextCalls.length, 0, 'must not interrupt an already-playing manual track')
  assert.deepEqual(session.queue.upcoming().map((t) => t.videoId), ['v1'], 'picked track should be appended instead')
})

function makeSentMessage(id) {
  return { id, components: [{ components: [{ setDisabled() {} }] }], async edit() {} }
}

test('handleRecommendChoice: two users clicking different prompts in the same guild at once, only one wins', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage('msg-1'), timeoutHandle: null })
  pendingStore.set('msg-2', { guildId: 'g1', targetUserId: 'u2', candidates: [makeCandidate('v2')], message: makeSentMessage('msg-2'), timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])

  const interactionA = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-1', userId: 'u1', voiceChannelId: 'vc-1' })
  const interactionB = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-2', userId: 'u2', voiceChannelId: 'vc-1' })

  // Both handlers start "simultaneously" (neither has awaited anything yet
  // when the other starts), matching two near-simultaneous button clicks.
  await Promise.all([
    handleRecommendChoice(interactionA, sessions, pendingStore),
    handleRecommendChoice(interactionB, sessions, pendingStore),
  ])

  assert.equal(session.player.playNextCalls.length, 1, 'exactly one pick should win the round')
  const queued = [session.queue.current, ...session.queue.upcoming()].filter(Boolean)
  assert.equal(queued.length, 1, 'only the winning pick should be enqueued')
})
