import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MessageFlags } from 'discord.js'
import { GuildQueue, createTrack } from './queue.js'
import { PendingChoiceStore } from './views.js'
import {
  cancelRecommendations,
  handleRecommendChoice,
  handleShowRecommendations,
  hasPendingForGuild,
  postRecommendationPrompt,
  RECOMMEND_TIMEOUT_MS,
} from './recommendFlow.js'
import { configureSettingsPathForTest, setDefaultCommandPermission } from './settings.js'

async function withTempSettings(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'music-bot-recommend-test-'))
  configureSettingsPathForTest(join(dir, 'data', 'guild-settings.json'))
  try {
    await fn()
  } finally {
    await rm(dir, { recursive: true, force: true })
    // settings.js's guildSettings Map is module-level state shared by every
    // test in this file; most of the other tests here use guildId 'g1'
    // directly with no settings.js involvement at all and expect the
    // default 'allow' permission, so this must reset the in-memory Map
    // (not just delete the now-unused temp dir) or a 'g1' override set
    // above would leak into whichever test happens to run next.
    configureSettingsPathForTest(join(dir, 'data', 'guild-settings-unused.json'))
  }
}

function makeCandidate(videoId) {
  return createTrack({ title: videoId, webpageUrl: `https://example.com/${videoId}`, duration: 60, videoId })
}

let nextMessageId = 0
function makeSentMessage() {
  const id = `msg-${nextMessageId++}`
  // Shape matches what ActionRowBuilder.from() (used by disableMessage)
  // expects from real API component data, so it reconstructs real
  // ButtonBuilders (with a working setDisabled) instead of throwing.
  return {
    id,
    components: [{ type: 1, components: [{ type: 2, style: 1, label: 'x', custom_id: 'y' }] }],
    editCalls: [],
    async edit(update) { this.editCalls.push(update) },
  }
}

