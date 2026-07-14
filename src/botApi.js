import Fastify from 'fastify';

import { getOrCreateSession } from './sessions.js';
import { resolveWebPermission } from './webPermission.js';

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

function serializeSession(session) {
  if (!session) return { active: false };
  return {
    active: true,
    current: session.queue.current,
    upcoming: session.queue.upcoming(),
    playerStatus: session.player.status ?? 'unknown',
    loopMode: session.queue.loopMode,
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
    return serializeSession(sessions.get(request.params.guildId));
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
    const session = requireSession(sessions, guildId, reply);
    if (!session) return;
    const permission = await requireAllowed({ client, sessions, guildId, userId, adminRoleId, reply });
    if (!permission) return;

    switch (request.params.action) {
      case 'pause':
        return { ok: session.player.pause(), state: serializeSession(session) };
      case 'resume':
        return { ok: session.player.resume(), state: serializeSession(session) };
      case 'skip':
        await session.player.skip();
        return { ok: true, state: serializeSession(session) };
      case 'stop':
        await session.player.stop();
        return { ok: true, state: serializeSession(session) };
      case 'volume': {
        const level = Number(request.body?.level);
        if (!Number.isFinite(level)) {
          reply.code(400).send({ error: 'level_required' });
          return;
        }
        if (typeof session.player.setVolume !== 'function') {
          reply.code(501).send({ error: 'volume_not_supported' });
          return;
        }
        session.player.setVolume(level);
        return { ok: true, state: serializeSession(session) };
      }
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

  return app;
}

export async function startBotApi(options) {
  const app = buildBotApi(options);
  const port = parsePort(process.env.BOT_API_PORT);
  await app.listen({ host: LOOPBACK_HOST, port });
  console.log(`[bot-api] listening on http://${LOOPBACK_HOST}:${port}`);
  return app;
}
