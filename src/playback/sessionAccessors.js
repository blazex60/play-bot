// Read-only accessors for the VC session objects owned by sessions.js.
// Adapter layers (discord/, local/) receive the session object as an opaque
// handle and read fields through these helpers instead of reaching into
// session.connection / session.planToken directly, so the session's
// internal shape stays encapsulated in the playback domain.
//
// These live in their own leaf module rather than in sessions.js itself:
// sessions.js imports discord/ modules (recommendFlow -> permissions) that
// need these helpers, and the circular-import rule bars them from
// importing sessions.js back.

export function sessionVoiceChannelId(session) {
  return session?.connection?.joinConfig?.channelId ?? null
}

export function sessionVoiceGuildId(session) {
  return session?.connection?.joinConfig?.guildId ?? null
}

export function sessionConnectionStatus(session) {
  return session?.connection?.state?.status ?? null
}

export function sessionPlanToken(session) {
  return session?.planToken ?? null
}

// A (session, planToken) pair captured before an await goes stale when the
// session was replaced (disconnect + rejoin created a new object) or its
// plan generation was bumped (/stop, autoplayMode flip — see
// bumpPlanToken in sessions.js). Async adapter flows re-check this after
// each await so a stale pick can't act on top of a newer session state.
export function isSessionStale(sessionsMap, guildId, session, planToken) {
  return sessionsMap.get(guildId) !== session || sessionPlanToken(session) !== planToken
}
