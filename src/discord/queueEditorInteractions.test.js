import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configureSettingsPathForTest, setDefaultCommandPermission } from '../shared/settings.js'
import { GuildQueue, createTrack } from '../playback/queue.js'
import { handleQueueEditorInteraction } from './queueEditorInteractions.js'
import { buildQueueEditorPayload } from './queueEditorView.js'
import { webClient } from '../playback/sessions.js'

// webClient is a real singleton (it fails soft internally, so letting it
// attempt an actual loopback fetch in tests is harmless — see the other
// tests above), but asserting the audit-log call itself requires swapping
// out logOperation for the duration of a test.
function withLoggedOperations(fn) {
  const calls = []
  const original = webClient.logOperation
  webClient.logOperation = async (payload) => { calls.push(payload) }
  return fn(calls).finally(() => { webClient.logOperation = original })
}

async function withTempSettings(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'music-bot-qedit-test-'))
  configureSettingsPathForTest(join(dir, 'data', 'guild-settings.json'))
  try {
    await fn()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function makeSession({ channelId = 'voice-1' } = {}) {
  const queue = new GuildQueue()
  queue.add(createTrack({ title: 'current', webpageUrl: 'https://example.com/current', duration: 60, requestedBy: 'tester' }))
  queue.add(createTrack({ title: 'next', webpageUrl: 'https://example.com/next', duration: 60, requestedBy: 'tester' }))
  return { connection: { joinConfig: { channelId } }, queue }
}

function fakeInteraction({ customId, kind = 'button', guildId = 'guild-1', userId = 'user-1', channelId = 'voice-1', roles = [] } = {}) {
  const calls = { reply: [], followUp: [], update: [] }
  return {
    customId,
    guildId,
    channelId,
    user: { id: userId },
    member: { roles: { cache: { has: (id) => roles.includes(id) } }, voice: { channelId } },
    deferred: false,
    replied: false,
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'select',
    isModalSubmit: () => kind === 'modal',
    reply: async (payload) => { calls.reply.push(payload); return payload },
    followUp: async (payload) => { calls.followUp.push(payload); return payload },
    update: async (payload) => { calls.update.push(payload); return payload },
    calls,
  }
}

test('handleQueueEditorInteraction: a user denied the queue command cannot remove a track via the editor buttons', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'queue', 'deny')
    const session = makeSession()
    const sessions = new Map([['guild-1', session]])
    const interaction = fakeInteraction({ customId: 'qedit_remove_p0_i0' })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.reply.length, 1, 'must reply with a denial instead of silently doing nothing')
    assert.equal(interaction.calls.update.length, 0, 'must not touch the queue editor message')
    assert.equal(session.queue.upcoming().length, 1, 'must not remove the track (regression: qedit_ actions bypassed checkCommandAllowed)')
  })
})

test('handleQueueEditorInteraction: a user denied the queue command cannot reorder via the select menu', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'queue', 'deny')
    const session = makeSession()
    const sessions = new Map([['guild-1', session]])
    const interaction = fakeInteraction({ customId: 'qedit_select_p0', kind: 'select' })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.reply.length, 1, 'must reply with a denial')
    assert.equal(interaction.calls.update.length, 0, 'must not touch the queue editor message')
  })
})

test('handleQueueEditorInteraction: a user denied the queue command cannot jump via the modal submit', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'queue', 'deny')
    const session = makeSession()
    const sessions = new Map([['guild-1', session]])
    const interaction = fakeInteraction({ customId: 'qedit_jumpmodal_p0_i0', kind: 'modal' })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.reply.length, 1, 'must reply with a denial')
    assert.equal(interaction.calls.update.length, 0, 'must not move the track')
    assert.equal(session.queue.upcoming().length, 1, 'queue must be unchanged')
  })
})

test('handleQueueEditorInteraction: an allowed user can still remove a track via the editor buttons', async () => {
  await withTempSettings(async () => {
    const session = makeSession()
    const sessions = new Map([['guild-1', session]])
    const interaction = fakeInteraction({ customId: `qedit_remove_p0_i0_r${session.queue.revision}_q${session.queue.id}` })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.update.length, 1)
    assert.equal(session.queue.upcoming().length, 0)
  })
})

