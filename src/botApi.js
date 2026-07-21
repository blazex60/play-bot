import Fastify from 'fastify';

import { getOrCreateSession, cancelPendingRecommendations, bumpPlanToken } from './sessions.js';
import { resolveWebPermission } from './webPermission.js';
import {
  getGuildSettings,
  setAutoplayMode,
  setPersonalize,
  getCommandPermissions,
  setDefaultCommandPermission,
  setUserCommandPermission,
  setCommandVisibility,
} from './settings.js';
import { getEffectiveCommandVisibility } from './permissions.js';

const AUTOPLAY_MODES = new Set(['off', 'auto', 'recommend']);

const DEFAULT_BOT_API_PORT = 8787;
const LOOPBACK_HOST = '127.0.0.1';

function parsePort(value) {
  const port = Number.parseInt(value ?? String(DEFAULT_BOT_API_PORT), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid BOT_API_PORT: ${value}`);
  }
  return port;
}

function getBearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

function serializeSession(session, guildId = session?.guildId) {
  // autoplayMode/personalize are guild-level settings, not session state, so
  // they're reported even when the bot isn't currently in a VC for the guild.
  const settings = guildId ? getGuildSettings(guildId) : {};
  const autoplaySettings = { autoplayMode: settings.autoplayMode ?? 'off', personalize: settings.personalize ?? false };
  if (!session) return { active: false, ...autoplaySettings };
  return {
    active: true,
    current: session.queue.current,
    upcoming: session.queue.upcoming(),
    playerStatus: session.player.status ?? 'unknown',
    loopMode: session.queue.loopMode,
    ...autoplaySettings,
  };
}

async function fetchMember(client, guildId, userId) {
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(userId);
  return { guild, member };
}

async function resolvePermission({ client, sessions, guildId, userId, adminRoleId }) {
  const { member } = await fetchMember(client, guildId, userId);
  return resolveWebPermission({
    member,
    session: sessions.get(guildId),
    adminRoleId,
  });
}

function requireBodyUserId(request, reply) {
  const userId = request.body?.userId;
  if (typeof userId !== 'string' || userId.length === 0) {
    reply.code(400).send({ error: 'userId_required' });
    return null;
  }
  return userId;
}

function requireSession(sessions, guildId, reply) {
  const session = sessions.get(guildId);
  if (!session) {
    reply.code(404).send({ error: 'session_not_found' });
    return null;
  }
  return session;
}

async function requireAllowed({ client, sessions, guildId, userId, adminRoleId, reply }) {
  const permission = await resolvePermission({ client, sessions, guildId, userId, adminRoleId });
  if (!permission.allowed) {
    reply.code(403).send({ error: 'forbidden', permission });
    return null;
  }
  return permission;
}

// Admin-only endpoints (command permission matrix, reply visibility) always
// re-verify the caller has the guild's admin role, never the weaker
// basic (in-VC) permission that requireAllowed accepts.
async function requireAdmin({ client, sessions, guildId, userId, adminRoleId, reply }) {
  const permission = await resolvePermission({ client, sessions, guildId, userId, adminRoleId });
  if (!permission.extended) {
    reply.code(403).send({ error: 'forbidden', permission });
    return null;
  }
  return permission;
}

function requireAdminUserId(request, reply) {
  const adminUserId = request.body?.adminUserId ?? request.query?.adminUserId;
  if (typeof adminUserId !== 'string' || adminUserId.length === 0) {
    reply.code(400).send({ error: 'adminUserId_required' });
    return null;
  }
  return adminUserId;
}

async function enqueueTracks(session, tracks) {
  const wasEmpty = session.queue.isEmpty;
  for (const track of tracks) {
    session.queue.add(track);
  }
  if (wasEmpty && tracks.length > 0) {
    await session.player.playNext();
  }
  return {
    enqueuedCount: tracks.length,
    matchedCount: tracks.length,
    failedCount: 0,
    state: serializeSession(session),
  };
}

export function buildBotApi({
  client,
  sessions,
  token = process.env.BOT_API_TOKEN,
  adminRoleId = process.env.ADMIN_ROLE_ID,
  getOrCreateSessionFn = getOrCreateSession,
  commandNames = [],
} = {}) {
  if (!client) throw new Error('buildBotApi requires client');
  if (!sessions) throw new Error('buildBotApi requires sessions');

  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/healthz') return;
    if (!token || getBearerToken(request) !== token) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/state/:guildId', async (request) => {
    return serializeSession(sessions.get(request.params.guildId), request.params.guildId);
  });

  app.get('/permission', async (request, reply) => {
    const { guildId, userId } = request.query;
    if (typeof guildId !== 'string' || typeof userId !== 'string') {
      reply.code(400).send({ error: 'guildId_and_userId_required' });
      return;
    }
    return resolvePermission({ client, sessions, guildId, userId, adminRoleId });
  });

  app.post('/control/:guildId/:action', async (request, reply) => {
    const userId = requireBodyUserId(request, reply);
    if (!userId) return;
    const guildId = request.params.guildId;
    const action = request.params.action;

    // autoplayMode/personalize are guild-level settings, not playback state,
    // so they must be configurable even when the bot has no active session
    // for the guild (unlike every other action below, which mutates a live
    // player/queue and therefore requires one).
    if (action === 'autoplay') {
      const permission = await requireAllowed({ client, sessions, guildId, userId, adminRoleId, reply });
      if (!permission) return;
      const { mode, personalize } = request.body ?? {};
      if (mode !== undefined) {
        if (!AUTOPLAY_MODES.has(mode)) {
          reply.code(400).send({ error: 'invalid_autoplay_mode' });
          return;
        }
        await setAutoplayMode(guildId, mode);
      }
      if (personalize !== undefined) {
        await setPersonalize(guildId, personalize === true);
      }
      // Queue-exhaustion planning already in flight read the old settings
      // before its first await; invalidate it so it can't act on values the
      // user just changed from the dashboard.
      bumpPlanToken(guildId);
      return { ok: true, state: serializeSession(sessions.get(guildId), guildId) };
    }

    const session = requireSession(sessions, guildId, reply);
    if (!session) return;
    const permission = await requireAllowed({ client, sessions, guildId, userId, adminRoleId, reply });
    if (!permission) return;

    switch (action) {
      case 'pause':
        return { ok: session.player.pause(), state: serializeSession(session) };
      case 'resume':
        return { ok: session.player.resume(), state: serializeSession(session) };
      case 'skip':
        await session.player.skip();
        return { ok: true, state: serializeSession(session) };
      case 'stop':
        await session.player.stop();
        // Mirror commands/stop.js: invalidate any in-flight autoplay
        // planning and drop pending recommendation prompts, or a
        // continuation resolving after this stop could undo it.
        bumpPlanToken(guildId);
        cancelPendingRecommendations(guildId);
        return { ok: true, state: serializeSession(session) };
      default:
        reply.code(404).send({ error: 'unknown_action' });
    }
  });

  app.post('/queue/:guildId/:action', async (request, reply) => {
    const userId = requireBodyUserId(request, reply);
    if (!userId) return;
    const guildId = request.params.guildId;
    const session = requireSession(sessions, guildId, reply);
    if (!session) return;
    const permission = await requireAllowed({ client, sessions, guildId, userId, adminRoleId, reply });
    if (!permission) return;

    if (request.params.action === 'remove') {
      const index = Number.parseInt(String(request.body?.index), 10);
      const ok = session.queue.removeUpcoming(index);
      return { ok, state: serializeSession(session) };
    }
    if (request.params.action === 'move') {
      const fromIndex = Number.parseInt(String(request.body?.fromIndex), 10);
      const toIndex = Number.parseInt(String(request.body?.toIndex), 10);
      const ok = session.queue.moveUpcoming(fromIndex, toIndex);
      return { ok, state: serializeSession(session) };
    }
    reply.code(404).send({ error: 'unknown_action' });
  });

  app.post('/import/:guildId/enqueue', async (request, reply) => {
    const userId = requireBodyUserId(request, reply);
    if (!userId) return;
    const guildId = request.params.guildId;
    const tracks = request.body?.tracks;
    if (!Array.isArray(tracks)) {
      reply.code(400).send({ error: 'tracks_required' });
      return;
    }

    let session = sessions.get(guildId);
    if (session) {
      const permission = await requireAllowed({ client, sessions, guildId, userId, adminRoleId, reply });
      if (!permission) return;
      return enqueueTracks(session, tracks);
    }

    const { guild, member } = await fetchMember(client, guildId, userId);
    const channel = member.voice?.channel;
    if (!channel) {
      reply.code(409).send({ error: 'user_not_in_voice' });
      return;
    }

    session = await getOrCreateSessionFn({ guildId, guild, channel });
    return enqueueTracks(session, tracks);
  });

  function requireKnownCommand(command, reply) {
    if (typeof command !== 'string' || !commandNames.includes(command)) {
      reply.code(400).send({ error: 'unknown_command' });
      return false;
    }
    return true;
  }

  app.get('/admin/:guildId/permissions', async (request, reply) => {
    const adminUserId = requireAdminUserId(request, reply);
    if (!adminUserId) return;
    const guildId = request.params.guildId;
    if (!(await requireAdmin({ client, sessions, guildId, userId: adminUserId, adminRoleId, reply }))) return;
    const { defaults, overrides } = getCommandPermissions(guildId);
    return { commands: commandNames, defaults, overrides };
  });

  app.post('/admin/:guildId/permissions/default', async (request, reply) => {
    const adminUserId = requireAdminUserId(request, reply);
    if (!adminUserId) return;
    const guildId = request.params.guildId;
    if (!(await requireAdmin({ client, sessions, guildId, userId: adminUserId, adminRoleId, reply }))) return;
    const { command, value } = request.body ?? {};
    if (!requireKnownCommand(command, reply)) return;
    if (value !== 'allow' && value !== 'deny') {
      reply.code(400).send({ error: 'invalid_permission_value' });
      return;
    }
    await setDefaultCommandPermission(guildId, command, value);
    return { ok: true };
  });

  app.post('/admin/:guildId/permissions/user', async (request, reply) => {
    const adminUserId = requireAdminUserId(request, reply);
    if (!adminUserId) return;
    const guildId = request.params.guildId;
    if (!(await requireAdmin({ client, sessions, guildId, userId: adminUserId, adminRoleId, reply }))) return;
    const { userId, command, value } = request.body ?? {};
    if (typeof userId !== 'string' || userId.length === 0) {
      reply.code(400).send({ error: 'userId_required' });
      return;
    }
    if (!requireKnownCommand(command, reply)) return;
    if (value !== 'allow' && value !== 'deny' && value !== null) {
      reply.code(400).send({ error: 'invalid_permission_value' });
      return;
    }
    await setUserCommandPermission(guildId, userId, command, value);
    return { ok: true };
  });

  app.get('/admin/:guildId/visibility', async (request, reply) => {
    const adminUserId = requireAdminUserId(request, reply);
    if (!adminUserId) return;
    const guildId = request.params.guildId;
    if (!(await requireAdmin({ client, sessions, guildId, userId: adminUserId, adminRoleId, reply }))) return;
    const visibility = Object.fromEntries(
      commandNames.map((name) => [name, getEffectiveCommandVisibility(guildId, name)])
    );
    return visibility;
  });

  app.post('/admin/:guildId/visibility', async (request, reply) => {
    const adminUserId = requireAdminUserId(request, reply);
    if (!adminUserId) return;
    const guildId = request.params.guildId;
    if (!(await requireAdmin({ client, sessions, guildId, userId: adminUserId, adminRoleId, reply }))) return;
    const { command, value } = request.body ?? {};
    if (!requireKnownCommand(command, reply)) return;
    if (value !== 'public' && value !== 'personal') {
      reply.code(400).send({ error: 'invalid_visibility_value' });
      return;
    }
    await setCommandVisibility(guildId, command, value);
    return { ok: true };
  });

  return app;
}

export async function startBotApi(options) {
  const app = buildBotApi(options);
  const port = parsePort(process.env.BOT_API_PORT);
  await app.listen({ host: LOOPBACK_HOST, port });
  console.log(`[bot-api] listening on http://${LOOPBACK_HOST}:${port}`);
  return app;
}
