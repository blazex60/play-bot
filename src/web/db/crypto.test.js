import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decrypt, encrypt, getKeyId } from './crypto.js'

const KEY = Buffer.alloc(32, 7).toString('base64')

test('encrypt/decrypt: roundtrip hides plaintext', () => {
  process.env.MUSICBOT_TOKEN_ENC_KEY = KEY

  const encrypted = encrypt('spotify-access-token')

  assert.ok(Buffer.isBuffer(encrypted))
  assert.equal(encrypted.includes(Buffer.from('spotify-access-token')), false)
  assert.equal(decrypt(encrypted), 'spotify-access-token')
  assert.match(getKeyId(), /^[0-9a-f]{16}$/)
})

test('decrypt: tampered ciphertext fails soft', () => {
  process.env.MUSICBOT_TOKEN_ENC_KEY = KEY

  const encrypted = Buffer.from(encrypt('youtube-access-token'))
  encrypted[encrypted.length - 1] ^= 1

  assert.equal(decrypt(encrypted), null)
})
