import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  currentDemucsDevice,
  looksLikeCudaError,
  markCudaFailed,
  requestedDemucsDevice,
  resetDemucsDeviceForTest,
  resolveDemucsDevice,
} from './demucsDevice.js'

test('requestedDemucsDevice: auto by default, explicit cuda/cpu honored', () => {
  assert.equal(requestedDemucsDevice({}), 'auto')
  assert.equal(requestedDemucsDevice({ DEMUCS_DEVICE: 'CUDA' }), 'cuda')
  assert.equal(requestedDemucsDevice({ DEMUCS_DEVICE: 'cpu' }), 'cpu')
  assert.equal(requestedDemucsDevice({ DEMUCS_DEVICE: 'gpu0' }), 'auto')
})

test('resolveDemucsDevice: auto probes once and caches; explicit values skip the probe', async () => {
  resetDemucsDeviceForTest()
  let probes = 0
  const probeFn = async () => { probes += 1; return true }
  assert.equal(currentDemucsDevice({}), 'cpu', 'unknown until probed')
  const [a, b] = await Promise.all([resolveDemucsDevice({ env: {}, probeFn }), resolveDemucsDevice({ env: {}, probeFn })])
  assert.deepEqual([a, b], ['cuda', 'cuda'])
  assert.equal(await resolveDemucsDevice({ env: {}, probeFn }), 'cuda')
  assert.equal(probes, 1)
  assert.equal(currentDemucsDevice({}), 'cuda')
  assert.equal(await resolveDemucsDevice({ env: { DEMUCS_DEVICE: 'cpu' }, probeFn }), 'cpu')
  resetDemucsDeviceForTest()
  assert.equal(await resolveDemucsDevice({ env: {}, probeFn: async () => false }), 'cpu')
  resetDemucsDeviceForTest()
})

test('markCudaFailed degrades even an explicit cuda request to cpu for the rest of the process', async () => {
  resetDemucsDeviceForTest()
  markCudaFailed(new Error('CUDA error: no kernel image'))
  assert.equal(await resolveDemucsDevice({ env: { DEMUCS_DEVICE: 'cuda' } }), 'cpu')
  assert.equal(currentDemucsDevice({ DEMUCS_DEVICE: 'cuda' }), 'cpu')
  resetDemucsDeviceForTest()
})

test('looksLikeCudaError separates GPU failures from bad input', () => {
  assert.equal(looksLikeCudaError('RuntimeError: CUDA out of memory. Tried to allocate'), true)
  assert.equal(looksLikeCudaError('torch.AcceleratorError: no kernel image is available'), true)
  assert.equal(looksLikeCudaError('Could not load file input.wav'), false)
})

test('a probe that could not run (null) falls back to cpu without caching, so the next call probes again', async () => {
  resetDemucsDeviceForTest()
  const answers = [null, true]
  let probes = 0
  const probeFn = async () => { probes += 1; return answers.shift() }
  assert.equal(await resolveDemucsDevice({ env: {}, probeFn }), 'cpu')
  assert.equal(currentDemucsDevice({}), 'cpu')
  assert.equal(await resolveDemucsDevice({ env: {}, probeFn }), 'cuda')
  assert.equal(probes, 2)
  resetDemucsDeviceForTest()
})
