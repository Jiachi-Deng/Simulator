const REDACTION = '[REDACTED]'

interface PatternUnit {
  char: string
  foldHexCase: boolean
}

function encodeUnits(units: PatternUnit[]): PatternUnit[] {
  const encoded: PatternUnit[] = []

  for (const unit of units) {
    const value = encodeURIComponent(unit.char)
    if (value === unit.char) {
      encoded.push(unit)
      continue
    }

    for (const char of value) {
      encoded.push({
        char,
        foldHexCase: char !== '%' && /[a-f]/i.test(char),
      })
    }
  }

  return encoded
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toPattern(units: PatternUnit[]): string {
  return units.map(({ char, foldHexCase }) => {
    if (foldHexCase && /[a-f]/i.test(char)) {
      return `[${char.toLowerCase()}${char.toUpperCase()}]`
    }
    return escapeRegExp(char)
  }).join('')
}

/** Redact a secret in literal, percent-encoded, or double-encoded form. */
export function redactSecret(message: string, secret?: string): string {
  if (!secret) return message

  const literal = Array.from(secret, (char) => ({ char, foldHexCase: false }))
  const encoded = encodeUnits(literal)
  const doubleEncoded = encodeUnits(encoded)
  const patterns = [literal, encoded, doubleEncoded]
    .map(toPattern)
    .filter((pattern, index, all) => pattern && all.indexOf(pattern) === index)
    .sort((a, b) => b.length - a.length)

  let redacted = message
  for (const pattern of patterns) {
    redacted = redacted.replace(new RegExp(pattern, 'g'), REDACTION)
  }
  return redacted
}
