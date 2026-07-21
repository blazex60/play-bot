import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GuildQueue, createTrack } from './queue.js'
import { PendingChoiceStore } from './views.js'
import { cancelRecommendations, handleRecommendChoice, hasPendingForGuild, postRecommendations, RECOMMEND_TIMEOUT_MS } from './recommendFlow.js'

function makeCandidate(videoId) {
  return createTrack({ title: videoId, webpageUrl: `https://example.com/${videoId}`, duration: 60, videoId })
}

function makeSentMessage(id) {
  return { id, components: [{ components: [{ setDisabled() {} }] }], editCalls: [], deleteCalls: 0, async edit(update) { this.editCalls.push(update) }, async delete() { this.deleteCalls += 1 } }
}

// Recommend prompts are DMs now, so posting them goes through
// client.users.fetch(userId).send(...) instead of a shared channel.
function makeClient({ sendFails = false } = {}) {
  const sent = []
  return {
    sent,
    users: {
      async fetch(userId) {
        return {
          id: userId,
          async send(payload) {
            if (sendFails) throw new Error('Cannot send messages to this user')
            const message = makeSentMessage(`msg-${sent.length}`)
            sent.push({ userId, payload, message })
            return message
          },
        }
      },
    },
  }
}

function makeSession({ voiceChannelId = 'vc-1' } = {}) {
  const queue = new GuildQueue()
  const playNextCalls = []
  return {
    connection: { joinConfig: { channelId: voiceChannelId } },
    queue,
    planToken: 0,
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
  const client = makeClient()
  const pendingStore = new PendingChoiceStore()
  const plans = [
    { userId: 'u1', candidates: [makeCandidate('v1')] },
    { userId: 'u2', candidates: [makeCandidate('v2')] },
  ]
  const count = await postRecommendations({ client, guildId: 'g1', plans, pendingStore })
  t.after(() => {
    for (const [, entry] of pendingStore.entries()) clearTimeout(entry.timeoutHandle)
  })
  assert.equal(count, 2)
  assert.equal(client.sent.length, 2)
})

test('postRecommendations: returns 0 when every DM fails, without throwing', async () => {
  const client = makeClient({ sendFails: true })
  const pendingStore = new PendingChoiceStore()
  const plans = [{ userId: 'u1', candidates: [makeCandidate('v1')] }]
  const count = await postRecommendations({ client, guildId: 'g1', plans, pendingStore })
  assert.equal(count, 0)
})

test('postRecommendations: skips plans with no candidates', async () => {
  const client = makeClient()
  const pendingStore = new PendingChoiceStore()
  const plans = [{ userId: 'u1', candidates: [] }]
  const count = await postRecommendations({ client, guildId: 'g1', plans, pendingStore })
  assert.equal(count, 0)
  assert.equal(client.sent.length, 0)
})

test('postRecommendations: skips a user who already has a live pending prompt for this guild', async (t) => {
  const client = makeClient()
  const pendingStore = new PendingChoiceStore()
  // Simulates a fast repeat round: u1's earlier prompt is still unanswered
  // when a fresh round fires for the same guild.
  pendingStore.set('existing-msg', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('old')], message: makeSentMessage('existing-msg'), timeoutHandle: null })
  const plans = [
    { userId: 'u1', candidates: [makeCandidate('v1')] },
    { userId: 'u2', candidates: [makeCandidate('v2')] },
  ]
  const count = await postRecommendations({ client, guildId: 'g1', plans, pendingStore })
  t.after(() => {
    for (const [, entry] of pendingStore.entries()) clearTimeout(entry.timeoutHandle)
  })
  assert.equal(count, 1, 'only u2, who had no live prompt, should get a new DM')
  assert.deepEqual(client.sent.map((s) => s.userId), ['u2'])
})

test('postRecommendations: returns 0 while a live prompt still exists for the guild (the sole plan was a dedup skip, not a total failure)', async (t) => {
  // sessions.js's handleQueueExhausted relies on this distinction: a
  // postedCount of 0 here must not be treated the same as "nobody could be
  // reached at all" — hasPendingForGuild(pendingStore, guildId) tells it an
  // earlier round's DM is still answerable, so it should keep the session
  // alive instead of disconnecting and cancelling that still-valid prompt.
  const client = makeClient()
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('existing-msg', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('old')], message: makeSentMessage('existing-msg'), timeoutHandle: null })
  const plans = [{ userId: 'u1', candidates: [makeCandidate('v1')] }]
  const count = await postRecommendations({ client, guildId: 'g1', plans, pendingStore })
  t.after(() => {
    for (const [, entry] of pendingStore.entries()) clearTimeout(entry.timeoutHandle)
  })
  assert.equal(count, 0)
  assert.equal(hasPendingForGuild(pendingStore, 'g1'), true, "u1's earlier prompt is still live and answerable")
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

