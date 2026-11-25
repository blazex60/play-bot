// Delayed leave after the queue runs dry (issue #61). Instead of leaving the
// VC the moment nothing is left to play, the session posts a notice and only
// leaves if it is still idle once the delay passes. Any track starting in the
// meantime (a /play, a recommend pick, a dashboard enqueue) cancels it.
//
// Kept free of discord.js / sessions.js imports so it is unit-testable with
// fake timers and a plain session object.

export const DEFAULT_IDLE_LEAVE_DELAY_MS = 3 * 60_000

// IDLE_LEAVE_DELAY_MS overrides the default; 0 restores the old immediate
// leave. Anything unparsable or negative falls back to the default.
export function resolveIdleLeaveDelayMs(env = process.env) {
  const raw = env.IDLE_LEAVE_DELAY_MS
  if (raw === undefined || raw === '') return DEFAULT_IDLE_LEAVE_DELAY_MS
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return DEFAULT_IDLE_LEAVE_DELAY_MS
  return Math.floor(value)
}

export function formatIdleLeaveNotice(delayMs) {
  const minutes = Math.max(1, Math.round(delayMs / 60_000))
  return `⏸️ キューが空になりました。${minutes} 分以内に曲が追加されなければ VC から退出します。`
}

export function hasIdleLeavePending(session) {
  return Boolean(session?.idleLeave)
}

export function cancelIdleLeave(session, { clearTimer = clearTimeout } = {}) {
  if (!session?.idleLeave) return false
  clearTimer(session.idleLeave.timer)
  session.idleLeave = null
  return true
}

/**
 * Arms the idle-leave timer on `session`.
 *
 * - isStillIdle(): checked before arming (a stale "nothing to play" signal
 *   can arrive after a /play already started a new track) and again when the
 *   timer fires.
 * - leave(): performs the actual teardown.
 * - notify(): best-effort user notice, fired without awaiting so a slow or
 *   rate-limited send never holds up the player's track-advance path.
 *
 * Returns 'immediate' when delayMs is 0 (leave() already awaited),
 * 'not_idle' when playback is active, 'scheduled' otherwise.
 */
export async function scheduleIdleLeave(session, {
  delayMs,
  isStillIdle,
  leave,
  notify = async () => {},
  onNotifyError = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  nowMs = Date.now,
}) {
  if (delayMs <= 0) {
    cancelIdleLeave(session, { clearTimer })
    await leave()
    return 'immediate'
  }
  if (!isStillIdle()) return 'not_idle'
  // A second exhaustion while one is pending (e.g. a recommend round timing
  // out after the queue already ran dry) keeps the original deadline and
  // does not post a duplicate notice.
  if (session.idleLeave) return 'scheduled'

  const entry = { timer: null, deadline: nowMs() + delayMs, fire: null, setTimer, clearTimer, nowMs }
  entry.fire = () => {
    if (session.idleLeave !== entry) return
    session.idleLeave = null
    if (!isStillIdle()) return
    Promise.resolve()
      .then(leave)
      .catch(() => {})
  }
  armTimer(entry, delayMs)
  session.idleLeave = entry

  Promise.resolve()
    .then(() => notify(formatIdleLeaveNotice(delayMs)))
    .catch(onNotifyError)
  return 'scheduled'
}

function armTimer(entry, ms) {
  entry.timer = entry.setTimer(entry.fire, ms)
  entry.timer?.unref?.()
}

// A command reusing the session (e.g. /play resolving metadata for a few
// seconds) must not have the bot leave right under it. Push a pending
// deadline out to at least minRemainingMs from now — but never cancel it:
// if that command ends up adding nothing, the bot should still leave.
export function postponeIdleLeave(session, minRemainingMs) {
  const entry = session?.idleLeave
  if (!entry) return false
  const now = entry.nowMs()
  if (entry.deadline - now >= minRemainingMs) return false
  entry.clearTimer(entry.timer)
  entry.deadline = now + minRemainingMs
  armTimer(entry, minRemainingMs)
  return true
}
