import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  parseManifest,
  selectCase,
  validateManifestPaths,
} from '../../scripts/qa-manifest.mjs'
import { runQaCase } from '../../scripts/qa-task.mjs'

const resources = {
  port: 46100,
  database: 'p0-test-db',
  browserProfile: 'p0-test-browser',
  composeProject: 'p0-test-compose',
}

function manifestWith(step, overrides = {}) {
  return {
    version: 1,
    task: 'P0',
    cases: {
      happy: {
        resources,
        steps: [step],
        ...overrides,
      },
    },
  }
}

function successfulStep(overrides = {}) {
  return {
    id: 'success',
    command: [process.execPath, '-e', "console.log('EXPECTED_OK')"],
    cwd: '.',
    timeoutMs: 2_000,
    assertions: [{ kind: 'outputIncludes', value: 'EXPECTED_OK' }],
    cleanup: { absentPaths: [] },
    ...overrides,
  }
}

test('parseManifest accepts a complete deterministic manifest', () => {
  const manifest = parseManifest(manifestWith(successfulStep()))

  assert.equal(manifest.task, 'P0')
})

test('parseManifest rejects a case with no assertion', () => {
  const raw = manifestWith(successfulStep({ assertions: [] }))

  assert.throws(() => parseManifest(raw), /assertion/i)
})

test('parseManifest rejects a manifest with no cases', () => {
  assert.throws(
    () => parseManifest({ version: 1, task: 'P0', cases: {} }),
    /at least one case/i
  )
})

test('parseManifest rejects resource collisions between cases', () => {
  const raw = manifestWith(successfulStep())
  raw.cases.failure = {
    resources: { ...resources, database: 'another-db' },
    steps: [successfulStep()],
  }

  assert.throws(() => parseManifest(raw), /resource collision/i)
})

test('selectCase rejects unknown task and unknown case', () => {
  const manifest = parseManifest(manifestWith(successfulStep()))

  assert.throws(() => selectCase(manifest, 'task-1', 'happy'), /unknown task/i)
  assert.throws(() => selectCase(manifest, 'P0', 'missing'), /unknown case/i)
})

test('validateManifestPaths rejects a cwd that escapes the project', () => {
  const manifest = parseManifest(
    manifestWith(successfulStep({ cwd: '..' }))
  )

  assert.throws(
    () => validateManifestPaths(manifest, '/workspace/music-bot'),
    /escapes project root/i
  )
})

test('runQaCase rejects a cwd that escapes through a symlink', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'music-bot-qa-symlink-'))
  const projectRoot = join(sandbox, 'project')
  const outside = join(sandbox, 'outside')
  const evidenceDir = join(projectRoot, 'evidence')
  await mkdir(projectRoot)
  await mkdir(outside)
  await symlink(outside, join(projectRoot, 'linked'))
  try {
    const manifest = parseManifest(
      manifestWith(successfulStep({ cwd: 'linked' }))
    )

    await assert.rejects(
      runQaCase({ manifest, caseId: 'happy', projectRoot, evidenceDir }),
      /symbolic link/i
    )
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('runQaCase rejects a directory passed to node --test', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'music-bot-qa-directory-'))
  const evidenceDir = join(projectRoot, 'evidence')
  try {
    const manifest = parseManifest(
      manifestWith(
        successfulStep({
          command: [process.execPath, '--test', '.'],
          assertions: [{ kind: 'outputIncludes', value: 'never' }],
        })
      )
    )

    await assert.rejects(
      runQaCase({ manifest, caseId: 'happy', projectRoot, evidenceDir }),
      /directory argv/i
    )
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

test('runQaCase rejects misleading success output from a failing command', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'music-bot-qa-fake-'))
  const evidenceDir = join(projectRoot, 'evidence')
  try {
    const manifest = parseManifest(
      manifestWith(
        successfulStep({
          command: [
            process.execPath,
            '-e',
            "console.log('EXPECTED_OK'); process.exit(7)",
          ],
        })
      )
    )

    await assert.rejects(
      runQaCase({ manifest, caseId: 'happy', projectRoot, evidenceDir }),
      /exit code 7/i
    )
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

test('runQaCase rejects a leaked resource after a successful command', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'music-bot-qa-leak-'))
  const evidenceDir = join(projectRoot, 'evidence')
  const leakedPath = join(projectRoot, 'leaked-resource')
  try {
    const manifest = parseManifest(
      manifestWith(
        successfulStep({
          command: [
            process.execPath,
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(leakedPath)}, 'leak'); console.log('EXPECTED_OK')`,
          ],
          cleanup: { absentPaths: ['leaked-resource'] },
        })
      )
    )

    await assert.rejects(
      runQaCase({ manifest, caseId: 'happy', projectRoot, evidenceDir }),
      /leaked resource/i
    )
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

test('runQaCase terminates a hung command and records a timeout', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'music-bot-qa-timeout-'))
  const evidenceDir = join(projectRoot, 'evidence')
  try {
    const manifest = parseManifest(
      manifestWith(
        successfulStep({
          command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
          timeoutMs: 100,
        })
      )
    )

    await assert.rejects(
      runQaCase({ manifest, caseId: 'happy', projectRoot, evidenceDir }),
      /timed out/i
    )
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

test('manifest schema requires task, cases, assertions, cleanup, and resources', async () => {
  const schemaUrl = new URL('../../scripts/qa-manifest.schema.json', import.meta.url)
  const schema = JSON.parse(await readFile(schemaUrl, 'utf8'))

  assert.deepEqual(schema.required, ['version', 'task', 'cases'])
  assert.deepEqual(schema.$defs.case.required, ['resources', 'steps'])
  assert.equal(schema.properties.cases.propertyNames.pattern, '^[a-z0-9][a-z0-9-]*$')
  assert.deepEqual(
    schema.$defs.step.required,
    ['id', 'command', 'cwd', 'timeoutMs', 'assertions', 'cleanup']
  )
})