test('handleQueueEditorInteraction: a user denied the queue command cannot close someone else\'s public panel', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'queue', 'deny')
    const session = makeSession()
    session.connection.destroy = () => {}
    const sessions = new Map([['guild-1', session]])
    let deleted = false
    const interaction = fakeInteraction({ customId: 'qedit_close_p0' })
    interaction.deferUpdate = async () => {}
    interaction.message = { delete: async () => { deleted = true } }

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(deleted, false, 'a denied user must not be able to dismiss a public queue panel (regression: qedit_close bypassed checkCommandAllowed)')
    assert.equal(interaction.calls.reply.length, 1, 'must reply with a denial')
  })
})

test('handleQueueEditorInteraction: removing a track via the editor records an operation log entry (regression: qedit_ mutations were absent from the admin audit log)', async () => {
  await withTempSettings(async () => {
    await withLoggedOperations(async (calls) => {
      const session = makeSession()
      const sessions = new Map([['guild-1', session]])
      const interaction = fakeInteraction({ customId: `qedit_remove_p0_i0_r${session.queue.revision}_q${session.queue.id}` })

      await handleQueueEditorInteraction(interaction, sessions)

      assert.equal(calls.length, 1)
      assert.equal(calls[0].action, 'queue')
      assert.equal(calls[0].success, true)
      assert.equal(calls[0].guildId, 'guild-1')
      assert.equal(calls[0].discordUserId, 'user-1')
    })
  })
})

test('handleQueueEditorInteraction: moving a track via the editor records a successful operation log entry', async () => {
  await withTempSettings(async () => {
    await withLoggedOperations(async (calls) => {
      const session = makeSession()
      // makeSession() only has one upcoming track, and moving the sole
      // upcoming track anywhere is always a no-op — add a second so
      // qedit_movedown (index 0 -> 1) is a real, successful move.
      session.queue.add(createTrack({ title: 'third', webpageUrl: 'https://example.com/third', duration: 60, requestedBy: 'tester' }))
      const sessions = new Map([['guild-1', session]])
      const interaction = fakeInteraction({ customId: `qedit_movedown_p0_i0_r${session.queue.revision}_q${session.queue.id}` })

      await handleQueueEditorInteraction(interaction, sessions)

      assert.equal(calls.length, 1)
      assert.equal(calls[0].action, 'queue')
      assert.equal(calls[0].success, true)
    })
  })
})

test('handleQueueEditorInteraction: a no-op move via the editor records a failed operation log entry', async () => {
  await withTempSettings(async () => {
    await withLoggedOperations(async (calls) => {
      const session = makeSession()
      const sessions = new Map([['guild-1', session]])
      // makeSession() has exactly one upcoming track, so moving it to the
      // front (already position 0) is a no-op moveUpcoming reports as failed.
      const interaction = fakeInteraction({ customId: `qedit_tofront_p0_i0_r${session.queue.revision}_q${session.queue.id}` })

      await handleQueueEditorInteraction(interaction, sessions)

      assert.equal(calls.length, 1)
      assert.equal(calls[0].action, 'queue')
      assert.equal(calls[0].success, false)
    })
  })
})

test('handleQueueEditorInteraction: a denied user\'s removal attempt is not logged (checkCommandAllowed short-circuits first)', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'queue', 'deny')
    await withLoggedOperations(async (calls) => {
      const session = makeSession()
      const sessions = new Map([['guild-1', session]])
      const interaction = fakeInteraction({ customId: 'qedit_remove_p0_i0' })

      await handleQueueEditorInteraction(interaction, sessions)

      assert.equal(calls.length, 0)
    })
  })
})

