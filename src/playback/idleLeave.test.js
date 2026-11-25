import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_IDLE_LEAVE_DELAY_MS,
  cancelIdleLeave,
  formatIdleLeaveNotice,
  hasIdleLeavePending,
  postponeIdleLeave,
  resolveIdleLeaveDelayMs,
  scheduleIdleLeave,
} from './idleLeave.js'

function fakeTimers() {
  const timers = new Map()
  let nextId = 1
  return {
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms, at: (globalThis.__clock ?? 0) + ms }); return id },
    clearTimer: (id) => { timers.delete(id) },
    fireAll: () => { for (const [id, { fn }] of [...timers]) { timers.delete(id); fn() } },
    // fire only what an injected clock says is due
    fireDue: (now) => { for (const [id, t] of [...timers]) { if (t.at <= now) { timers.delete(id); t.fn() } } },
    pending: () => [...timers.values()],
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('resolveIdleLeaveDelayMs: default, override, 0, and invalid values', () => {
  assert.equal(resolveIdleLeaveDelayMs({}), DEFAULT_IDLE_LEAVE_DELAY_MS)
  assert.equal(resolveIdleLeaveDelayMs({ IDLE_LEAVE_DELAY_MS: '' }), DEFAULT_IDLE_LEAVE_DELAY_MS)
  assert.equal(resolveIdleLeaveDelayMs({ IDLE_LEAVE_DELAY_MS: '60000' }), 60_000)
  assert.equal(resolveIdleLeaveDelayMs({ IDLE_LEAVE_DELAY_MS: '0' }), 0)
  assert.equal(resolveIdleLeaveDelayMs({ IDLE_LEAVE_DELAY_MS: '-5' }), DEFAULT_IDLE_LEAVE_DELAY_MS)
  assert.equal(resolveIdleLeaveDelayMs({ IDLE_LEAVE_DELAY_MS: 'soon' }), DEFAULT_IDLE_LEAVE_DELAY_MS)
})

test('formatIdleLeaveNotice: rounds to whole minutes, at least 1', () => {
  assert.match(formatIdleLeaveNotice(180_000), /3 分/)
  assert.match(formatIdleLeaveNotice(10_000), /1 分/)
})

test('scheduleIdleLeave: notifies, then leaves after the delay while still idle', async () => {
  const t = fakeTimers()
  const session = {}
  const notices = []
  let left = 0
  const result = await scheduleIdleLeave(session, {
    delayMs: 180_000,
    isStillIdle: () => true,
    leave: async () => { left += 1 },
    notify: async (text) => { notices.push(text) },
    ...t,
  })
  assert.equal(result, 'scheduled')
  await flush()
  assert.equal(notices.length, 1)
  assert.equal(t.pending()[0].ms, 180_000)
  assert.equal(left, 0, 'must not leave before the delay')
  assert.equal(hasIdleLeavePending(session), true)

  t.fireAll()
  await flush()
  assert.equal(left, 1)
  assert.equal(hasIdleLeavePending(session), false)
})

test('scheduleIdleLeave: cancel before the deadline keeps the session', async () => {
  const t = fakeTimers()
  const session = {}
  let left = 0
  await scheduleIdleLeave(session, { delayMs: 1000, isStillIdle: () => true, leave: async () => { left += 1 }, ...t })
  assert.equal(cancelIdleLeave(session, t), true)
  assert.equal(t.pending().length, 0)
  t.fireAll()
  await flush()
  assert.equal(left, 0)
  assert.equal(cancelIdleLeave(session, t), false, 'second cancel is a no-op')
})

test('scheduleIdleLeave: stays when no longer idle at the deadline', async () => {
  const t = fakeTimers()
  const session = {}
  let left = 0
  await scheduleIdleLeave(session, { delayMs: 1000, isStillIdle: () => false, leave: async () => { left += 1 }, ...t })
  t.fireAll()
  await flush()
  assert.equal(left, 0)
})

