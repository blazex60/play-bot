export function bunExecutable() {
  return process.versions.bun ? process.execPath : 'bun'
}

export function nodeExecutable() {
  return process.versions.bun ? 'node' : process.execPath
}

export function assertSupportedBunVersion(version = process.versions.bun) {
  if (!version) {
    throw new Error('Bun is required to run tests; received no process.versions.bun')
  }
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0], 10)
  if (!Number.isInteger(major) || major < 20) {
    throw new Error(`Node.js 20 or newer is required; received ${version}`)
  }
}
