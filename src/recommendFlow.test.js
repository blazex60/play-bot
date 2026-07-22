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
// button interaction, unlike the old DM-originated prompts. `replyGate`, if
// given, is awaited inside reply() before it resolves, so a test can pause a
// click mid-flight (before pendingStore registration) to simulate a race.
function makeShowInteraction({ guildId, userId, member, replyGate }) {
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
      if (replyGate) await replyGate
      replies.push(payload)
      this.replied = true
      replyMessage = makeSentMessage()
    },
    async fetchReply() { return replyMessage },
    async deleteReply() { this.deletedReply = true },
  }
}

// The click on a track-choice button living inside the ephemeral message
// handleShowRecommendations posted. voiceChannelId defaults to 'vc-1' to
// match makeSession's own default, so the picker is "in the VC" unless a
// test deliberately sets it elsewhere (or passes a custom member without
// a voice field at all).
function makePickInteraction({ customId, messageId, guildId, userId, member, voiceChannelId = 'vc-1' }) {
  const replies = []
  return {
    customId,
    message: { id: messageId },
    guildId,
    user: { id: userId },
    member: member ?? { roles: { cache: { has: () => false } }, voice: { channelId: voiceChannelId } },
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
  const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map([['u1', [makeCandidate('v1')]]]), message: makeSentMessage(), timeoutHandle: null, expired: false, consumedUserIds: new Set() }]])
  const pendingStore = new PendingChoiceStore()
  const sessions = new Map()
  const interaction = makeShowInteraction({ guildId: 'g1', userId: 'u1' })

  await handleShowRecommendations(interaction, sessions, recommendRounds, pendingStore)

  assert.equal(interaction.replies[0].content, '❌ セッションが終了しています')
})

test('handleShowRecommendations: a user denied the play command cannot see their recommendations', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('g1', 'play', 'deny')
    const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map([['u1', [makeCandidate('v1')]]]), message: makeSentMessage(), timeoutHandle: null, expired: false, consumedUserIds: new Set() }]])
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
      const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map([['u1', [makeCandidate('v1')]]]), message: makeSentMessage(), timeoutHandle: null, expired: false, consumedUserIds: new Set() }]])
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
  const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map([['u1', [makeCandidate('v1')]]]), message: makeSentMessage(), timeoutHandle: null, expired: false, consumedUserIds: new Set() }]])
  const pendingStore = new PendingChoiceStore()
  const sessions = new Map([['g1', makeSession()]])
  const interaction = makeShowInteraction({ guildId: 'g1', userId: 'someone-who-joined-late' })

  await handleShowRecommendations(interaction, sessions, recommendRounds, pendingStore)

  assert.equal(interaction.replies[0].content, '❌ 現在あなた向けのおすすめはありません')
})

test('handleShowRecommendations: a second click while the first ephemeral prompt is still unanswered is rejected', async (t) => {
  const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map([['u1', [makeCandidate('v1')]]]), message: makeSentMessage(), timeoutHandle: null, expired: false, consumedUserIds: new Set() }]])
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

test('handleShowRecommendations: two rapid clicks by the same user must not both create a pick (regression: hasPendingForUser raced the reply/fetchReply awaits)', async () => {
  const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map([['u1', [makeCandidate('v1')]]]), message: makeSentMessage(), timeoutHandle: null, expired: false, consumedUserIds: new Set() }]])
  const pendingStore = new PendingChoiceStore()
  const sessions = new Map([['g1', makeSession()]])

  let releaseReply
  const replyGate = new Promise((resolve) => { releaseReply = resolve })
  const first = makeShowInteraction({ guildId: 'g1', userId: 'u1', replyGate })
  const second = makeShowInteraction({ guildId: 'g1', userId: 'u1', replyGate })

  // Both clicks start "simultaneously" and pause inside reply() — neither
  // has registered a pendingStore entry yet when the second one starts.
  const firstPromise = handleShowRecommendations(first, sessions, recommendRounds, pendingStore)
  const secondPromise = handleShowRecommendations(second, sessions, recommendRounds, pendingStore)
  await new Promise((resolve) => setImmediate(resolve))

  releaseReply()
  await Promise.all([firstPromise, secondPromise])

  const entries = [...pendingStore.entries()]
  for (const [, entry] of entries) clearTimeout(entry.timeoutHandle)
  assert.equal(entries.length, 1, 'only one of the two racing clicks should register a pick')
  assert.equal(second.replies[0].content, '⚠️ 既におすすめを表示済みです。そちらから選択してください', "the second, reserved-out click should get the dedup reply, not a second choice prompt")
})

