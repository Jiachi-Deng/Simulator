import { describe, expect, test } from 'bun:test'
import type { ModuleProcess, ModuleSpawnRequest, ProcessExit, WindowsJobProcessFactory } from './types.ts'
import { loopbackHealthUrl, RealProcessAdapter } from './real-adapters.ts'
import { createWindowsEnvironmentBlock } from './windows-environment.ts'

class StubProcess implements ModuleProcess {
  readonly pid = 77
  readonly exited = Promise.resolve<ProcessExit>({ exitCode: 0, signal: null })
  async stopTree(): Promise<void> {}
}

class StubWindowsJobFactory implements WindowsJobProcessFactory {
  requests: ModuleSpawnRequest[] = []
  readonly process = new StubProcess()

  async spawn(request: ModuleSpawnRequest): Promise<ModuleProcess> {
    this.requests.push(request)
    return this.process
  }
}

const request: ModuleSpawnRequest = {
  executable: 'C:\\activated\\module.exe',
  args: [],
  cwd: 'C:\\activated',
  env: { SIMULATOR_MODULE_ID: 'org.simulator.test', PATH: 'C:\\Windows\\System32' },
  shell: false,
}

describe('RealProcessAdapter Windows routing', () => {
  test('routes the exact shell-free request through an injected Job Object factory', async () => {
    const factory = new StubWindowsJobFactory()
    const adapter = new RealProcessAdapter({ platform: 'win32', windowsJobFactory: factory })
    const spawned = await adapter.spawn(request)

    expect(spawned).toBe(factory.process)
    expect(factory.requests).toEqual([request])
  })

  test('encodes a deterministic double-null-terminated UTF-16 environment block', () => {
    const block = createWindowsEnvironmentBlock({ ZED: 'last', alpha: 'first' })
    expect(block.toString('utf16le')).toBe('alpha=first\0ZED=last\0\0')
  })
})

describe('LoopbackHttpHealthAdapter URL formatting', () => {
  test('brackets an IPv6 loopback host', () => {
    expect(loopbackHealthUrl({ host: '::1', port: 41_000 })).toBe('http://[::1]:41000/health')
    expect(loopbackHealthUrl({ host: '127.0.0.1', port: 41_000 })).toBe('http://127.0.0.1:41000/health')
  })
})
