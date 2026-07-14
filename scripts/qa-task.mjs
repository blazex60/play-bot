import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseManifest,
  selectCase,
  validateManifestPaths,
} from './qa-manifest.mjs'
import { assertSupportedNodeVersion } from './run-node-tests.mjs'
import {
  assertNoSymbolicLinks,
  createChildEnvironment,
  redactOutput,
  terminateProcess,
  writeExclusiveFile,
} from './qa-safety.mjs'

export {
  createChildEnvironment,
  redactOutput,
  terminateProcess,
  writeExclusiveFile,
} from './qa-safety.mjs'

async function validatePhysicalPaths(manifest, projectRoot) {
  for (const qaCase of Object.values(manifest.cases)) {
    for (const step of qaCase.steps) {
      await assertNoSymbolicLinks(projectRoot, resolve(projectRoot, step.cwd), 'Step cwd')
      for (const assertion of step.assertions) {
        if (assertion.kind === 'pathExists') {
          await assertNoSymbolicLinks(projectRoot, resolve(projectRoot, assertion.path), 'Assertion path')
        }
      }
      for (const path of step.cleanup.absentPaths) {
        await assertNoSymbolicLinks(projectRoot, resolve(projectRoot, path), 'Cleanup path')
      }
    }
  }
}

async function assertNodeTestFiles(step, cwd) {
  const testFlag = step.command.indexOf('--test')
  if (testFlag === -1) {
    return
  }
  for (const argument of step.command.slice(testFlag + 1)) {
    if (argument.startsWith('-')) {
      continue
    }
    const path = resolve(cwd, argument)
    const linkInfo = await lstat(path)
    if (linkInfo.isSymbolicLink()) {
      throw new Error(`Symbolic link argv is forbidden for node --test: ${argument}`)
    }
    const info = await stat(path)
    if (info.isDirectory()) {
      throw new Error(`Directory argv is forbidden for node --test: ${argument}`)
    }
  }
}

function executeStep(step, cwd) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(step.command[0], step.command.slice(1), {
      cwd,
      detached: process.platform !== 'win32',
      env: createChildEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let timedOut = false
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    const timeout = setTimeout(() => {
      timedOut = true
      terminateProcess(child)
    }, step.timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectResult(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      resolveResult({ code: code ?? 1, signal, output, timedOut })
    })
  })
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function assertStep(step, result, projectRoot) {
  if (result.timedOut) {
    throw new Error(`QA step timed out after ${step.timeoutMs}ms: ${step.id}`)
  }
  if (result.code !== 0) {
    throw new Error(`QA step ${step.id} exited with exit code ${result.code}`)
  }
  for (const assertion of step.assertions) {
    if (assertion.kind === 'outputIncludes' && !result.output.includes(assertion.value)) {
      throw new Error(`Missing output assertion for ${step.id}: ${assertion.value}`)
    }
    if (assertion.kind === 'pathExists' && !(await pathExists(resolve(projectRoot, assertion.path)))) {
      throw new Error(`Missing artifact assertion for ${step.id}: ${assertion.path}`)
    }
  }
  for (const path of step.cleanup.absentPaths) {
    if (await pathExists(resolve(projectRoot, path))) {
      throw new Error(`Leaked resource after ${step.id}: ${path}`)
    }
  }
}

export async function runQaCase({ manifest, caseId, projectRoot, evidenceDir }) {
  validateManifestPaths(manifest, projectRoot)
  await validatePhysicalPaths(manifest, projectRoot)
  const qaCase = selectCase(manifest, manifest.task, caseId)
  await assertNoSymbolicLinks(resolve(projectRoot, '..'), evidenceDir, 'Evidence path')
  await mkdir(evidenceDir, { recursive: true })
  const receiptPath = resolve(evidenceDir, `${caseId}.json`)
  if (await pathExists(receiptPath)) {
    throw new Error(`Stale evidence collision: ${receiptPath}`)
  }
  const steps = []
  for (const step of qaCase.steps) {
    const cwd = resolve(projectRoot, step.cwd)
    await assertNodeTestFiles(step, cwd)
    const logPath = resolve(evidenceDir, `${caseId}-${step.id}.log`)
    if (await pathExists(logPath)) {
      throw new Error(`Manifest collision: ${logPath}`)
    }
    const result = await executeStep(step, cwd)
    const safeOutput = redactOutput(result.output)
    await assertNoSymbolicLinks(resolve(projectRoot, '..'), evidenceDir, 'Evidence path')
    await writeExclusiveFile(logPath, safeOutput)
    await assertStep(step, { ...result, output: safeOutput }, projectRoot)
    steps.push({
      id: step.id,
      command: step.command.map((argument) => redactOutput(argument)),
      cwd: relative(projectRoot, cwd) || '.',
      exitStatus: result.code,
      assertions: step.assertions.map((assertion) => {
        if (assertion.kind === 'outputIncludes') {
          return { ...assertion, value: redactOutput(assertion.value) }
        }
        return assertion
      }),
      artifactPath: relative(projectRoot, logPath),
      cleanup: step.cleanup,
    })
  }
  const receipt = {
    task: manifest.task,
    case: caseId,
    resources: qaCase.resources,
    steps,
  }
  await assertNoSymbolicLinks(resolve(projectRoot, '..'), evidenceDir, 'Evidence path')
  await writeExclusiveFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  return receipt
}

async function main() {
  assertSupportedNodeVersion()
  const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const [task, caseId, manifestArgument] = process.argv.slice(2)
  if (!task || !caseId) {
    throw new Error('Usage: npm run qa:task -- <task> <case> [manifest]')
  }
  const manifestPath = resolve(projectRoot, manifestArgument ?? `test/qa/manifests/task-${task}.json`)
  if (dirname(manifestPath) !== resolve(projectRoot, 'test/qa/manifests')) {
    throw new Error(`Manifest path escapes the manifest root: ${manifestPath}`)
  }
  await assertNoSymbolicLinks(projectRoot, manifestPath, 'Manifest path')
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
  selectCase(manifest, task, caseId)
  const repositoryRoot = resolve(projectRoot, '..')
  const evidenceDir = resolve(repositoryRoot, `.omo/evidence/musicbot-discord-webui/task-${task}`)
  const receipt = await runQaCase({ manifest, caseId, projectRoot, evidenceDir })
  console.log(`QA_TASK_OK task=${receipt.task} case=${receipt.case} receipt=${basename(evidenceDir)}/${caseId}.json`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
