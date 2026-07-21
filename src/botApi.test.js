import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildBotApi } from './botApi.js';
import { GuildQueue, createTrack } from './queue.js';
import { configureSettingsPathForTest, setDefaultCommandPermission } from './settings.js';

const TOKEN = 'test-token';

async function withTempSettings(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'music-bot-botapi-test-'));
  configureSettingsPathForTest(join(dir, 'data', 'guild-settings.json'));
  try {
    await fn();
  } finally {
    await rm(dir, { recursive: true, force: true });
    // settings.js's guildSettings Map is module-level state shared by every
    // test in this file, several of which reuse guildId 'guild-1' without
    // going through withTempSettings themselves — reset it here (not just
    // delete the now-unused temp dir) so a permission set above can't leak
    // into whichever test happens to run next.
    configureSettingsPathForTest(join(dir, 'data', 'guild-settings-unused.json'));
  }
}

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

async function withApp({ sessions = new Map(), members = [makeMember()], adminRoleId = 'admin', getOrCreateSessionFn, commandNames } = {}, run) {
  const membersById = new Map(members.map(member => [member.id, member]));
  const app = buildBotApi({
    client: makeClient(membersById),
    sessions,
    token: TOKEN,
    adminRoleId,
    getOrCreateSessionFn,
    commandNames,
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

test('bot API control/queue endpoints reject a denied command even though basic (in-VC) permission is granted', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'pause', 'deny');
    const session = makeSession();
    await withApp({ sessions: new Map([['guild-1', session]]) }, async app => {
      const pause = await app.inject({
        method: 'POST',
        url: '/control/guild-1/pause',
        headers: authHeaders(),
        payload: { userId: 'user-1' },
      });
      assert.equal(pause.statusCode, 403, 'a denied command must be rejected even by the bot API itself, not just the dashboard route');
      assert.equal(session.player.calls.length, 0, 'must not have paused');
    });
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

test('bot API import with no session rejects a user denied the play command, even though they are in the VC', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'play', 'deny');
    const sessions = new Map();
    let createSessionCalled = false;
    await withApp({
      sessions,
      getOrCreateSessionFn: async args => {
        createSessionCalled = true;
        const session = makeSession();
        sessions.set(args.guildId, session);
        return session;
      },
    }, async app => {
      const response = await app.inject({
        method: 'POST',
        url: '/import/guild-1/enqueue',
        headers: authHeaders(),
        payload: { userId: 'user-1', tracks: [makeTrack('imported')] },
      });
      assert.equal(response.statusCode, 403, 'denied play must block starting a new session too, not just adding to an existing one');
      assert.equal(createSessionCalled, false, 'must not have joined the VC / created a session');
    });
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

test('bot API admin endpoints reject non-admin users', async () => {
  await withTempSettings(async () => {
    await withApp({ members: [makeMember({ userId: 'user-1', roles: [] })], commandNames: ['skip', 'play'] }, async app => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/guild-1/permissions?adminUserId=user-1',
        headers: authHeaders(),
      });
      assert.equal(response.statusCode, 403);
    });
  });
});

test('bot API admin endpoints require adminUserId', async () => {
  await withTempSettings(async () => {
    await withApp({ commandNames: ['skip'] }, async app => {
      const response = await app.inject({ method: 'GET', url: '/admin/guild-1/permissions', headers: authHeaders() });
      assert.equal(response.statusCode, 400);
    });
  });
});

test('bot API admin permission endpoints read and write the command permission matrix', async () => {
  await withTempSettings(async () => {
    const members = [makeMember({ userId: 'admin-1', roles: ['admin'] }), makeMember({ userId: 'user-1', roles: [] })];
    await withApp({ members, commandNames: ['skip', 'play'] }, async app => {
      const initial = await app.inject({
        method: 'GET',
        url: '/admin/guild-1/permissions?adminUserId=admin-1',
        headers: authHeaders(),
      });
      assert.equal(initial.statusCode, 200);
      assert.deepEqual(initial.json(), { commands: ['skip', 'play'], defaults: {}, overrides: {} });

      const unknownCommand = await app.inject({
        method: 'POST',
        url: '/admin/guild-1/permissions/default',
        headers: authHeaders(),
        payload: { adminUserId: 'admin-1', command: 'bogus', value: 'deny' },
      });
      assert.equal(unknownCommand.statusCode, 400);

      const setDefault = await app.inject({
        method: 'POST',
        url: '/admin/guild-1/permissions/default',
        headers: authHeaders(),
        payload: { adminUserId: 'admin-1', command: 'skip', value: 'deny' },
      });
      assert.equal(setDefault.statusCode, 200);

      const setOverride = await app.inject({
        method: 'POST',
        url: '/admin/guild-1/permissions/user',
        headers: authHeaders(),
        payload: { adminUserId: 'admin-1', userId: 'user-1', command: 'skip', value: 'allow' },
      });
      assert.equal(setOverride.statusCode, 200);

      const after = await app.inject({
        method: 'GET',
        url: '/admin/guild-1/permissions?adminUserId=admin-1',
        headers: authHeaders(),
      });
      assert.deepEqual(after.json(), {
        commands: ['skip', 'play'],
        defaults: { skip: 'deny' },
        overrides: { 'user-1': { skip: 'allow' } },
      });
    });
  });
});

