import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  parseManifest,
  selectCase,
  validateManifestPaths,
} from '../../scripts/qa-manifest.mjs'
import { runQaCase } from '../../scripts/qa-task.mjs'

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const manifestRoot = resolve(fileURLToPath(new URL('manifests', import.meta.url)))

async function readManifest(name) {
  return JSON.parse(await readFile(join(manifestRoot, name), 'utf8'))
}

test('invalid manifest fixtures reject malformed JSON, missing assertions, and collisions', async () => {
  const missingAssertion = await readManifest('invalid-missing-assertion.json')
  const collision = await readManifest('invalid-collision.json')

  await assert.rejects(
    readManifest('invalid-malformed.json'),
    /JSON/
  )
  assert.throws(
    () => parseManifest(missingAssertion),
    /assertion/i
  )
  assert.throws(
    () => parseManifest(collision),
    /resource collision/i
  )
})

test('invalid manifest fixtures reject path escape and unknown selectors', async () => {
  const manifest = parseManifest(await readManifest('invalid-path-escape.json'))

  assert.throws(() => validateManifestPaths(manifest, projectRoot), /escapes project root/i)
  assert.throws(() => selectCase(manifest, '1', 'failure'), /unknown task/i)
  assert.throws(() => selectCase(manifest, 'P0', 'missing'), /unknown case/i)
})

for (const [name, errorPattern] of [
  ['invalid-directory-argv.json', /directory argv/i],
  ['invalid-fake-success.json', /exit code 7/i],
  ['invalid-leaked-resource.json', /leaked resource/i],
  ['invalid-hung-browser.json', /timed out/i],
]) {
  test(`${name} fails without contaminating persistent evidence`, async () => {
    const sandbox = await mkdtemp(join(projectRoot, '.qa-invalid-fixture-'))
    const evidenceDir = join(sandbox, 'evidence')
    try {
      const manifest = parseManifest(await readManifest(name))

      await assert.rejects(
        runQaCase({ manifest, caseId: 'failure', projectRoot, evidenceDir }),
        errorPattern
      )
    } finally {
      await rm(resolve(projectRoot, '.qa-p0-leak'), { force: true })
      await rm(sandbox, { recursive: true, force: true })
    }
  })
}
