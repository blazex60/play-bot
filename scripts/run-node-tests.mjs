import { spawnSync } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertSupportedBunVersion, bunExecutable } from './bun-cli.mjs'

const serverExcludedParts = new Set([
  'node_modules',
  'fixtures',
  'browser',
  'container',
  'manifests',
  'dist',
  'build',
])

// Only the top-level frontend app (<root>/web) is excluded from the server
// test suite. This must NOT be a generic basename match against 'web' -- the
// backend web server lives at <root>/src/web/ and its tests (auth, routes,
// index.test.js) need to run. A prior version of this exclusion matched any
// directory named 'web' anywhere in the tree, which silently dropped every
// src/web/**/*.test.js file from `bun run test:server` / `bun run check`.
const topLevelExcludedDirs = new Set(['web'])

function toPortablePath(path) {
  return path.split(sep).join('/')
}

async function collectTests(root, directory, excludedParts, files) {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    const relativePath = toPortablePath(relative(root, path))
    if (entry.isDirectory()) {
      const isExcluded = excludedParts.has(entry.name)
        || (directory === root && topLevelExcludedDirs.has(entry.name))
      if (!isExcluded) {
        await collectTests(root, path, excludedParts, files)
      }
    } else if (entry.isFile() && /\.test\.(?:js|mjs)$/.test(entry.name)) {
      files.push(relativePath)
    }
  }
}

export async function discoverServerTests(projectRoot) {
  const files = []
  await collectTests(projectRoot, projectRoot, serverExcludedParts, files)
  return files.sort()
}

export { assertSupportedBunVersion, assertSupportedNodeVersion } from './bun-cli.mjs'

async function discoverContainerTests(projectRoot) {
  const containerRoot = resolve(projectRoot, 'test/container')
  try {
    const files = []
    await collectTests(projectRoot, containerRoot, new Set(['fixtures']), files)
    return files.sort()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

export async function buildBunTestArguments(projectRoot, files) {
  const sortedFiles = [...files].sort()
  if (!files.every((file, index) => file === sortedFiles[index])) {
    throw new Error('Test files must be sorted before invocation')
  }
  for (const file of files) {
    const info = await stat(resolve(projectRoot, file))
    if (!info.isFile() || !/\.test\.(?:js|mjs)$/.test(file)) {
      throw new Error(`Test argv is not a regular test file: ${file}`)
    }
  }
  return files
}

async function main() {
  assertSupportedBunVersion()
  const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const suiteIndex = process.argv.indexOf('--suite')
  const suite = suiteIndex === -1 ? 'server' : process.argv[suiteIndex + 1]
  let files
  if (suite === 'server') {
    files = await discoverServerTests(projectRoot)
  } else if (suite === 'container') {
    files = await discoverContainerTests(projectRoot)
  } else {
    throw new Error(`Unknown test suite: ${suite}`)
  }
  if (files.length === 0) {
    if (suite === 'container') {
      console.log('CONTAINER_TEST_ROUTE_READY: no container tests yet')
      return
    }
    throw new Error('No server tests discovered')
  }
  console.log(`NODE_TEST_FILES=${JSON.stringify(files)}`)
  const result = spawnSync(
    bunExecutable(),
    ['test', ...await buildBunTestArguments(projectRoot, files)],
    { cwd: projectRoot, stdio: 'inherit' }
  )
  if (result.error) {
    throw result.error
  }
  process.exitCode = result.status ?? 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