// The shared "おすすめを表示" prompt is now posted to the VC's linked text
// channel instead of DMed to each user.
function makeChannel({ sendFails = false } = {}) {
  const sent = []
  return {
    sent,
    async send(payload) {
      if (sendFails) throw new Error('missing permissions')
      const message = makeSentMessage()
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
    planToken: 0,
    player: {
      async playNext() { playNextCalls.push(true) },
      playNextCalls,
    },
  }
}

// The click on the shared "おすすめを表示" button — a plain guild-context
// button interaction, unlike the old DM-originated prompts.
function makeShowInteraction({ guildId, userId, member }) {
  const replies = []
  let replyMessage = null
  return {
    guildId,
    user: { id: userId },
    member: member ?? { roles: { cache: { has: () => false } } },
    deferred: false,
    replied: false,
    replies,
    async reply(payload) {
      replies.push(payload)
      this.replied = true
      replyMessage = makeSentMessage()
    },
    async fetchReply() { return replyMessage },
  }
}

// The click on a track-choice button living inside the ephemeral message
// handleShowRecommendations posted.
function makePickInteraction({ customId, messageId, guildId, userId, member }) {
  const replies = []
  return {
    customId,
    message: { id: messageId },
    guildId,
    user: { id: userId },
    member: member ?? { roles: { cache: { has: () => false } } },
    deferred: false,
    replied: false,
    replies,
    async reply(payload) { replies.push(payload); this.replied = true },
    async followUp(payload) { replies.push(payload) },
    async deferUpdate() { this.deferred = true },
    async deleteReply() { this.deletedReply = true },
  }
}

test('postRecommendationPrompt: posts a single shared prompt and returns 1', async (t) => {
  const channel = makeChannel()
  const recommendRounds = new Map()
  const pendingStore = new PendingChoiceStore()
  const plans = [
    { userId: 'u1', candidates: [makeCandidate('v1')] },
    { userId: 'u2', candidates: [makeCandidate('v2')] },
  ]
  const count = await postRecommendationPrompt({ channel, guildId: 'g1', guildName: 'Guild', plans, recommendRounds, pendingStore })
  t.after(() => clearTimeout(recommendRounds.get('g1')?.timeoutHandle))

  assert.equal(count, 1)
  assert.equal(channel.sent.length, 1, 'only one shared message should be posted, not one per user')
  const round = recommendRounds.get('g1')
  assert.ok(round, 'a round entry should be registered for the guild')
  assert.deepEqual([...round.candidatesByUserId.keys()].sort(), ['u1', 'u2'])
})

test('postRecommendationPrompt: returns 0 when every plan has no candidates', async () => {
  const channel = makeChannel()
  const recommendRounds = new Map()
  const pendingStore = new PendingChoiceStore()
  const plans = [{ userId: 'u1', candidates: [] }]
  const count = await postRecommendationPrompt({ channel, guildId: 'g1', plans, recommendRounds, pendingStore })
  assert.equal(count, 0)
  assert.equal(channel.sent.length, 0)
  assert.equal(recommendRounds.has('g1'), false)
})

test('postRecommendationPrompt: returns 0 without throwing when the send fails', async () => {
  const channel = makeChannel({ sendFails: true })
  const recommendRounds = new Map()
  const pendingStore = new PendingChoiceStore()
  const plans = [{ userId: 'u1', candidates: [makeCandidate('v1')] }]
  const count = await postRecommendationPrompt({ channel, guildId: 'g1', plans, recommendRounds, pendingStore })
  assert.equal(count, 0)
  assert.equal(recommendRounds.has('g1'), false)
})

test('postRecommendationPrompt: disables and drops a message posted after the guild was torn down mid-send', async () => {
  const recommendRounds = new Map()
  const pendingStore = new PendingChoiceStore()
  let resolveSend
  const sendGate = new Promise((resolve) => { resolveSend = resolve })
  const channel = {
    sent: [],
    async send(payload) {
      await sendGate
      const message = makeSentMessage()
      this.sent.push({ payload, message })
      return message
    },
  }
  const plans = [{ userId: 'u1', candidates: [makeCandidate('v1')] }]

  const postPromise = postRecommendationPrompt({ channel, guildId: 'g1', plans, recommendRounds, pendingStore })
  // Simulate /stop landing (e.g. via cancelPendingRecommendations) while the
  // send is still in flight.
  cancelRecommendations('g1', pendingStore, recommendRounds)
  resolveSend()

  const count = await postPromise
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(count, 0, 'a message that lands after cancellation must not count as posted')
  assert.equal(recommendRounds.has('g1'), false)
  assert.equal(channel.sent[0].message.editCalls.length, 1, 'the late message should be disabled instead of left live')
})

test('handleShowRecommendations: rejects a click once the round has expired', async () => {
  const recommendRounds = new Map()
  const pendingStore = new PendingChoiceStore()
  const sessions = new Map([['g1', makeSession()]])
  const interaction = makeShowInteraction({ guildId: 'g1', userId: 'u1' })

  await handleShowRecommendations(interaction, sessions, recommendRounds, pendingStore)

  assert.equal(interaction.replies[0].content, '❌ この提案は期限切れです')
})

test('handleShowRecommendations: rejects a click if the session no longer exists', async () => {
  const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map([['u1', [makeCandidate('v1')]]]), message: makeSentMessage(), timeoutHandle: null, expired: false }]])
  const pendingStore = new PendingChoiceStore()
  const sessions = new Map()
  const interaction = makeShowInteraction({ guildId: 'g1', userId: 'u1' })

  await handleShowRecommendations(interaction, sessions, recommendRounds, pendingStore)

  assert.equal(interaction.replies[0].content, '❌ セッションが終了しています')
})

test('handleShowRecommendations: a user denied the play command cannot see their recommendations', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('g1', 'play', 'deny')
    const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map([['u1', [makeCandidate('v1')]]]), message: makeSentMessage(), timeoutHandle: null, expired: false }]])
    const pendingStore = new PendingChoiceStore()
    const sessions = new Map([['g1', makeSession()]])
    const interaction = makeShowInteraction({ guildId: 'g1', userId: 'u1' })

    await handleShowRecommendations(interaction, sessions, recommendRounds, pendingStore)

    assert.equal(pendingStore.entries().next().done, true, 'no ephemeral pick prompt should be created for a denied user')
  })
})

