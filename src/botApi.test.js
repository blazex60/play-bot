import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBotApi } from './botApi.js';
import { GuildQueue, createTrack } from './queue.js';

const TOKEN = 'test-token';

function makeTrack(title) {
  return createTrack({
    title,
    webpageUrl: `https://example.com/${title}`,
    duration: 60,
    requestedBy: 'tester',
    thumbnail: null,
  });
}

function makeSession({ channelId = 'voice-1' } = {}) {
  const queue = new GuildQueue();
  queue.add(makeTrack('current'));
  queue.add(makeTrack('next'));
  const calls = [];
  return {
    connection: { joinConfig: { channelId }, state: { status: 'ready' } },
    queue,
    player: {
      get status() {
        return 'playing';
      },
      pause() {
        calls.push('pause');
        return true;
      },
      resume() {
        calls.push('resume');
        return true;
      },
      async skip() {
        calls.push('skip');
      },
      async stop() {
        calls.push('stop');
      },
      setVolume(level) {
        calls.push(['volume', level]);
      },
      async playNext() {
        calls.push('playNext');
      },
      calls,
    },
  };
}

function makeMember({ userId = 'user-1', channelId = 'voice-1', roles = [] } = {}) {
  const channel = channelId ? { id: channelId, name: channelId } : null;
  return {
    id: userId,
    voice: { channelId, channel },
    roles: { cache: new Map(roles.map(roleId => [roleId, true])) },
  };
}

function makeClient(membersById, guild = { id: 'guild-1', voiceAdapterCreator: {} }) {
  return {
    guilds: {
      async fetch(guildId) {
        return {
          ...guild,
          id: guildId,
          members: {
            async fetch(userId) {
              const member = membersById.get(userId);
              if (!member) throw new Error(`unknown member ${userId}`);
              return member;
            },
          },
        };
      },
    },
  };
}

async function withApp({ sessions = new Map(), members = [makeMember()], adminRoleId = 'admin', getOrCreateSessionFn } = {}, run) {
  const membersById = new Map(members.map(member => [member.id, member]));
  const app = buildBotApi({
    client: makeClient(membersById),
    sessions,
    token: TOKEN,
    adminRoleId,
    getOrCreateSessionFn,
  });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

function authHeaders() {
  return { authorization: `Bearer ${TOKEN}` };
}

test('bot API rejects protected endpoints without bearer token', async () => {
  await withApp({}, async app => {
    const response = await app.inject({ method: 'GET', url: '/state/guild-1' });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'unauthorized' });
  });
});

test('bot API returns live state from a session', async () => {
  const session = makeSession();
  await withApp({ sessions: new Map([['guild-1', session]]) }, async app => {
    const response = await app.inject({ method: 'GET', url: '/state/guild-1', headers: authHeaders() });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().active, true);
    assert.equal(response.json().current.title, 'current');
    assert.equal(response.json().upcoming[0].title, 'next');
    assert.equal(response.json().playerStatus, 'playing');
  });
});

test('bot API exposes permission decisions', async () => {
  const session = makeSession();
  await withApp({ sessions: new Map([['guild-1', session]]) }, async app => {
    const response = await app.inject({
      method: 'GET',
      url: '/permission?guildId=guild-1&userId=user-1',
      headers: authHeaders(),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().basic, true);
  });
});

test('bot API control and queue endpoints mutate the session when permitted', async () => {
  const session = makeSession();
  await withApp({ sessions: new Map([['guild-1', session]]) }, async app => {
    const pause = await app.inject({
      method: 'POST',
      url: '/control/guild-1/pause',
      headers: authHeaders(),
      payload: { userId: 'user-1' },
    });
    assert.equal(pause.statusCode, 200);
    assert.equal(session.player.calls[0], 'pause');

    const volume = await app.inject({
      method: 'POST',
      url: '/control/guild-1/volume',
      headers: authHeaders(),
      payload: { userId: 'user-1', level: 0.5 },
    });
    assert.equal(volume.statusCode, 200);
    assert.deepEqual(session.player.calls[1], ['volume', 0.5]);

    const remove = await app.inject({
      method: 'POST',
      url: '/queue/guild-1/remove',
      headers: authHeaders(),
      payload: { userId: 'user-1', index: 0 },
    });
    assert.equal(remove.statusCode, 200);
    assert.equal(remove.json().ok, true);
    assert.deepEqual(session.queue.upcoming(), []);
  });
});

test('bot API import with no session joins the acting user VC and enqueues', async () => {
  const sessions = new Map();
  let createdArgs;
  const createdSession = makeSession();

  await withApp({
    sessions,
    getOrCreateSessionFn: async args => {
      createdArgs = args;
      sessions.set(args.guildId, createdSession);
      return createdSession;
    },
  }, async app => {
    const response = await app.inject({
      method: 'POST',
      url: '/import/guild-1/enqueue',
      headers: authHeaders(),
      payload: { userId: 'user-1', tracks: [makeTrack('imported')] },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(createdArgs.channel.id, 'voice-1');
    assert.equal(response.json().enqueuedCount, 1);
    assert.equal(createdSession.queue.upcoming().at(-1).title, 'imported');
  });
});

test('bot API import with no session rejects users outside VC', async () => {
  await withApp({ members: [makeMember({ channelId: null })] }, async app => {
    const response = await app.inject({
      method: 'POST',
      url: '/import/guild-1/enqueue',
      headers: authHeaders(),
      payload: { userId: 'user-1', tracks: [makeTrack('imported')] },
    });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { error: 'user_not_in_voice' });
  });
});
