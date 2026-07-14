import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const artifactRoot = mkdtempSync(resolve(tmpdir(), 'music-bot-playwright-'))
try {
  const playwright = resolve(projectRoot, 'node_modules/@playwright/test/cli.js')
  const result = spawnSync(
    process.execPath,
    [playwright, 'test', '--config', 'test/browser/playwright.config.mjs', ...process.argv.slice(2)],
    {
      cwd: projectRoot,
      env: { ...process.env, P0_PLAYWRIGHT_OUTPUT_DIR: artifactRoot },
      stdio: 'inherit',
    }
  )
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`Playwright exited with ${result.status}`)
  }
  console.log('P0_CHROMIUM_RUN_OK')
} finally {
  rmSync(artifactRoot, { recursive: true, force: true })
}
