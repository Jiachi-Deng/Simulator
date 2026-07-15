import { randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ModuleAgentPathAuthority, ModuleAgentTokenSource } from './types.ts'

export { ModuleAgentGatewayServer, type ModuleAgentLaunchLease, type ModuleAgentGatewayServerOptions } from './server.ts'

export class NodeModuleAgentPathAuthority implements ModuleAgentPathAuthority {
  async canonicalize(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new Error('Module Agent paths must be absolute')
    return resolve(await realpath(path))
  }

  isEqualOrWithin(candidate: string, root: string): boolean {
    const rel = relative(root, candidate)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
}

export class NodeModuleAgentTokenSource implements ModuleAgentTokenSource {
  createHex(bytes: number): string {
    return randomBytes(bytes).toString('hex')
  }
}
