import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createChildEnvironment,
  redactOutput,
  terminateProcess,
  writeExclusiveFile,
} from '../../scripts/qa-safety.mjs'

test('createChildEnvironment excludes credentials while preserving runtime paths', () => {
  const environment = createChildEnvironment({
    PATH: '/usr/bin',
    HOME: '/tmp/home',
    DISCORD_TOKEN: 'do-not-copy',
  })

  assert.deepEqual(environment, { PATH: '/usr/bin', HOME: '/tmp/home', CI: '1' })
})

test('redactOutput removes secret-like environment values from evidence', () => {
  const output = redactOutput('token=super-secret-value', {
    DISCORD_TOKEN: 'super-secret-value',
    PATH: '/usr/bin',
  })

  assert.equal(output, 'token=[REDACTED]')
})

test('terminateProcess tolerates a process that exits during timeout handling', () => {
  assert.doesNotThrow(() => terminateProcess({ exitCode: null, pid: 99_999_999 }))
})

test('writeExclusiveFile rejects a symlink without changing its target', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'music-bot-qa-exclusive-'))
  const target = join(sandbox, 'outside-target')
  const link = join(sandbox, 'evidence.log')
  await writeFile(target, 'original')
  await symlink(target, link)
  try {
    await assert.rejects(writeExclusiveFile(link, 'replacement'), /collision/i)
    assert.equal(await readFile(target, 'utf8'), 'original')
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})
