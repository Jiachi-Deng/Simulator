export function createWindowsEnvironmentBlock(environment: Readonly<Record<string, string>>): Buffer {
  const entries = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right, 'en', { sensitivity: 'base' }))
    .map(([key, value]) => `${key}=${value}`)
  return Buffer.from(`${entries.join('\0')}\0\0`, 'utf16le')
}