test('handleShowRecommendations: does not register a pick if the round is cancelled (e.g. /stop) while reply/fetchReply are in flight', async () => {
  const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map([['u1', [makeCandidate('v1')]]]), message: makeSentMessage(), timeoutHandle: null, expired: false, consumedUserIds: new Set() }]])
  const pendingStore = new PendingChoiceStore()
  const sessions = new Map([['g1', makeSession()]])

  let releaseReply
  const replyGate = new Promise((resolve) => { releaseReply = resolve })
  const interaction = makeShowInteraction({ guildId: 'g1', userId: 'u1', replyGate })

  const showPromise = handleShowRecommendations(interaction, sessions, recommendRounds, pendingStore)
  await new Promise((resolve) => setImmediate(resolve))

  // /stop lands while this click's reply()/fetchReply() are still in
  // flight — cancelPendingRecommendations can't remove this not-yet-stored
  // entry, so handleShowRecommendations must notice on its own once the
  // awaits resolve.
  cancelRecommendations('g1', pendingStore, recommendRounds)
  releaseReply()
  await showPromise

  assert.equal(pendingStore.entries().next().done, true, 'no pick should be registered for a round cancelled mid-flight')
  assert.equal(interaction.deletedReply, true, 'the stale ephemeral reply should be deleted instead of left live')
})

test('handleShowRecommendations: does not register a pick if a newer round supersedes this one while reply/fetchReply are in flight (regression: retireRound does not bump the cancel generation)', async () => {
  const recommendRounds = new Map()
  const pendingStore = new PendingChoiceStore()
  const sessions = new Map([['g1', makeSession()]])
  const channel = makeChannel()

  await postRecommendationPrompt({ channel, guildId: 'g1', plans: [{ userId: 'u1', candidates: [makeCandidate('v1')] }], recommendRounds, pendingStore })
  const roundA = recommendRounds.get('g1')

  let releaseReply
  const replyGate = new Promise((resolve) => { releaseReply = resolve })
  const interaction = makeShowInteraction({ guildId: 'g1', userId: 'u1', replyGate })

  const showPromise = handleShowRecommendations(interaction, sessions, recommendRounds, pendingStore)
  await new Promise((resolve) => setImmediate(resolve))

  // Round A is superseded by round B while this click's reply()/fetchReply()
  // are still in flight — e.g. someone else picked a short track from round
  // A and playback exhausted again. This goes through postRecommendationPrompt
  // (retireRound), not cancelRecommendations, so it never bumps the cancel
  // generation.
  await postRecommendationPrompt({ channel, guildId: 'g1', plans: [{ userId: 'u1', candidates: [makeCandidate('v2')] }], recommendRounds, pendingStore })
  const roundB = recommendRounds.get('g1')
  assert.notEqual(roundB, roundA, 'round B should now be the live round')

  releaseReply()
  await showPromise

  assert.equal(pendingStore.entries().next().done, true, "no pick built from round A's stale candidates should be registered")
  assert.equal(interaction.deletedReply, true, 'the stale ephemeral reply should be deleted instead of left live')

  clearTimeout(roundB.timeoutHandle)
})

test('handleShowRecommendations: shows an ephemeral, personal choice prompt and registers it in pendingStore', async (t) => {
  const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map([['u1', [makeCandidate('v1')]]]), message: makeSentMessage(), timeoutHandle: null, expired: false, consumedUserIds: new Set() }]])
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
        member: { roles: { cache: { has: (id) => id === 'admin-role' } }, voice: { channelId: 'vc-1' } },
      })

      await handleRecommendChoice(interaction, sessions, pendingStore)

      assert.equal(session.queue.current?.videoId, 'v1', 'the admin-role bypass must still apply to recommendation picks')
      assert.equal(session.player.playNextCalls.length, 1)
    } finally {
      delete process.env.ADMIN_ROLE_ID
    }
  })
})

test('handleRecommendChoice: rejects a pick from a user who left the VC after their ephemeral prompt was shown (regression: the "show" snapshot alone let departed users still enqueue/start playback)', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage(), timeoutHandle: null, expired: false })
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])
  const interaction = makePickInteraction({ customId: 'autoplay_0', messageId: 'msg-1', guildId: 'g1', userId: 'u1', voiceChannelId: 'vc-2' })

  await handleRecommendChoice(interaction, sessions, pendingStore)

  assert.equal(session.queue.isEmpty, true, 'must not enqueue a pick from a user no longer in the VC')
  assert.equal(session.player.playNextCalls.length, 0)
  assert.equal(interaction.replies[0].content, '❌ ボイスチャンネルに参加してから操作してください')
  assert.ok(pendingStore.get('msg-1'), 'entry must survive so picking again after rejoining the VC still works')
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
  const pickPromise = handleRecommendChoice(pickInteraction, sessions, pendingStore, recommendRounds)
  await new Promise((resolve) => setImmediate(resolve))

  // Nothing else is pending for g1 at this point (u2 never showed theirs),
  // but u1's pick is in flight, so a hypothetical timeout must not tear down yet.
  assert.equal(hasPendingForGuild(pendingStore, 'g1'), false, "u1's entry was already claimed out of pendingStore")

  rejectDeferUpdate(deferError)
  await assert.rejects(pickPromise, deferError)

  assert.equal(session.queue.isEmpty, true, 'nothing should have been enqueued by the failed pick')
  // Regression: the shared round itself is still live (its own 5-minute
  // timer hasn't fired) and u2 never got a chance to show/pick theirs — a
  // failed pick must not fire onTimeout early just because pendingStore and
  // in-flight picks are both empty at this instant.
  assert.equal(onTimeoutCalls, 0, "a failed pick must not tear down a guild whose shared round is still live")
})