test('handleRecommendChoice: rejects and preserves the entry if the target user left the VC', async (t) => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: { id: 'msg-1' }, timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])
  const interaction = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-1', userId: 'u1', voiceChannelId: 'vc-2', interactionChannelId: 'vc-1' })

  await handleRecommendChoice(interaction, sessions, pendingStore)
  t.after(() => clearTimeout(pendingStore.get('msg-1')?.timeoutHandle))

  assert.equal(session.player.playNextCalls.length, 0, 'must not start playback for a user no longer in the VC')
  assert.ok(pendingStore.get('msg-1'), 'entry must survive a failed VC check so a legitimate retry still works')
  assert.ok(pendingStore.get('msg-1').timeoutHandle, 'the restored entry must have a fresh, live timeout, not a spent one')
})

test('handleRecommendChoice: honors a real DM pick (interaction.member absent, resolved via guild.members.fetch)', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage('msg-1'), timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  session.connection.joinConfig.guildId = 'g1'
  const sessions = new Map([['g1', session]])

  // A real DM-originated click carries no interaction.member at all (DMs
  // have no guild context), so checkInVoiceChannel must fall back to
  // fetching the member from the guild to confirm they're still in the VC.
  const member = { voice: { channelId: 'vc-1' } }
  const client = {
    guilds: {
      cache: new Map([['g1', { members: { async fetch() { return member } } }]]),
    },
  }
  const replies = []
  const interaction = {
    customId: 'autoplay_0',
    message: { id: 'msg-1' },
    user: { id: 'u1' },
    member: null,
    client,
    deferred: false,
    replied: false,
    replies,
    async reply(payload) { replies.push(payload); this.replied = true },
    async followUp(payload) { replies.push(payload) },
    async deferUpdate() { this.deferred = true },
  }

  await handleRecommendChoice(interaction, sessions, pendingStore)

  assert.equal(session.queue.current.videoId, 'v1', 'the pick must succeed via the fetched-member fallback')
  assert.equal(session.player.playNextCalls.length, 1)
})

test('handleRecommendChoice: does not resurrect a prompt if /stop bumps planToken while the membership check is in flight and it then fails', async (t) => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage('msg-1'), timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  session.connection.joinConfig.guildId = 'g1'
  const sessions = new Map([['g1', session]])

  // The membership fetch resolves the user as no longer in the VC (they
  // left), but not before /stop bumps the session's planToken while the
  // fetch is still in flight — simulating cancelRecommendations having
  // already swept pendingStore (this entry just wasn't in it yet, since it
  // was already claimed).
  const client = {
    guilds: {
      cache: new Map([['g1', {
        members: {
          async fetch() {
            session.planToken += 1
            return { voice: { channelId: 'vc-2' } } // left the bot's VC
          },
        },
      }]]),
    },
  }
  const interaction = {
    customId: 'autoplay_0',
    message: { id: 'msg-1' },
    user: { id: 'u1' },
    member: null,
    client,
    deferred: false,
    replied: false,
    replies: [],
    async reply(payload) { this.replies.push(payload); this.replied = true },
    async followUp(payload) { this.replies.push(payload) },
    async deferUpdate() { this.deferred = true },
  }

  await handleRecommendChoice(interaction, sessions, pendingStore)
  t.after(() => clearTimeout(pendingStore.get('msg-1')?.timeoutHandle))

  assert.equal(pendingStore.get('msg-1'), null, 'a prompt must not be resurrected for a session /stop already reset')
  assert.equal(session.queue.isEmpty, true)
})

test('handleRecommendChoice: valid pick on an empty queue starts playback', async () => {
  const pendingStore = new PendingChoiceStore()
  const message = makeSentMessage('msg-1')
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message, timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])
  const interaction = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-1', userId: 'u1', voiceChannelId: 'vc-1' })

  await handleRecommendChoice(interaction, sessions, pendingStore)

  assert.equal(session.queue.current.videoId, 'v1')
  assert.equal(session.player.playNextCalls.length, 1)
  assert.equal(pendingStore.get('msg-1'), null, 'entry must be consumed after a successful pick')
  assert.equal(message.deleteCalls, 1, 'the picked message should be deleted, matching /play search behavior')
  assert.match(interaction.replies[0], /^✅ .+ がキューに追加しました: \*\*v1\*\* \(/, 'a /play-style confirmation should be posted')
})

