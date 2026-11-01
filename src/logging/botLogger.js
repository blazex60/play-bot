import { createLogger } from './logger.js'
import { lazyLogger } from './lazy.js'
import { installProcessHandlers as installHandlers } from './processHandlers.js'

let base = null
const children = new Map()

/** Lazily-created process-wide logger for the music-bot service. */
export function getBotLogger() {
  base ??= createLogger('music-bot')
  return base
}

/** Child logger tagged with `component` (cached). Safe to call at import time. */
export function getLogger(component) {
  let child = children.get(component)
  if (!child) {
    child = lazyLogger(() => getBotLogger().child({ component }))
    children.set(component, child)
  }
  return child
}

/** Install process-level handlers for the bot (see processHandlers.js). */
export function installProcessHandlers(options) {
  installHandlers(getBotLogger(), options)
}