test('handleShowRecommendations: an admin who denied themselves play can still see their recommendations', async () => {
  await withTempSettings(async () => {
    process.env.ADMIN_ROLE_ID = 'admin-role'
    try {
      await setDefaultCommandPermission('g1', 'play', 'deny')
      const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map([['u1', [makeCandidate('v1')]]]), message: makeSentMessage(), timeoutHandle: null, expired: false }]])
      const pendingStore = new PendingChoiceStore()
      const sessions = new Map([['g1', makeSession()]])
      const interaction = makeShowInteraction({ guildId: 'g1', userId: 'u1', member: { roles: { cache: { has: (id) => id === 'admin-role' } } } })

      await handleShowRecommendations(interaction, sessions, recommendRounds, pendingStore)

      assert.equal(interaction.replied, true, 'the admin-role bypass must still apply to viewing recommendations')
      assert.equal(pendingStore.entries().next().done, false)
    } finally {
      delete process.env.ADMIN_ROLE_ID
    }
  })
})

test('handleShowRecommendations: a user not present in the round snapshot gets no recommendations', async () => {
  const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map([['u1', [makeCandidate('v1')]]]), message: makeSentMessage(), timeoutHandle: null, expired: false }]])
  const pendingStore = new PendingChoiceStore()
  const sessions = new Map([['g1', makeSession()]])
  const interaction = makeShowInteraction({ guildId: 'g1', userId: 'someone-who-joined-late' })

  await handleShowRecommendations(interaction, sessions, recommendRounds, pendingStore)

  assert.equal(interaction.replies[0].content, '❌ 現在あなた向けのおすすめはありません')
})

test('handleShowRecommendations: a second click while the first ephemeral prompt is still unanswered is rejected', async (t) => {
  const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map([['u1', [makeCandidate('v1')]]]), message: makeSentMessage(), timeoutHandle: null, expired: false }]])
  const pendingStore = new PendingChoiceStore()
  const sessions = new Map([['g1', makeSession()]])

  const first = makeShowInteraction({ guildId: 'g1', userId: 'u1' })
  await handleShowRecommendations(first, sessions, recommendRounds, pendingStore)
  t.after(() => {
    for (const [, entry] of pendingStore.entries()) clearTimeout(entry.timeoutHandle)
  })

  const second = makeShowInteraction({ guildId: 'g1', userId: 'u1' })
  await handleShowRecommendations(second, sessions, recommendRounds, pendingStore)

  assert.equal(second.replies[0].content, '⚠️ 既におすすめを表示済みです。そちらから選択してください')
})

test('handleShowRecommendations: shows an ephemeral, personal choice prompt and registers it in pendingStore', async (t) => {
  const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map([['u1', [makeCandidate('v1')]]]), message: makeSentMessage(), timeoutHandle: null, expired: false }]])
  const pendingStore = new PendingChoiceStore()
  const sessions = new Map([['g1', makeSession()]])
  const interaction = makeShowInteraction({ guildId: 'g1', userId: 'u1' })

  await handleShowRecommendations(interaction, sessions, recommendRounds, pendingStore)
  t.after(() => {
    for (const [, entry] of pendingStore.entries()) clearTimeout(entry.timeoutHandle)
  })

  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral, 'the recommendation choice prompt must be ephemeral')
  assert.ok(interaction.replies[0].embeds, 'should reply with an embed')
  assert.ok(interaction.replies[0].components, 'should reply with choice buttons')
  const entries = [...pendingStore.entries()]
  assert.equal(entries.length, 1)
  assert.equal(entries[0][1].targetUserId, 'u1')
})

test('handleRecommendChoice: rejects a click from someone other than the target user', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: { id: 'msg-1' }, timeoutHandle: null })
  const sessions = new Map([['g1', makeSession()]])
  const interaction = makePickInteraction({ customId: 'autoplay_0', messageId: 'msg-1', guildId: 'g1', userId: 'someone-else' })

  await handleRecommendChoice(interaction, sessions, pendingStore)

  assert.equal(interaction.replies[0].content, '❌ これはあなた宛のおすすめではありません')
  assert.ok(pendingStore.get('msg-1'), 'entry must remain so the actual target user can still pick')
})

test('handleRecommendChoice: a user denied the play command cannot enqueue a recommendation pick', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('g1', 'play', 'deny')
    const pendingStore = new PendingChoiceStore()
    pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage(), timeoutHandle: null, expired: false })
    const session = makeSession({ voiceChannelId: 'vc-1' })
    const sessions = new Map([['g1', session]])
    const interaction = makePickInteraction({ customId: 'autoplay_0', messageId: 'msg-1', guildId: 'g1', userId: 'u1' })

    await handleRecommendChoice(interaction, sessions, pendingStore)

    assert.equal(session.queue.isEmpty, true, 'must not enqueue a pick for a user denied the play command')
    assert.equal(session.player.playNextCalls.length, 0)
    assert.ok(pendingStore.get('msg-1'), 'entry must survive a permission denial so a legitimate retry still works after being un-denied')
  })
})