test('handleRecommendChoice: does not restart playback if the queue was already non-empty', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage('msg-1'), timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  session.queue.add(makeCandidate('already-playing')) // a manual /play landed while the pick was pending
  const sessions = new Map([['g1', session]])
  const interaction = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-1', userId: 'u1', voiceChannelId: 'vc-1' })

  await handleRecommendChoice(interaction, sessions, pendingStore)

  assert.equal(session.player.playNextCalls.length, 0, 'must not interrupt an already-playing manual track')
  assert.deepEqual(session.queue.upcoming().map((t) => t.videoId), ['v1'], 'picked track should be appended instead')
})

test('handleRecommendChoice: two users clicking their own prompts at once, both succeed independently', async () => {
  const pendingStore = new PendingChoiceStore()
  const messageA = makeSentMessage('msg-1')
  const messageB = makeSentMessage('msg-2')
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: messageA, timeoutHandle: null })
  pendingStore.set('msg-2', { guildId: 'g1', targetUserId: 'u2', candidates: [makeCandidate('v2')], message: messageB, timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])

  const interactionA = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-1', userId: 'u1', voiceChannelId: 'vc-1' })
  const interactionB = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-2', userId: 'u2', voiceChannelId: 'vc-1' })

  // Both handlers start "simultaneously" (neither has awaited anything yet
  // when the other starts), matching two near-simultaneous button clicks on
  // two different users' own prompts.
  await Promise.all([
    handleRecommendChoice(interactionA, sessions, pendingStore),
    handleRecommendChoice(interactionB, sessions, pendingStore),
  ])

  assert.equal(session.player.playNextCalls.length, 1, 'only the first pick (empty queue) should start playback')
  const queued = [session.queue.current, ...session.queue.upcoming()].filter(Boolean)
  assert.deepEqual(queued.map((t) => t.videoId).sort(), ['v1', 'v2'], 'both picks should be enqueued since neither cancels the other')
  assert.equal(messageA.deleteCalls, 1, "u1's own prompt should be consumed by their pick")
  assert.equal(messageB.deleteCalls, 1, "u2's own prompt should be consumed by their pick")
  assert.equal(pendingStore.get('msg-1'), null)
  assert.equal(pendingStore.get('msg-2'), null)
})

test('handleRecommendChoice: two rapid clicks on the same DM prompt must not double-enqueue (regression: async VC check raced the entry claim)', async () => {
  const pendingStore = new PendingChoiceStore()
  const message = makeSentMessage('msg-1')
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message, timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  session.connection.joinConfig.guildId = 'g1'
  const sessions = new Map([['g1', session]])

  // Prompts are DMs now, so a real click carries no interaction.member —
  // checkInVoiceChannel has to await a guild.members.fetch instead. Simulate
  // that round-trip taking long enough for a second, near-simultaneous click
  // to start running before the first one has claimed the entry.
  const member = { voice: { channelId: 'vc-1' } }
  const client = {
    guilds: {
      cache: new Map([['g1', {
        members: {
          async fetch() {
            await new Promise((resolve) => setImmediate(resolve))
            return member
          },
        },
      }]]),
    },
  }

  function makeDmInteraction() {
    const replies = []
    return {
      customId: 'autoplay_0',
      message: { id: 'msg-1' },
      user: { id: 'u1' },
      member: null,
      client,
      deferred: false,
      replied: false,
      replies,
      async reply(payload) { replies.push(payload); this.replied = true },
      async followUp(payload) { replies.push(payload) },
      async deferUpdate() { this.deferred = true },
    }
  }

  await Promise.all([
    handleRecommendChoice(makeDmInteraction(), sessions, pendingStore),
    handleRecommendChoice(makeDmInteraction(), sessions, pendingStore),
  ])

  const queued = [session.queue.current, ...session.queue.upcoming()].filter(Boolean)
  assert.equal(queued.length, 1, 'the track must be enqueued exactly once even though both clicks raced past the async VC check')
  assert.equal(session.player.playNextCalls.length, 1)
})