test('handleQueueEditorInteraction: an allowed user can close the editor', async () => {
  await withTempSettings(async () => {
    const session = makeSession()
    session.connection.destroy = () => {}
    const sessions = new Map([['guild-1', session]])
    let deleted = false
    const interaction = fakeInteraction({ customId: 'qedit_close_p0' })
    interaction.deferUpdate = async () => {}
    interaction.message = { delete: async () => { deleted = true } }

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(deleted, true)
  })
})

// --- revision guard (optimistic concurrency) --------------------------------
// The editor operates by upcoming index; a queue change between render and
// click shifts every later index. Without the embedded _r revision the op
// would silently hit the wrong track.

test('handleQueueEditorInteraction: a remove submitted against a stale revision warns and removes nothing', async () => {
  await withTempSettings(async () => {
    const session = makeSession()
    const staleRevision = session.queue.revision
    // Another user's op lands after our message rendered (e.g. /play).
    session.queue.add(createTrack({ title: 'late', webpageUrl: 'https://example.com/late', duration: 60, requestedBy: 'tester' }))
    const sessions = new Map([['guild-1', session]])
    const interaction = fakeInteraction({ customId: `qedit_remove_p0_i0_r${staleRevision}_q${session.queue.id}` })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.update.length, 1, 're-renders the panel with fresh state')
    assert.equal(interaction.calls.followUp.length, 1)
    assert.match(interaction.calls.followUp[0].content, /キューが変更されました/)
    assert.deepEqual(session.queue.upcoming().map((t) => t.title), ['next', 'late'], 'stale remove must not delete the track now at that index')
  })
})

test('handleQueueEditorInteraction: a move submitted against a stale revision warns and reorders nothing', async () => {
  await withTempSettings(async () => {
    const session = makeSession()
    session.queue.add(createTrack({ title: 'third', webpageUrl: 'https://example.com/third', duration: 60, requestedBy: 'tester' }))
    const staleRevision = session.queue.revision
    session.queue.removeUpcoming(1) // 'third' removed since our render
    const sessions = new Map([['guild-1', session]])
    const interaction = fakeInteraction({ customId: `qedit_movedown_p0_i0_r${staleRevision}_q${session.queue.id}` })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.followUp.length, 1)
    assert.match(interaction.calls.followUp[0].content, /キューが変更されました/)
    assert.deepEqual(session.queue.upcoming().map((t) => t.title), ['next'], 'stale move must leave the queue untouched')
  })
})

test('handleQueueEditorInteraction: a stale jumpmodal submit warns and does not move', async () => {
  await withTempSettings(async () => {
    const session = makeSession()
    session.queue.add(createTrack({ title: 'third', webpageUrl: 'https://example.com/third', duration: 60, requestedBy: 'tester' }))
    const staleRevision = session.queue.revision
    session.queue.shuffle()
    const sessions = new Map([['guild-1', session]])
    const interaction = fakeInteraction({ customId: `qedit_jumpmodal_p0_i0_r${staleRevision}_q${session.queue.id}`, kind: 'modal' })
    interaction.fields = { getTextInputValue: () => '2' }

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.followUp.length, 1)
    assert.match(interaction.calls.followUp[0].content, /キューが変更されました/)
  })
})

test('handleQueueEditorInteraction: duplicate videoIds — a stale remove cannot hit the wrong twin', async () => {
  await withTempSettings(async () => {
    const queue = new GuildQueue()
    queue.add(createTrack({ title: 'current', webpageUrl: 'https://example.com/current', duration: 60, requestedBy: 'tester' }))
    // Same videoId twice — an identity-based check can't tell them apart;
    // the revision can, because it rejects on ANY queue change since render.
    queue.add(createTrack({ title: 'dupe A', webpageUrl: 'https://example.com/d', duration: 60, requestedBy: 'tester', videoId: 'dup' }))
    queue.add(createTrack({ title: 'dupe B', webpageUrl: 'https://example.com/d', duration: 60, requestedBy: 'tester', videoId: 'dup' }))
    const session = { connection: { joinConfig: { channelId: 'voice-1' } }, queue }
    const staleRevision = queue.revision
    queue.removeUpcoming(0) // 'dupe A' removed since our render — index 0 is now 'dupe B'
    const sessions = new Map([['guild-1', session]])
    const interaction = fakeInteraction({ customId: `qedit_remove_p0_i0_r${staleRevision}_q${queue.id}` })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.followUp.length, 1)
    assert.equal(queue.upcoming().length, 1, 'must not remove the track that shifted into the stale index')
    assert.equal(queue.upcoming()[0].title, 'dupe B')
  })
})