test('handleRecommendChoice: an admin who denied themselves play can still pick their own recommendation', async () => {
  await withTempSettings(async () => {
    process.env.ADMIN_ROLE_ID = 'admin-role'
    try {
      await setDefaultCommandPermission('g1', 'play', 'deny')
      const pendingStore = new PendingChoiceStore()
      pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage(), timeoutHandle: null, expired: false })
      const session = makeSession({ voiceChannelId: 'vc-1' })
      const sessions = new Map([['g1', session]])
      const interaction = makePickInteraction({
        customId: 'autoplay_0', messageId: 'msg-1', guildId: 'g1', userId: 'u1',
        member: { roles: { cache: { has: (id) => id === 'admin-role' } } },
      })

      await handleRecommendChoice(interaction, sessions, pendingStore)

      assert.equal(session.queue.current?.videoId, 'v1', 'the admin-role bypass must still apply to recommendation picks')
      assert.equal(session.player.playNextCalls.length, 1)
    } finally {
      delete process.env.ADMIN_ROLE_ID
    }
  })
})

test('handleRecommendChoice: valid pick deletes the ephemeral prompt, posts a public confirmation, and starts playback', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage(), timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])
  const interaction = makePickInteraction({ customId: 'autoplay_0', messageId: 'msg-1', guildId: 'g1', userId: 'u1' })

  await handleRecommendChoice(interaction, sessions, pendingStore)

  assert.equal(session.queue.current.videoId, 'v1')
  assert.equal(session.player.playNextCalls.length, 1)
  assert.equal(pendingStore.get('msg-1'), null, 'entry must be consumed after a successful pick')
  assert.equal(interaction.deletedReply, true, 'the ephemeral recommendation prompt should disappear once answered')
  assert.match(interaction.replies[0], /^✅ .+ がキューに追加しました: \*\*v1\*\* \(/, 'a /play-style public confirmation should be posted')
})

test('handleRecommendChoice: does not restart playback if the queue was already non-empty', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage(), timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  session.queue.add(makeCandidate('already-playing')) // a manual /play landed while the pick was pending
  const sessions = new Map([['g1', session]])
  const interaction = makePickInteraction({ customId: 'autoplay_0', messageId: 'msg-1', guildId: 'g1', userId: 'u1' })

  await handleRecommendChoice(interaction, sessions, pendingStore)

  assert.equal(session.player.playNextCalls.length, 0, 'must not interrupt an already-playing manual track')
  assert.deepEqual(session.queue.upcoming().map((t) => t.videoId), ['v1'], 'picked track should be appended instead')
})

test('handleRecommendChoice: two users clicking their own prompts at once, both succeed independently', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage(), timeoutHandle: null })
  pendingStore.set('msg-2', { guildId: 'g1', targetUserId: 'u2', candidates: [makeCandidate('v2')], message: makeSentMessage(), timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])

  const interactionA = makePickInteraction({ customId: 'autoplay_0', messageId: 'msg-1', guildId: 'g1', userId: 'u1' })
  const interactionB = makePickInteraction({ customId: 'autoplay_0', messageId: 'msg-2', guildId: 'g1', userId: 'u2' })

  await Promise.all([
    handleRecommendChoice(interactionA, sessions, pendingStore),
    handleRecommendChoice(interactionB, sessions, pendingStore),
  ])

  assert.equal(session.player.playNextCalls.length, 1, 'only the first pick (empty queue) should start playback')
  const queued = [session.queue.current, ...session.queue.upcoming()].filter(Boolean)
  assert.deepEqual(queued.map((t) => t.videoId).sort(), ['v1', 'v2'], 'both picks should be enqueued since neither cancels the other')
  assert.equal(pendingStore.get('msg-1'), null)
  assert.equal(pendingStore.get('msg-2'), null)
})

