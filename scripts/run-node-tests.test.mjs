import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assertSupportedNodeVersion,
  buildNodeTestArguments,
  discoverServerTests,
} from './run-node-tests.mjs'

async function createFile(root, relativePath) {
  const path = join(root, relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, '')
}

test('discoverServerTests returns sorted test files when forbidden roots exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'music-bot-enumerator-'))
  try {
    await Promise.all([
      createFile(root, 'src/z.test.js'),
      createFile(root, 'src/a.test.mjs'),
      createFile(root, 'scripts/runner.test.mjs'),
      createFile(root, 'node_modules/pkg/ignored.test.js'),
      createFile(root, 'test/browser/ignored.test.js'),
      createFile(root, 'test/container/ignored.test.mjs'),
      createFile(root, 'test/qa/fixtures/ignored.test.js'),
      createFile(root, 'test/qa/manifests/ignored.test.js'),
      createFile(root, 'web/src/ignored.test.js'),
      createFile(root, 'src/not-a-test.js'),
    ])

    const files = await discoverServerTests(root)

    assert.deepEqual(files, [
      'scripts/runner.test.mjs',
      'src/a.test.mjs',
      'src/z.test.js',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('buildNodeTestArguments rejects directory argv when a directory resembles a test', async () => {
  const root = await mkdtemp(join(tmpdir(), 'music-bot-directory-argv-'))
  try {
    await mkdir(join(root, 'fake.test.js'))

    await assert.rejects(
      buildNodeTestArguments(root, ['fake.test.js']),
      /not a regular test file/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('buildNodeTestArguments rejects unsorted input before invoking node test', async () => {
  const root = await mkdtemp(join(tmpdir(), 'music-bot-unsorted-argv-'))
  try {
    await createFile(root, 'z.test.js')
    await createFile(root, 'a.test.js')

    await assert.rejects(
      buildNodeTestArguments(root, ['z.test.js', 'a.test.js']),
      /sorted/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('assertSupportedNodeVersion rejects Node versions below 20', () => {
  assert.throws(() => assertSupportedNodeVersion('19.9.0'), /Node.js 20 or newer/)
  assert.doesNotThrow(() => assertSupportedNodeVersion('20.0.0'))
})