test('handleRecommendChoice: acknowledges the interaction before the membership fetch (regression: a slow REST lookup could expire the interaction token)', async () => {
  const pendingStore = new PendingChoiceStore()
  const message = makeSentMessage('msg-1')
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message, timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  session.connection.joinConfig.guildId = 'g1'
  const sessions = new Map([['g1', session]])

  const callOrder = []
  const member = { voice: { channelId: 'vc-1' } }
  const client = {
    guilds: {
      cache: new Map([['g1', {
        members: {
          async fetch() {
            callOrder.push('members.fetch')
            await new Promise((resolve) => setImmediate(resolve))
            return member
          },
        },
      }]]),
    },
  }
  const interaction = {
    customId: 'autoplay_0',
    message: { id: 'msg-1' },
    user: { id: 'u1' },
    member: null,
    client,
    deferred: false,
    replied: false,
    replies: [],
    async reply(payload) { this.replies.push(payload); this.replied = true },
    async followUp(payload) { this.replies.push(payload) },
    async deferUpdate() { callOrder.push('deferUpdate'); this.deferred = true },
  }

  await handleRecommendChoice(interaction, sessions, pendingStore)

  assert.deepEqual(callOrder, ['deferUpdate', 'members.fetch'], 'the interaction must be acknowledged before the REST membership lookup starts, not after')
  assert.equal(session.queue.current.videoId, 'v1')
})

test("postRecommendations: a still-pending prompt's timeout must not tear the session down while another user's pick is in flight", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const client = makeClient()
  const pendingStore = new PendingChoiceStore()
  const plans = [
    { userId: 'u1', candidates: [makeCandidate('v1')] },
    { userId: 'u2', candidates: [makeCandidate('v2')] },
  ]
  let onTimeoutCalls = 0
  await postRecommendations({
    client, guildId: 'g1', plans, pendingStore,
    onTimeout: async () => { onTimeoutCalls += 1 },
  })
  // makeClient names messages msg-0, msg-1 in send order, matching plans order.
  assert.ok(pendingStore.get('msg-0'), "u1's prompt should be pending")
  assert.ok(pendingStore.get('msg-1'), "u2's prompt should be pending")

  // u1 starts picking their own prompt but the handler is paused mid-flight
  // (deferUpdate never resolves), simulating a pick that's claimed its entry
  // but hasn't enqueued a track yet.
  let releaseDeferUpdate
  const deferGate = new Promise((resolve) => { releaseDeferUpdate = resolve })
  const interactionA = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-0', userId: 'u1', voiceChannelId: 'vc-1' })
  interactionA.deferUpdate = async () => { await deferGate }
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])
  const pickPromise = handleRecommendChoice(interactionA, sessions, pendingStore)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pendingStore.get('msg-0'), null, "u1's own entry should already be claimed")

  // u2's prompt now times out. Since pendingStore has nothing left for g1
  // and u1's pick is still in flight, onTimeout must not fire.
  t.mock.timers.tick(RECOMMEND_TIMEOUT_MS)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(onTimeoutCalls, 0, 'onTimeout must not fire while a pick for this guild is still in flight')

  releaseDeferUpdate()
  await pickPromise
  assert.equal(session.queue.current.videoId, 'v1', "u1's pick should still succeed once unblocked")
})

test('handleRecommendChoice: does not enqueue or start playback if /leave removes the session while the pick is in flight', async () => {
  const pendingStore = new PendingChoiceStore()
  const message = makeSentMessage('msg-1')
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message, timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])

  let releaseDeferUpdate
  const deferGate = new Promise((resolve) => { releaseDeferUpdate = resolve })
  const interaction = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-1', userId: 'u1', voiceChannelId: 'vc-1' })
  interaction.deferUpdate = async () => { await deferGate }
  const pickPromise = handleRecommendChoice(interaction, sessions, pendingStore)
  await new Promise((resolve) => setImmediate(resolve))

  // /leave lands while the pick is still awaiting deferUpdate.
  sessions.delete('g1')
  session.connection.destroy = () => {}

  releaseDeferUpdate()
  await pickPromise

  assert.equal(session.queue.isEmpty, true, 'must not enqueue onto a session that /leave already tore down')
  assert.equal(session.player.playNextCalls.length, 0)
  assert.equal(interaction.replies.at(-1)?.content, '❌ セッションが終了しています')
})

test('handleRecommendChoice: does not enqueue or start playback if /stop bumps planToken while the pick is in flight', async () => {
  const pendingStore = new PendingChoiceStore()
  const message = makeSentMessage('msg-1')
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message, timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])

  let releaseDeferUpdate
  const deferGate = new Promise((resolve) => { releaseDeferUpdate = resolve })
  const interaction = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-1', userId: 'u1', voiceChannelId: 'vc-1' })
  interaction.deferUpdate = async () => { await deferGate }
  const pickPromise = handleRecommendChoice(interaction, sessions, pendingStore)
  await new Promise((resolve) => setImmediate(resolve))

  // /stop lands while the pick is still awaiting deferUpdate: same session
  // object and guild map entry, but its planToken is bumped and the queue
  // it manages has already been cleared.
  session.planToken += 1

  releaseDeferUpdate()
  await pickPromise

  assert.equal(session.queue.isEmpty, true, 'must not enqueue onto a session /stop already reset')
  assert.equal(session.player.playNextCalls.length, 0)
  assert.equal(interaction.replies.at(-1)?.content, '❌ セッションが終了しています')
})