test('bot API admin visibility endpoints read effective values and write overrides', async () => {
  await withTempSettings(async () => {
    const members = [makeMember({ userId: 'admin-1', roles: ['admin'] })];
    await withApp({ members, commandNames: ['skip', 'nowplaying'] }, async app => {
      const initial = await app.inject({
        method: 'GET',
        url: '/admin/guild-1/visibility?adminUserId=admin-1',
        headers: authHeaders(),
      });
      assert.equal(initial.statusCode, 200);
      assert.deepEqual(initial.json(), { skip: 'public', nowplaying: 'personal' });

      const setVisibility = await app.inject({
        method: 'POST',
        url: '/admin/guild-1/visibility',
        headers: authHeaders(),
        payload: { adminUserId: 'admin-1', command: 'nowplaying', value: 'public' },
      });
      assert.equal(setVisibility.statusCode, 200);

      const after = await app.inject({
        method: 'GET',
        url: '/admin/guild-1/visibility?adminUserId=admin-1',
        headers: authHeaders(),
      });
      assert.deepEqual(after.json(), { skip: 'public', nowplaying: 'public' });
    });
  });
});

test('GET /command-permission reports allowed by default and denied once the admin panel sets a deny', async () => {
  await withTempSettings(async () => {
    const members = [makeMember({ userId: 'admin-1', roles: ['admin'] }), makeMember({ userId: 'user-1', roles: [] })];
    await withApp({ members, commandNames: ['pause'] }, async app => {
      const beforeDeny = await app.inject({
        method: 'GET',
        url: '/command-permission?guildId=guild-1&userId=user-1&command=pause',
        headers: authHeaders(),
      });
      assert.equal(beforeDeny.statusCode, 200);
      assert.deepEqual(beforeDeny.json(), { allowed: true });

      await app.inject({
        method: 'POST',
        url: '/admin/guild-1/permissions/default',
        headers: authHeaders(),
        payload: { adminUserId: 'admin-1', command: 'pause', value: 'deny' },
      });

      const afterDeny = await app.inject({
        method: 'GET',
        url: '/command-permission?guildId=guild-1&userId=user-1&command=pause',
        headers: authHeaders(),
      });
      assert.deepEqual(afterDeny.json(), { allowed: false }, 'a dashboard action for a denied command must not be reported as allowed');
    });
  });
});

test('GET /command-permission: an admin-role member always bypasses a deny', async () => {
  await withTempSettings(async () => {
    const members = [makeMember({ userId: 'admin-1', roles: ['admin'] })];
    await withApp({ members, adminRoleId: 'admin', commandNames: ['pause'] }, async app => {
      await app.inject({
        method: 'POST',
        url: '/admin/guild-1/permissions/default',
        headers: authHeaders(),
        payload: { adminUserId: 'admin-1', command: 'pause', value: 'deny' },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/command-permission?guildId=guild-1&userId=admin-1&command=pause',
        headers: authHeaders(),
      });
      assert.deepEqual(response.json(), { allowed: true }, 'admin-role holders must bypass a command deny, same as checkCommandAllowed on the Discord side');
    });
  });
});

test('GET /command-permission requires guildId, userId, and command', async () => {
  await withApp({}, async app => {
    const response = await app.inject({
      method: 'GET',
      url: '/command-permission?guildId=guild-1&userId=user-1',
      headers: authHeaders(),
    });
    assert.equal(response.statusCode, 400);
  });
});
