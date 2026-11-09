import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/** New client key: prefix + 32 random bytes (base64url, 43 chars). */
export const generateKey = (prefix) => prefix + randomBytes(32).toString('base64url')

/** Constant-time string comparison (hashing first makes lengths equal). */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest()
  const hb = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(ha, hb)
}

export function parseEncryptionKey(value) {
  if (!value) return null
  const v = value.trim()
  if (/^[0-9a-f]{64}$/i.test(v)) return Buffer.from(v, 'hex')
  const b = Buffer.from(v, 'base64')
  return b.length === 32 ? b : null
}

/** AES-256-GCM. Output: "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encrypt(plaintext, key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.')
}

export function decrypt(payload, key) {
  const [version, iv, tag, ct] = String(payload).split('.')
  if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unsupported ciphertext format')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
}
