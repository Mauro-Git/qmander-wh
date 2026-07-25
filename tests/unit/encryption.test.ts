import { describe, it, expect } from 'vitest'
import { encrypt, decrypt, encryptField, decryptField } from '../../src/lib/crypto.js'

describe('encrypt/decrypt', () => {
  it('round-trips a value', () => {
    const original = 'eyJhbGciOiJSUzI1NiIsInR5...'
    const { encrypted, iv, tag } = encrypt(original)
    expect(decrypt(encrypted, iv, tag)).toBe(original)
  })

  it('produces a different ciphertext for the same input each call (random IV)', () => {
    const a = encrypt('same_token')
    const b = encrypt('same_token')
    expect(a.iv).not.toBe(b.iv)
    expect(a.encrypted.equals(b.encrypted)).toBe(false)
  })

  it('fails to decrypt with the wrong tag', () => {
    const { encrypted, iv } = encrypt('secret')
    expect(() => decrypt(encrypted, iv, 'f'.repeat(32))).toThrow()
  })

  it('fails to decrypt with the wrong key', () => {
    const original = process.env.ENCRYPTION_KEY
    const { encrypted, iv, tag } = encrypt('secret')
    process.env.ENCRYPTION_KEY = 'c'.repeat(64)
    expect(() => decrypt(encrypted, iv, tag)).toThrow()
    process.env.ENCRYPTION_KEY = original
  })
})

describe('encryptField/decryptField', () => {
  it('round-trips a packed buffer', () => {
    const original = 'refresh-token-value'
    const packed = encryptField(original)
    expect(decryptField(packed)).toBe(original)
  })

  it('packs iv(16) || tag(16) || ciphertext', () => {
    const packed = encryptField('x')
    expect(packed.length).toBeGreaterThanOrEqual(32)
  })

  it('different inputs produce different packed buffers', () => {
    const a = encryptField('token_a')
    const b = encryptField('token_b')
    expect(a.equals(b)).toBe(false)
  })
})
