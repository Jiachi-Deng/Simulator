import { describe, expect, it } from 'bun:test'
import { redactSecret } from '../secret-redaction'

describe('redactSecret', () => {
  it('redacts literal, encoded, and double-encoded secrets with mixed-case percent escapes', () => {
    const secret = 'PoC token/with?reserved=value'
    const encoded = encodeURIComponent(secret).replaceAll('%2F', '%2f').replaceAll('%3F', '%3f')
    const doubleEncoded = encodeURIComponent(encoded)
    const message = `literal=${secret} encoded=${encoded} double=${doubleEncoded}`

    const redacted = redactSecret(message, secret)

    expect(redacted).toBe('literal=[REDACTED] encoded=[REDACTED] double=[REDACTED]')
    expect(redacted).not.toContain(secret)
    expect(redacted).not.toContain(encoded)
    expect(redacted).not.toContain(doubleEncoded)
  })

  it('does not make literal secret matching case-insensitive', () => {
    expect(redactSecret('token=case-sensitive', 'Case-Sensitive')).toBe('token=case-sensitive')
  })
})
