import {
  cancelRecommendations,
  hasPendingForGuild,
  postRecommendationPrompt,
} from './recommendFlow.js'

// Adapter-side composition of the recommendation functions playback needs at
// queue-exhaustion/session-teardown time. playback/ must not import discord/
// (that would be a reverse dependency edge), so sessions.js receives these
// through getOrCreateSession's `recommendHooks` config instead of importing
// recommendFlow itself. Every getOrCreateSession caller in the Discord
// adapter passes this object.
export const recommendHooks = {
  cancelRecommendations,
  hasPendingForGuild,
  postRecommendationPrompt,
}