test('handleRecommendChoice: retriggers the teardown check if an in-flight pick fails after its guild ran out of pending prompts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const client = makeClient()
  const pendingStore = new PendingChoiceStore()
  const plans = [
    { userId: 'u1', candidates: [makeCandidate('v1')] },
    { userId: 'u2', candidates: [makeCandidate('v2')] },
  ]
  let onTimeoutCalls = 0
  await postRecommendations({
    client, guildId: 'g1', plans, pendingStore,
    onTimeout: async () => { onTimeoutCalls += 1 },
  })

  // u1 starts picking their own prompt but it's paused mid-flight, same as
  // the previous test — except this time the pick will fail instead of
  // succeeding once unblocked (e.g. a Discord REST error from deferUpdate).
  const deferError = new Error('Discord REST failure')
  let rejectDeferUpdate
  const deferGate = new Promise((_resolve, reject) => { rejectDeferUpdate = reject })
  const interactionA = makeInteraction({ customId: 'autoplay_0', messageId: 'msg-0', userId: 'u1', voiceChannelId: 'vc-1' })
  interactionA.deferUpdate = async () => { await deferGate }
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])
  const pickPromise = handleRecommendChoice(interactionA, sessions, pendingStore)
  await new Promise((resolve) => setImmediate(resolve))

  // u2's prompt times out while u1's pick is in flight — must not tear down yet.
  t.mock.timers.tick(RECOMMEND_TIMEOUT_MS)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(onTimeoutCalls, 0)

  // The in-flight pick now fails before ever reaching queue.add. Nothing is
  // pending and nothing is in flight anymore for g1, so this must retrigger
  // the same teardown check the expired prompt's own timeout deferred.
  rejectDeferUpdate(deferError)
  await assert.rejects(pickPromise, deferError)
  assert.equal(onTimeoutCalls, 1, 'a failed in-flight pick must still retrigger the deferred teardown check')
  assert.equal(session.queue.isEmpty, true, 'nothing should have been enqueued by the failed pick')
})

test('postRecommendations: disables and drops a message whose send resolves after the guild was torn down mid-loop', async () => {
  const pendingStore = new PendingChoiceStore()
  let resolveSecondSend
  const secondSendGate = new Promise((resolve) => { resolveSecondSend = resolve })
  let sendCount = 0
  const client = {
    users: {
      async fetch(userId) {
        return {
          id: userId,
          async send() {
            sendCount += 1
            if (sendCount === 1) return makeSentMessage('msg-1')
            await secondSendGate
            return makeSentMessage('msg-2')
          },
        }
      },
    },
  }
  const plans = [
    { userId: 'u1', candidates: [makeCandidate('v1')] },
    { userId: 'u2', candidates: [makeCandidate('v2')] },
  ]

  const postPromise = postRecommendations({ client, guildId: 'g1', plans, pendingStore })

  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(pendingStore.get('msg-1'), 'first message should already be stored while the second send is still pending')

  // Simulate the session being torn down (e.g. /stop) while the second send
  // is still in flight — unlike a per-user pick, this must sweep everything
  // and be noticed by the send that's still pending.
  cancelRecommendations('g1', pendingStore)
  resolveSecondSend()

  const postedCount = await postPromise
  assert.equal(postedCount, 1, 'the late-arriving message must not count as posted')
  assert.equal(pendingStore.get('msg-2'), null, 'the late message must not be left as a live, pickable entry')
})

test('postRecommendations: skips a plan for a user no longer in the voice channel by send time', async (t) => {
  const client = makeClient()
  const pendingStore = new PendingChoiceStore()
  const voiceChannel = { members: new Map([['u1', {}]]) } // u2 already left the VC
  const plans = [
    { userId: 'u1', candidates: [makeCandidate('v1')] },
    { userId: 'u2', candidates: [makeCandidate('v2')] },
  ]
  const count = await postRecommendations({ client, guildId: 'g1', plans, pendingStore, voiceChannel })
  t.after(() => {
    for (const [, entry] of pendingStore.entries()) clearTimeout(entry.timeoutHandle)
  })
  assert.equal(count, 1, 'only the still-present user should get a prompt')
  assert.equal(client.sent.length, 1)
  assert.equal(client.sent[0].userId, 'u1')
})