test('handleQueueEditorInteraction: a pre-deploy custom_id without _r parses as stale and warns instead of mutating', async () => {
  await withTempSettings(async () => {
    const session = makeSession()
    const sessions = new Map([['guild-1', session]])
    const interaction = fakeInteraction({ customId: 'qedit_remove_p0_i0' }) // old format, no revision

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.followUp.length, 1)
    assert.match(interaction.calls.followUp[0].content, /キューが変更されました/)
    assert.equal(session.queue.upcoming().length, 1, 'must not remove without a matching revision')
  })
})

test('handleQueueEditorInteraction: a stale-revision rejection records a stale_revision operation log entry', async () => {
  await withTempSettings(async () => {
    await withLoggedOperations(async (calls) => {
      const session = makeSession()
      const staleRevision = session.queue.revision
      session.queue.add(createTrack({ title: 'late', webpageUrl: 'https://example.com/late', duration: 60, requestedBy: 'tester' }))
      const sessions = new Map([['guild-1', session]])
      const interaction = fakeInteraction({ customId: `qedit_remove_p0_i0_r${staleRevision}_q${session.queue.id}` })

      await handleQueueEditorInteraction(interaction, sessions)

      assert.equal(calls.length, 1)
      assert.equal(calls[0].action, 'queue')
      assert.equal(calls[0].success, false)
      assert.equal(calls[0].detail, 'stale_revision')
    })
  })
})

// --- queue identity (cross-session collision guard) --------------------------
// #revision restarts at 0 on every new GuildQueue, so revision alone cannot
// distinguish a token minted under a destroyed session from the replacement
// session's queue that climbed back to the same count. The embedded _q<id>
// is process-unique per queue, so the dead session's token can never match.

test('handleQueueEditorInteraction: a button from a destroyed session cannot mutate its replacement at the same revision', async () => {
  await withTempSettings(async () => {
    // Session A forms a queue; an editor renders at revision 2.
    const sessionA = makeSession()
    const renderedRevision = sessionA.queue.revision
    assert.equal(renderedRevision, 2)
    const staleQueueId = sessionA.queue.id
    // /leave destroys A; a rejoin creates session B whose fresh queue also
    // reaches revision 2 — identical revision, different queue identity.
    const sessionB = makeSession()
    assert.equal(sessionB.queue.revision, renderedRevision)
    assert.notEqual(sessionB.queue.id, staleQueueId)
    const sessions = new Map([['guild-1', sessionB]])
    const interaction = fakeInteraction({ customId: `qedit_remove_p0_i0_r${renderedRevision}_q${staleQueueId}` })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.followUp.length, 1)
    assert.match(interaction.calls.followUp[0].content, /キューが変更されました/)
    assert.deepEqual(sessionB.queue.upcoming().map((t) => t.title), ['next'], 'session B queue must be unchanged')
  })
})

test('handleQueueEditorInteraction: a stale queue id on a move warns and reorders nothing', async () => {
  await withTempSettings(async () => {
    const sessionA = makeSession()
    sessionA.queue.add(createTrack({ title: 'third', webpageUrl: 'https://example.com/third', duration: 60, requestedBy: 'tester' }))
    const renderedRevision = sessionA.queue.revision
    const staleQueueId = sessionA.queue.id
    const sessionB = makeSession()
    sessionB.queue.add(createTrack({ title: 'third', webpageUrl: 'https://example.com/third', duration: 60, requestedBy: 'tester' }))
    assert.equal(sessionB.queue.revision, renderedRevision)
    const sessions = new Map([['guild-1', sessionB]])
    const interaction = fakeInteraction({ customId: `qedit_movedown_p0_i0_r${renderedRevision}_q${staleQueueId}` })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.followUp.length, 1)
    assert.match(interaction.calls.followUp[0].content, /キューが変更されました/)
    assert.deepEqual(sessionB.queue.upcoming().map((t) => t.title), ['next', 'third'])
  })
})

