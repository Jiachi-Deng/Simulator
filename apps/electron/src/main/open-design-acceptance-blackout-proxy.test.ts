import { afterEach, describe, expect, it } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OPEN_DESIGN_BLACKOUT_PROXY_BUN_ENV,
  OPEN_DESIGN_BLACKOUT_PROXY_SCRIPT_ENV,
  OpenDesignAcceptanceBlackoutProxy,
  loadOpenDesignAcceptanceBlackoutProxy,
} from './open-design-acceptance-blackout-proxy'

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => (
    new Promise<void>((resolve) => server.close(() => resolve()))
  )))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenDesign acceptance external blackout proxy', () => {
  it('rejects incomplete, linked, or writable external process configuration', async () => {
    expect(loadOpenDesignAcceptanceBlackoutProxy({})).toBeUndefined()
    expect(() => loadOpenDesignAcceptanceBlackoutProxy({
      [OPEN_DESIGN_BLACKOUT_PROXY_BUN_ENV]: '/missing/bun',
    })).toThrow('incomplete')

    const root = await realpath(await mkdtemp(join(tmpdir(), 'simulator-blackout-proxy-paths-')))
    roots.push(root)
    const executable = join(root, 'bun')
    const script = join(root, 'proxy.ts')
    const linked = join(root, 'linked.ts')
    await writeFile(executable, '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(script, 'export {}\n', { mode: 0o644 })
    await chmod(executable, 0o755)
    await chmod(script, 0o666)
    await symlink(script, linked)
    expect(() => new OpenDesignAcceptanceBlackoutProxy({ bunPath: executable, scriptPath: script }))
      .toThrow('ownership')
    await chmod(script, 0o644)
    expect(() => new OpenDesignAcceptanceBlackoutProxy({ bunPath: executable, scriptPath: linked }))
      .toThrow('canonical')
  })

  it('passes URL/token only over child stdin, returns the proxy origin internally, and reaps the child', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'simulator-blackout-proxy-child-')))
    roots.push(root)
    const token = 'blackout-manager-test-token-0123456789abcdef'
    const tokenFile = join(root, 'grant.token')
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 })
    await chmod(tokenFile, 0o600)
    const server = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) return void response.writeHead(401).end()
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end('{"contractVersion":2,"capability":"host-agent.use"}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('upstream bind failed')
    const bunPath = await realpath(process.execPath)
    const scriptPath = await realpath(join(import.meta.dir, '../../../../scripts/qa/run-host-agent-blackout-proxy.ts'))
    const proxy = new OpenDesignAcceptanceBlackoutProxy({
      bunPath,
      scriptPath,
      controlTimeoutMs: 5_000,
      stopTimeoutMs: 2_000,
    })
    expect(proxy.getCapability()).toEqual({
      schemaVersion: 1,
      available: true,
      producer: 'external-host-agent-sse-proxy',
      blackoutMs: 65_000,
      heartbeatMs: 10_000,
    })
    const lease = await proxy.prepareLaunch({
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      tokenFile,
    })
    expect(lease.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/)
    expect(lease.url).not.toContain(token)
    expect(lease.url).not.toContain(tokenFile)
    const forwarded = await fetch(`${lease.url}/v2/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(forwarded.status).toBe(200)
    expect(await forwarded.json()).toEqual({ contractVersion: 2, capability: 'host-agent.use' })
    expect(await proxy.armNextBlackout({ caseId: 'D01', stack: 'new', turnOrdinal: 1 })).toMatchObject({
      schemaVersion: 1,
      armed: true,
      caseId: 'D01',
      turnOrdinal: 1,
      blackoutMs: 65_000,
      heartbeatMs: 10_000,
    })
    await lease.cleanup()
    await lease.cleanup()
    await expect(fetch(`${lease.url}/v2/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    })).rejects.toThrow()
    await proxy.dispose()
  }, 15_000)
})
