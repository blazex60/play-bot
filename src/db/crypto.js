import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

let cachedKey = null
let cachedSource = null

function decodeKey(source = process.env.MUSICBOT_TOKEN_ENC_KEY) {
  if (!source) {
    throw new Error('MUSICBOT_TOKEN_ENC_KEY is required')
  }

  if (source === cachedSource && cachedKey) return cachedKey

  const base64 = Buffer.from(source, 'base64')
  const raw = Buffer.from(source)
  const key = base64.length === 32 ? base64 : raw

  if (key.length !== 32) {
    throw new Error('MUSICBOT_TOKEN_ENC_KEY must decode to 32 bytes')
  }

  cachedSource = source
  cachedKey = key
  return key
}

export function getKeyId(source = process.env.MUSICBOT_TOKEN_ENC_KEY) {
  const key = decodeKey(source)
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

export function encrypt(plaintext) {
  const key = decodeKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext])
}

export function decrypt(blob) {
  if (!blob) return null

  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  if (buffer.length < IV_LENGTH + AUTH_TAG_LENGTH) return null

  const key = decodeKey()
  const iv = buffer.subarray(0, IV_LENGTH)
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8')
  } catch (err) {
    return null
  }
}

export function isCurrentKeyId(keyId) {
  const current = Buffer.from(getKeyId())
  const stored = Buffer.from(String(keyId ?? ''))
  return current.length === stored.length && timingSafeEqual(current, stored)
}
