import { readFile, stat } from 'node:fs/promises'
import type { MessagePortMain } from 'electron'
import {
  HostAgentBrokerServer,
  MessagePortByteCreditChannel,
  MessagePortHostAgentBrokerCoreClient,
} from '@simulator/host-agent-broker'
import {
  isHostAgentHostMessage,
  isHostAgentProtocolPath,
  isHostAgentWorkerAttachMessage,
  type HostAgentProtocolPath,
  type HostAgentWorkerReadyMessage,
} from './protocol'
import { startV1CompatibilityWorker, type V1CompatibilityWorkerRuntime } from './v1-worker-runtime'

interface WorkerRuntime {
  protocol: HostAgentProtocolPath
  epoch: string
  controlPort: MessagePortMain
  rpcPort: MessagePortMain
  broker?: HostAgentBrokerServer
  compatibility?: V1CompatibilityWorkerRuntime
  healthTimer?: ReturnType<typeof setInterval>
  shuttingDown: boolean
}

let runtime: WorkerRuntime | undefined
const utilityParentPort = process.parentPort

function failBootstrap(
  protocol: HostAgentProtocolPath,
  epoch: string,
  stage: 'attach' | 'token' | 'configuration' | 'runtime',
): void {
  try {
    utilityParentPort?.postMessage({ kind: 'simulator.host-agent.worker.bootstrap-failed', protocol, epoch, stage })
  } catch { /* Parent may already be unavailable. */ }
  setImmediate(() => process.exit(70))
}

function requiredInteger(name: string, minimum: number): number {
  const value = Number(process.env[name])
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError('Invalid Host Agent worker configuration')
  return value
}

async function readOwnerOnlyToken(): Promise<string> {
  const path = process.env.SIMULATOR_HOST_AGENT_TOKEN_FILE
  if (!path) throw new TypeError('Host Agent token file is missing')
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new TypeError('Host Agent token file is invalid')
  if (process.platform !== 'win32') {
    if ((metadata.mode & 0o777) !== 0o600) throw new TypeError('Host Agent token file is not owner-only')
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new TypeError('Host Agent token file owner is invalid')
    }
  }
  const token = await readFile(path, 'utf8')
  if (token.length < 32 || token.length > 512 || /[\u0000-\u0020\u007f]/u.test(token)) {
    throw new TypeError('Host Agent token is invalid')
  }
  return token
}

async function stopRuntime(exitCode: number): Promise<void> {
  const current = runtime
  if (!current || current.shuttingDown) return
  current.shuttingDown = true
  if (current.healthTimer) clearInterval(current.healthTimer)
  try { await current.broker?.stop() } catch { /* Worker exit remains isolated from Craft. */ }
  try { await current.compatibility?.stop() } catch { /* Worker exit remains isolated from Craft. */ }
  try {
    current.controlPort.postMessage({
      kind: 'simulator.host-agent.worker.shutdown-ack',
      protocol: current.protocol,
      epoch: current.epoch,
    })
  } catch { /* Parent may already be gone. */ }
  current.controlPort.close()
  current.rpcPort.close()
  setImmediate(() => process.exit(exitCode))
}

async function attach(event: Electron.MessageEvent): Promise<void> {
  const configuredProtocol = process.env.SIMULATOR_HOST_AGENT_PROTOCOL
  const configuredEpoch = process.env.SIMULATOR_HOST_AGENT_WORKER_EPOCH ?? 'invalid'
  if (!isHostAgentProtocolPath(configuredProtocol)) {
    process.exit(70)
    return
  }
  if (runtime || !isHostAgentWorkerAttachMessage(event.data) || event.ports.length !== 2) {
    failBootstrap(configuredProtocol, configuredEpoch, 'attach')
    return
  }
  const protocol = configuredProtocol
  const epoch = configuredEpoch
  if (!isHostAgentProtocolPath(protocol) || protocol !== event.data.protocol || epoch !== event.data.epoch) {
    failBootstrap(protocol, epoch, 'attach')
    return
  }
  const [controlPort, rpcPort] = event.ports
  if (!controlPort || !rpcPort) {
    failBootstrap(protocol, epoch, 'attach')
    return
  }
  const token = await readOwnerOnlyToken()
  const maxRssBytes = requiredInteger('SIMULATOR_HOST_AGENT_MAX_RSS_BYTES', 1)
  const healthIntervalMs = requiredInteger('SIMULATOR_HOST_AGENT_HEALTH_INTERVAL_MS', 100)
  runtime = { protocol, epoch, controlPort, rpcPort, shuttingDown: false }

  controlPort.on('message', (messageEvent) => {
    const message = messageEvent.data
    if (!runtime || !isHostAgentHostMessage(message)) return void stopRuntime(70)
    if (message.protocol !== runtime.protocol || message.epoch !== runtime.epoch) return void stopRuntime(70)
    if (message.kind === 'simulator.host-agent.worker.shutdown') void stopRuntime(0)
  })
  controlPort.start()

  let address: HostAgentWorkerReadyMessage['address']
  if (protocol === 'v2') {
    const channel = new MessagePortByteCreditChannel(rpcPort)
    const client = new MessagePortHostAgentBrokerCoreClient(channel)
    const broker = new HostAgentBrokerServer({ coreClient: client, bearerToken: token })
    runtime.broker = broker
    address = await broker.start()
  } else {
    const compatibility = await startV1CompatibilityWorker(rpcPort, () => void stopRuntime(70))
    runtime.compatibility = compatibility
    address = compatibility.address
  }

  const reportHealth = (): void => {
    const current = runtime
    if (!current || current.shuttingDown) return
    const rssBytes = process.memoryUsage().rss
    current.controlPort.postMessage({
      kind: 'simulator.host-agent.worker.health',
      protocol: current.protocol,
      epoch: current.epoch,
      rssBytes,
    })
    if (rssBytes > maxRssBytes) void stopRuntime(70)
  }
  runtime.healthTimer = setInterval(reportHealth, healthIntervalMs)
  runtime.healthTimer.unref()
  reportHealth()
  controlPort.postMessage({
    kind: 'simulator.host-agent.worker.ready',
    protocol,
    epoch,
    pid: process.pid,
    ...(address ? { address } : {}),
  } satisfies HostAgentWorkerReadyMessage)
}

if (!utilityParentPort) process.exit(70)
utilityParentPort.once('message', (event) => {
  void attach(event).catch(() => {
    const protocol = process.env.SIMULATOR_HOST_AGENT_PROTOCOL
    const epoch = process.env.SIMULATOR_HOST_AGENT_WORKER_EPOCH
    if (isHostAgentProtocolPath(protocol) && epoch) failBootstrap(protocol, epoch, 'runtime')
    else process.exit(70)
  })
})
process.once('SIGTERM', () => void stopRuntime(0))
process.once('SIGINT', () => void stopRuntime(0))
