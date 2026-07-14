export function getSessionUser(request) {
  const user = request.user ?? request.session?.user ?? request.auth?.user
  const discordId = user?.discordId ?? user?.discord_id ?? user?.id
  if (!discordId) {
    const error = new Error('Authentication required')
    error.statusCode = 401
    throw error
  }
  return { ...user, discordId }
}

export async function callBot(botClient, method, path, body) {
  if (typeof botClient?.request === 'function') return botClient.request(method, path, body)
  if (method === 'GET' && typeof botClient?.get === 'function') return botClient.get(path)
  if (method === 'POST' && typeof botClient?.post === 'function') return botClient.post(path, body)
  throw new Error('botClient must expose request(method, path, body), get(path), or post(path, body)')
}

export async function requireBotPermission({ botClient, guildId, userId }) {
  const permission = typeof botClient?.getPermission === 'function'
    ? await botClient.getPermission({ guildId, userId })
    : await callBot(botClient, 'GET', `/permission?guildId=${encodeURIComponent(guildId)}&userId=${encodeURIComponent(userId)}`)

  if (!permission?.basic && !permission?.extended) {
    const error = new Error('Forbidden')
    error.statusCode = 403
    throw error
  }

  return permission
}

export function bindRouteError(reply, error) {
  const statusCode = error.statusCode ?? error.status ?? 500
  return reply.code(statusCode).send({
    error: error.code ?? error.message ?? 'internal_error',
    message: error.publicMessage ?? error.message,
  })
}

export function nowUnix() {
  return Math.floor(Date.now() / 1000)
}
