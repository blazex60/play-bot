import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outputDir = mkdtempSync(resolve(tmpdir(), 'music-bot-vite-'))
try {
  const vite = resolve(projectRoot, 'node_modules/vite/bin/vite.js')
  const result = spawnSync(
    process.execPath,
    [vite, 'build', '--config', 'web/vite.config.js', '--outDir', outputDir],
    { cwd: projectRoot, stdio: 'inherit' }
  )
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`Vite build exited with ${result.status}`)
  }
  console.log('P0_VITE_BUILD_OK')
} finally {
  rmSync(outputDir, { recursive: true, force: true })
}