test('handleRecommendChoice: two rapid clicks on the same prompt must not double-enqueue', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage(), timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])

  await Promise.all([
    handleRecommendChoice(makePickInteraction({ customId: 'autoplay_0', messageId: 'msg-1', guildId: 'g1', userId: 'u1' }), sessions, pendingStore),
    handleRecommendChoice(makePickInteraction({ customId: 'autoplay_0', messageId: 'msg-1', guildId: 'g1', userId: 'u1' }), sessions, pendingStore),
  ])

  const queued = [session.queue.current, ...session.queue.upcoming()].filter(Boolean)
  assert.equal(queued.length, 1, 'the track must be enqueued exactly once even though both clicks raced past the entry claim')
  assert.equal(session.player.playNextCalls.length, 1)
})

test('handleRecommendChoice: rejects if the session no longer exists', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage(), timeoutHandle: null })
  const sessions = new Map()
  const interaction = makePickInteraction({ customId: 'autoplay_0', messageId: 'msg-1', guildId: 'g1', userId: 'u1' })

  await handleRecommendChoice(interaction, sessions, pendingStore)

  assert.equal(interaction.replies[0].content, '❌ セッションが終了しています')
})

test('handleRecommendChoice: does not enqueue or start playback if /leave removes the session while the pick is in flight', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage(), timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])

  let releaseDeferUpdate
  const deferGate = new Promise((resolve) => { releaseDeferUpdate = resolve })
  const interaction = makePickInteraction({ customId: 'autoplay_0', messageId: 'msg-1', guildId: 'g1', userId: 'u1' })
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
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage(), timeoutHandle: null })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])

  let releaseDeferUpdate
  const deferGate = new Promise((resolve) => { releaseDeferUpdate = resolve })
  const interaction = makePickInteraction({ customId: 'autoplay_0', messageId: 'msg-1', guildId: 'g1', userId: 'u1' })
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
  const pendingStore = new PendingChoiceStore()
  const recommendRounds = new Map()
  const channel = makeChannel()
  const plans = [
    { userId: 'u1', candidates: [makeCandidate('v1')] },
    { userId: 'u2', candidates: [makeCandidate('v2')] },
  ]
  let onTimeoutCalls = 0
  await postRecommendationPrompt({
    channel, guildId: 'g1', plans, recommendRounds, pendingStore,
    onTimeout: async () => { onTimeoutCalls += 1 },
  })
  t.after(() => clearTimeout(recommendRounds.get('g1')?.timeoutHandle))

  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])

  // u1 shows their recommendations, creating a per-user ephemeral pending
  // entry that this test will then pick, pausing mid-flight.
  const showInteraction = makeShowInteraction({ guildId: 'g1', userId: 'u1' })
  await handleShowRecommendations(showInteraction, sessions, recommendRounds, pendingStore)
  const [messageId] = [...pendingStore.entries()].map(([id]) => id)

  const deferError = new Error('Discord REST failure')
  let rejectDeferUpdate
  const deferGate = new Promise((_resolve, reject) => { rejectDeferUpdate = reject })
  const pickInteraction = makePickInteraction({ customId: 'autoplay_0', messageId, guildId: 'g1', userId: 'u1' })
  pickInteraction.deferUpdate = async () => { await deferGate }
  const pickPromise = handleRecommendChoice(pickInteraction, sessions, pendingStore)
  await new Promise((resolve) => setImmediate(resolve))

  // Nothing else is pending for g1 at this point (u2 never showed theirs),
  // but u1's pick is in flight, so a hypothetical timeout must not tear down yet.
  assert.equal(hasPendingForGuild(pendingStore, 'g1'), false, "u1's entry was already claimed out of pendingStore")

  rejectDeferUpdate(deferError)
  await assert.rejects(pickPromise, deferError)

  assert.equal(session.queue.isEmpty, true, 'nothing should have been enqueued by the failed pick')
})

test('cancelRecommendations: clears per-user pending prompts and disables the shared round message', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage(), timeoutHandle: setTimeout(() => {}, RECOMMEND_TIMEOUT_MS) })
  const roundMessage = makeSentMessage()
  const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map(), message: roundMessage, timeoutHandle: setTimeout(() => {}, RECOMMEND_TIMEOUT_MS), expired: false }]])

  cancelRecommendations('g1', pendingStore, recommendRounds)

  assert.equal(pendingStore.get('msg-1'), null)
  assert.equal(recommendRounds.has('g1'), false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(roundMessage.editCalls.length, 1, 'the shared button should be disabled')
})