test('handleQueueEditorInteraction: a custom_id with _r but no _q is stale on a mutating action even at the live revision', async () => {
  await withTempSettings(async () => {
    const session = makeSession()
    const sessions = new Map([['guild-1', session]])
    // Deployed between the revision fix and the queue-id fix: parses, but
    // the missing token can never equal the live queue id → stale, no op.
    const interaction = fakeInteraction({ customId: `qedit_remove_p0_i0_r${session.queue.revision}` })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.followUp.length, 1)
    assert.match(interaction.calls.followUp[0].content, /キューが変更されました/)
    assert.equal(session.queue.upcoming().length, 1, 'must not remove without a matching queue id')
  })
})

test('handleQueueEditorInteraction: a legacy numeric _q custom_id is stale on a mutating action even at the live revision', async () => {
  await withTempSettings(async () => {
    const session = makeSession()
    const sessions = new Map([['guild-1', session]])
    // Pre-UUID format: _q carried a process-local counter that could
    // collide with a post-restart queue's id. It still parses (mutating
    // buttons degrade to the stale warning, not silence), but a numeric
    // token can never equal the live UUID → stale, no mutation.
    const interaction = fakeInteraction({ customId: `qedit_remove_p0_i0_r${session.queue.revision}_q3` })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.followUp.length, 1)
    assert.match(interaction.calls.followUp[0].content, /キューが変更されました/)
    assert.equal(session.queue.upcoming().length, 1, 'must not remove with a numeric queue id')
  })
})

// --- custom_id length budget -------------------------------------------------
// Discord caps custom_ids (and select values) at 100 chars. The full 36-char
// UUID travels in every one, so the longest variant — qedit_jumpmodal, which
// stacks _p + _i + _r + _q — must still fit with multi-digit fields.

test('handleQueueEditorInteraction: the qedit_jumpmodal custom_id stays under the 100-char limit with a full UUID', async () => {
  await withTempSettings(async () => {
    const session = makeSession()
    const sessions = new Map([['guild-1', session]])
    const interaction = fakeInteraction({
      customId: `qedit_jump_p12345_i99999_r99999999_q${session.queue.id}`,
    })
    let modalCustomId = null
    interaction.showModal = async (modal) => { modalCustomId = modal.toJSON().custom_id }

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(
      modalCustomId,
      `qedit_jumpmodal_p12345_i99999_r99999999_q${session.queue.id}`,
      'the modal must carry page + index + revision + queue id through to submit'
    )
    assert.ok(modalCustomId.length <= 100, `${modalCustomId} is ${modalCustomId.length} chars — over Discord's limit`)
  })
})

test('buildQueueEditorPayload: every rendered custom_id and select value fits the 100-char limit with a full UUID', () => {
  const track = createTrack({ title: 't', webpageUrl: 'https://example.com/t', duration: 60, requestedBy: 'u' })
  const state = {
    current: track,
    // Enough tracks for multi-digit page and index fields.
    upcoming: Array(100_000).fill(track),
    loopMode: 'off',
    revision: 999_999_999,
    queueId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  }
  const { components } = buildQueueEditorPayload(state, { page: 999_999, selectedIndex: 99_999 })
  assert.ok(components.length >= 3, 'select row + nav row + action row expected')
  for (const row of components) {
    for (const component of row.components) {
      const json = component.toJSON()
      assert.ok(json.custom_id.length <= 100, `${json.custom_id} (${json.custom_id.length} chars)`)
      for (const option of json.options ?? []) {
        assert.ok(option.value.length <= 100, `${option.value} (${option.value.length} chars)`)
      }
    }
  }
})
