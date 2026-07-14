export function resolveWebPermission({ member, session, adminRoleId }) {
  const roleCache = member?.roles?.cache;
  const extended = Boolean(adminRoleId && roleCache?.has?.(adminRoleId));
  const targetChannelId = session?.connection?.joinConfig?.channelId;
  const memberChannelId = member?.voice?.channelId ?? member?.voice?.channel?.id ?? null;
  const basic = Boolean(targetChannelId && memberChannelId === targetChannelId);

  return {
    basic,
    extended,
    allowed: basic || extended,
    reason: basic || extended ? null : 'not_in_voice',
  };
}
