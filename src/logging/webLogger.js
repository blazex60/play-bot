import { createLogger } from './logger.js'
import { lazyLogger } from './lazy.js'
import { installProcessHandlers as installHandlers } from './processHandlers.js'

let base = null
const children = new Map()

/** Lazily-created process-wide logger for the music-web service. */
export function getWebLogger() {
  base ??= createLogger('music-web')
  return base
}

/** Child logger tagged with `component` (cached). Safe to call at import time. */
export function getLogger(component) {
  let child = children.get(component)
  if (!child) {
    child = lazyLogger(() => getWebLogger().child({ component }))
    children.set(component, child)
  }
  return child
}

export function installProcessHandlers(options) {
  installHandlers(getWebLogger(), options)
}
