import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

const allowedEnvironmentKeys = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG',
  'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'PLAYWRIGHT_BROWSERS_PATH', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR', 'LOCALAPPDATA', 'APPDATA',
  'USERPROFILE',
]

export function createChildEnvironment(source = process.env) {
  const environment = {}
  for (const key of allowedEnvironmentKeys) {
    if (source[key] !== undefined) {
      environment[key] = source[key]
    }
  }
  environment.CI = '1'
  return environment
}

export function redactOutput(output, environment = process.env) {
  let redacted = output
  for (const [key, value] of Object.entries(environment)) {
    if (/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH|PRIVATE_KEY)/i.test(key) && value?.length >= 8) {
      redacted = redacted.split(value).join('[REDACTED]')
    }
  }
  return redacted
}

export async function writeExclusiveFile(path, content) {
  const flags = constants.O_CREAT
    | constants.O_EXCL
    | constants.O_WRONLY
    | (constants.O_NOFOLLOW ?? 0)
  let handle
  try {
    handle = await open(path, flags, 0o600)
    await handle.writeFile(content)
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['EEXIST', 'ELOOP'].includes(error.code)) {
      throw new Error(`Evidence collision: ${path}`)
    }
    throw error
  } finally {
    await handle?.close()
  }
}

export async function assertNoSymbolicLinks(anchor, candidate, label) {
  const relativePath = relative(anchor, candidate)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes its allowed root: ${candidate}`)
  }
  let current = anchor
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = resolve(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${current}`)
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return
      }
      throw error
    }
  }
}

export function terminateProcess(child) {
  if (child.exitCode !== null || child.pid === undefined) {
    return
  }
  if (process.platform === 'win32') {
    child.kill('SIGKILL')
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error
    }
  }
}