test('scheduleIdleLeave: a repeat exhaustion keeps the first deadline and posts no duplicate notice', async () => {
  const t = fakeTimers()
  const session = {}
  const notices = []
  const opts = { delayMs: 1000, isStillIdle: () => true, leave: async () => {}, notify: async (x) => { notices.push(x) }, ...t }
  await scheduleIdleLeave(session, opts)
  await scheduleIdleLeave(session, opts)
  await flush()
  assert.equal(t.pending().length, 1)
  assert.equal(notices.length, 1)
})

test('scheduleIdleLeave: delay 0 leaves immediately without notice', async () => {
  const t = fakeTimers()
  const session = {}
  let left = 0
  const notices = []
  const result = await scheduleIdleLeave(session, { delayMs: 0, isStillIdle: () => true, leave: async () => { left += 1 }, notify: async (x) => { notices.push(x) }, ...t })
  assert.equal(result, 'immediate')
  assert.equal(left, 1)
  assert.equal(notices.length, 0)
  assert.equal(t.pending().length, 0)
})

test('scheduleIdleLeave: a failing notice still arms the timer', async () => {
  const t = fakeTimers()
  const session = {}
  const errors = []
  let left = 0
  await scheduleIdleLeave(session, {
    delayMs: 1000,
    isStillIdle: () => true,
    leave: async () => { left += 1 },
    notify: async () => { throw new Error('Missing Permissions') },
    onNotifyError: (err) => errors.push(err.message),
    ...t,
  })
  await flush()
  assert.deepEqual(errors, ['Missing Permissions'])
  t.fireAll()
  await flush()
  assert.equal(left, 1)
})

test('scheduleIdleLeave: does not arm when playback is already active (stale exhaustion signal)', async () => {
  const t = fakeTimers()
  const session = {}
  const notices = []
  const result = await scheduleIdleLeave(session, {
    delayMs: 1000,
    isStillIdle: () => false,
    leave: async () => { throw new Error('must not leave') },
    notify: async (x) => { notices.push(x) },
    ...t,
  })
  await flush()
  assert.equal(result, 'not_idle')
  assert.equal(t.pending().length, 0)
  assert.equal(notices.length, 0, 'no false "queue is empty" notice')
  assert.equal(hasIdleLeavePending(session), false)
})

test('scheduleIdleLeave: the notice is fire-and-forget', async () => {
  const t = fakeTimers()
  const session = {}
  let resolveSend
  const result = await scheduleIdleLeave(session, {
    delayMs: 1000,
    isStillIdle: () => true,
    leave: async () => {},
    notify: () => new Promise((resolve) => { resolveSend = resolve }),
    ...t,
  })
  assert.equal(result, 'scheduled', 'resolves without waiting for the send')
  await flush()
  resolveSend()
})

test('postponeIdleLeave: extends a near deadline but never cancels it', async () => {
  const t = fakeTimers()
  const session = {}
  let clock = 0
  let left = 0
  globalThis.__clock = 0
  try {
    await scheduleIdleLeave(session, { delayMs: 180_000, isStillIdle: () => true, leave: async () => { left += 1 }, nowMs: () => clock, ...t })

    clock = 10_000
    assert.equal(postponeIdleLeave(session, 60_000), false, 'plenty of time left: unchanged')

    clock = 170_000
    globalThis.__clock = clock
    assert.equal(postponeIdleLeave(session, 60_000), true)
    assert.equal(t.pending().length, 1)
    assert.equal(t.pending()[0].ms, 60_000)

    t.fireDue(180_000)
    await flush()
    assert.equal(left, 0, 'original deadline no longer applies')

    t.fireDue(230_000)
    await flush()
    assert.equal(left, 1, 'still leaves once the extended deadline passes')
  } finally {
    delete globalThis.__clock
  }
})

test('postponeIdleLeave: no-op without a pending leave', () => {
  assert.equal(postponeIdleLeave({}, 60_000), false)
  assert.equal(postponeIdleLeave(null, 60_000), false)
})
