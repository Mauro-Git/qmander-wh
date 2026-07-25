import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY
  if (!key) throw new Error('ENCRYPTION_KEY no está configurada')
  const buf = Buffer.from(key, 'hex')
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY debe ser de 32 bytes (64 caracteres hex)')
  return buf
}

export function encrypt(text: string): { encrypted: Buffer; iv: string; tag: string } {
  const iv = randomBytes(16)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return { encrypted, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') }
}

export function decrypt(encrypted: Buffer, iv: string, tag: string): string {
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, 'hex'))
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8')
}

/**
 * Variante autocontenida: empaqueta iv(16) || tag(16) || ciphertext en un solo
 * Buffer. Cada llamada genera su propio IV, así que es segura para encriptar
 * varios secretos distintos con la misma ENCRYPTION_KEY sin reutilizar IV
 * (crítico en AES-GCM: reusar IV+key rompe la confidencialidad y la
 * autenticación).
 */
export function encryptField(text: string): Buffer {
  const { encrypted, iv, tag } = encrypt(text)
  return Buffer.concat([Buffer.from(iv, 'hex'), Buffer.from(tag, 'hex'), encrypted])
}

export function decryptField(packed: Buffer): string {
  const iv = packed.subarray(0, 16)
  const tag = packed.subarray(16, 32)
  const encrypted = packed.subarray(32)
  return decrypt(encrypted, iv.toString('hex'), tag.toString('hex'))
}
