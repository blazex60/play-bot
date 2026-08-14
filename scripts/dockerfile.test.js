import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const dockerfile = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'Dockerfile'),
  'utf8',
)

test('Dockerfile installs numpy into the Demucs venv before the model bake', () => {
  const venvInstall = dockerfile.match(/python3 -m venv \/opt\/demucs-venv[\s\S]*?get_model\('htdemucs'\)/)
  assert.ok(venvInstall, 'expected a Demucs venv install RUN that bakes htdemucs')
  assert.match(venvInstall[0], /\bnumpy\b/)
  assert.match(venvInstall[0], /\bdemucs\b/)
})
