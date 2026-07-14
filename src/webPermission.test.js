import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveWebPermission } from './webPermission.js';

function member({ channelId = null, roles = [] } = {}) {
  return {
    voice: { channelId },
    roles: { cache: new Map(roles.map(roleId => [roleId, true])) },
  };
}

function session(channelId = 'voice-1') {
  return {
    connection: { joinConfig: { channelId } },
  };
}

test('resolveWebPermission: VC member gets basic permission', () => {
  assert.deepEqual(
    resolveWebPermission({ member: member({ channelId: 'voice-1' }), session: session('voice-1'), adminRoleId: 'admin' }),
    { basic: true, extended: false, allowed: true, reason: null }
  );
});

test('resolveWebPermission: non-member in another VC is denied without Admin', () => {
  assert.deepEqual(
    resolveWebPermission({ member: member({ channelId: 'voice-2' }), session: session('voice-1'), adminRoleId: 'admin' }),
    { basic: false, extended: false, allowed: false, reason: 'not_in_voice' }
  );
});

test('resolveWebPermission: Admin bypass works with no session', () => {
  assert.deepEqual(
    resolveWebPermission({ member: member({ roles: ['admin'] }), session: undefined, adminRoleId: 'admin' }),
    { basic: false, extended: true, allowed: true, reason: null }
  );
});

test('resolveWebPermission: non-Admin with no session is denied basic permission', () => {
  assert.deepEqual(
    resolveWebPermission({ member: member(), session: undefined, adminRoleId: 'admin' }),
    { basic: false, extended: false, allowed: false, reason: 'not_in_voice' }
  );
});
