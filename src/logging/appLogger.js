import { createLogger } from './logger.js'
import { lazyLogger } from './lazy.js'
import { installProcessHandlers as installHandlers } from './processHandlers.js'

// One logger (and one file sink) per process. Modules shared by the bot and
// web processes (e.g. media/search.js) call getLogger() without knowing which
// process they run in, so the service name is a process-level setting:
// 'music-bot' by default, switched by the web entrypoint before anything logs.
let service = 'music-bot'
let base = null
const children = new Map()

/** Name the service this process logs as. Must run before the first log call. */
export function setLogService(name) {
  if (base && name !== service) {
    throw new Error(`setLogService('${name}') called after the '${service}' logger was created`)
  }
  service = name
}

export function getAppLogger() {
  base ??= createLogger(service)
  return base
}

/** Child logger tagged with `component` (cached). Safe to call at import time. */
export function getLogger(component) {
  let child = children.get(component)
  if (!child) {
    child = lazyLogger(() => getAppLogger().child({ component }))
    children.set(component, child)
  }
  return child
}

export function installProcessHandlers(options) {
  installHandlers(getAppLogger(), options)
}
