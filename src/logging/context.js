// The entry point installs a process-local logger; libraries stay quiet in tests.
let current = { info() {}, warn() {}, error() {}, debug() {} }
export function setProcessLogger(logger) { current = logger }
export const log = {
  info: (...args) => current.info(...args),
  warn: (...args) => current.warn(...args),
  error: (...args) => current.error(...args),
  debug: (...args) => current.debug(...args),
}