test("handleShowRecommendations: a stale per-user pick from an old, superseded round expiring must not fire that old round's onTimeout or retire the newer live round (regression: could re-plan and retire a still-live round early)", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const channel = makeChannel()
  const recommendRounds = new Map()
  const pendingStore = new PendingChoiceStore()
  const sessions = new Map([['g1', makeSession()]])

  let onTimeoutACalls = 0
  await postRecommendationPrompt({
    channel, guildId: 'g1', plans: [{ userId: 'u2', candidates: [makeCandidate('v1')] }], recommendRounds, pendingStore,
    onTimeout: async () => { onTimeoutACalls += 1 },
  })

  // u2 shows their recommendations during round A's lifetime — this per-user
  // entry's own 5-minute timer captures round A's onTimeout callback (the
  // one live in guildOnTimeoutCallbacks at the moment it's created).
  const showInteraction = makeShowInteraction({ guildId: 'g1', userId: 'u2' })
  await handleShowRecommendations(showInteraction, sessions, recommendRounds, pendingStore)

  // Some time later (but still within round A's own 5-minute window), a
  // second round replaces it — e.g. someone else picked a short track from
  // round A and playback exhausted again. Giving this its own gap in time
  // means round B's own timer targets a different instant than u2's
  // still-open pick from round A.
  t.mock.timers.tick(2 * 60 * 1000)
  let onTimeoutBCalls = 0
  await postRecommendationPrompt({
    channel, guildId: 'g1', plans: [{ userId: 'u2', candidates: [makeCandidate('v2')] }], recommendRounds, pendingStore,
    onTimeout: async () => { onTimeoutBCalls += 1 },
  })
  const roundB = recommendRounds.get('g1')
  assert.ok(roundB, 'round B should now be the live round')

  // Advance to the instant u2's stale round-A pick expires (5 minutes after
  // it was shown) — round B's own timer targets 5 minutes *after this*, so
  // it must not have fired yet.
  t.mock.timers.tick(3 * 60 * 1000)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(onTimeoutACalls, 0, "round A's stale onTimeout must not fire just because its own per-user pick expired")
  assert.equal(onTimeoutBCalls, 0, "round B's own timer has not reached its deadline yet")
  assert.equal(recommendRounds.get('g1'), roundB, 'round B must not be retired by an old round\'s pick expiring')

  clearTimeout(roundB.timeoutHandle)
})

test('handleShowRecommendations: rejects a re-show after the user already picked in this round (regression: re-clicking "show" let a single user enqueue multiple tracks per round)', async (t) => {
  const channel = makeChannel()
  const recommendRounds = new Map()
  const pendingStore = new PendingChoiceStore()
  const session = makeSession({ voiceChannelId: 'vc-1' })
  const sessions = new Map([['g1', session]])

  await postRecommendationPrompt({ channel, guildId: 'g1', plans: [{ userId: 'u1', candidates: [makeCandidate('v1')] }], recommendRounds, pendingStore })
  t.after(() => clearTimeout(recommendRounds.get('g1')?.timeoutHandle))

  const firstShow = makeShowInteraction({ guildId: 'g1', userId: 'u1' })
  await handleShowRecommendations(firstShow, sessions, recommendRounds, pendingStore)
  const [messageId] = [...pendingStore.entries()].map(([id]) => id)

  const pick = makePickInteraction({ customId: 'autoplay_0', messageId, guildId: 'g1', userId: 'u1' })
  await handleRecommendChoice(pick, sessions, pendingStore, recommendRounds)
  assert.equal(session.queue.current?.videoId, 'v1', 'the first pick should succeed normally')

  const secondShow = makeShowInteraction({ guildId: 'g1', userId: 'u1' })
  await handleShowRecommendations(secondShow, sessions, recommendRounds, pendingStore)

  assert.equal(secondShow.replies[0].content, '❌ 今回のラウンドでは既に選択済みです')
  assert.equal(pendingStore.entries().next().done, true, 'no new pick prompt should be created after the round is already consumed')
})

test('cancelRecommendations: clears per-user pending prompts and disables the shared round message', async () => {
  const pendingStore = new PendingChoiceStore()
  pendingStore.set('msg-1', { guildId: 'g1', targetUserId: 'u1', candidates: [makeCandidate('v1')], message: makeSentMessage(), timeoutHandle: setTimeout(() => {}, RECOMMEND_TIMEOUT_MS) })
  const roundMessage = makeSentMessage()
  const recommendRounds = new Map([['g1', { guildId: 'g1', candidatesByUserId: new Map(), message: roundMessage, timeoutHandle: setTimeout(() => {}, RECOMMEND_TIMEOUT_MS), expired: false, consumedUserIds: new Set() }]])

  cancelRecommendations('g1', pendingStore, recommendRounds)

  assert.equal(pendingStore.get('msg-1'), null)
  assert.equal(recommendRounds.has('g1'), false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(roundMessage.editCalls.length, 1, 'the shared button should be disabled')
})
