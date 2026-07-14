import { relative, resolve } from 'node:path'
import { z } from 'zod'

const assertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('outputIncludes'), value: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('pathExists'), path: z.string().min(1) }).strict(),
])

const cleanupSchema = z.object({
  absentPaths: z.array(z.string().min(1)),
}).strict()

const resourceSchema = z.object({
  port: z.number().int().min(1024).max(65535),
  database: z.string().min(1),
  browserProfile: z.string().min(1),
  composeProject: z.string().min(1),
}).strict()

const stepSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  command: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  timeoutMs: z.number().int().min(50).max(120_000),
  assertions: z.array(assertionSchema).min(1, 'at least one assertion is required'),
  cleanup: cleanupSchema,
}).strict()

const caseSchema = z.object({
  resources: resourceSchema,
  steps: z.array(stepSchema).min(1),
}).strict()

const manifestSchema = z.object({
  version: z.literal(1),
  task: z.string().regex(/^(?:P0|[1-9]|1[0-7]|F[1-4])$/),
  cases: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), caseSchema)
    .refine((cases) => Object.keys(cases).length > 0, 'at least one case is required'),
}).strict()

function assertUniqueResources(manifest) {
  const owners = new Map()
  for (const [caseId, qaCase] of Object.entries(manifest.cases)) {
    for (const [kind, value] of Object.entries(qaCase.resources)) {
      const key = `${kind}:${value}`
      const owner = owners.get(key)
      if (owner) {
        throw new Error(`Resource collision: ${key} is shared by ${owner} and ${caseId}`)
      }
      owners.set(key, caseId)
    }
  }
}

export function parseManifest(raw) {
  const result = manifestSchema.safeParse(raw)
  if (!result.success) {
    throw new Error(`Invalid QA manifest: ${z.prettifyError(result.error)}`)
  }
  assertUniqueResources(result.data)
  return result.data
}

export function selectCase(manifest, task, caseId) {
  if (manifest.task !== task) {
    throw new Error(`Unknown task: requested ${task}, manifest owns ${manifest.task}`)
  }
  const qaCase = manifest.cases[caseId]
  if (!qaCase) {
    throw new Error(`Unknown case: ${caseId}`)
  }
  return qaCase
}

function assertInsideProject(projectRoot, path, label) {
  const relativePath = relative(projectRoot, resolve(projectRoot, path))
  if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`${label} escapes project root: ${path}`)
  }
}

export function validateManifestPaths(manifest, projectRoot) {
  for (const qaCase of Object.values(manifest.cases)) {
    for (const step of qaCase.steps) {
      assertInsideProject(projectRoot, step.cwd, 'Step cwd')
      for (const assertion of step.assertions) {
        if (assertion.kind === 'pathExists') {
          assertInsideProject(projectRoot, assertion.path, 'Assertion path')
        }
      }
      for (const path of step.cleanup.absentPaths) {
        assertInsideProject(projectRoot, path, 'Cleanup path')
      }
    }
  }
}
