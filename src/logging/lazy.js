/**
 * A logger stand-in that defers creating the real (file-backed) logger until
 * the first call, so merely importing a module never opens log files. This
 * matters when a process imports modules that belong to the other service.
 */
export function lazyLogger(resolve) {
  let real = null
  const target = () => (real ??= resolve())
  return new Proxy({}, {
    get(_obj, prop) {
      const value = target()[prop]
      return typeof value === 'function' ? value.bind(target()) : value
    },
  })
}
