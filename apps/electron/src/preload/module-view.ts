import { contextBridge, ipcRenderer } from 'electron'
import {
  MODULE_VIEW_CHANNELS,
  MODULE_VIEW_TRANSPORT_VERSION,
  createModuleViewMessageEnvelope,
  isValidModuleId,
  isValidViewInstanceId,
  parseModuleViewEnvelope,
  type ModuleViewJsonValue,
} from '../shared/module-view-transport'

const MODULE_ID_ARGUMENT = '--simulator-module-id='
const VIEW_INSTANCE_ARGUMENT = '--simulator-view-instance-id='

function readIdentityArgument(prefix: string): string | undefined {
  const argument = process.argv.find((value) => value.startsWith(prefix))
  return argument?.slice(prefix.length)
}

const moduleId = readIdentityArgument(MODULE_ID_ARGUMENT)
const viewInstanceId = readIdentityArgument(VIEW_INSTANCE_ARGUMENT)

if (!isValidModuleId(moduleId) || !isValidViewInstanceId(viewInstanceId)) {
  throw new Error('Module view preload did not receive a valid bound identity')
}

type MessageListener = (payload: ModuleViewJsonValue) => void
const listeners = new Set<MessageListener>()

function sendFailure(code: string, message: string): void {
  ipcRenderer.send(MODULE_VIEW_CHANNELS.TO_HOST, {
    version: MODULE_VIEW_TRANSPORT_VERSION,
    direction: 'module-to-host',
    moduleId,
    viewInstanceId,
    type: 'failure',
    error: { code, message },
  })
}

ipcRenderer.on(MODULE_VIEW_CHANNELS.TO_MODULE, (_event, input: unknown) => {
  const parsed = parseModuleViewEnvelope(input, 'host-to-module')
  if (!parsed.ok) {
    sendFailure(parsed.code, parsed.message)
    return
  }
  if (parsed.value.moduleId !== moduleId || parsed.value.viewInstanceId !== viewInstanceId) {
    sendFailure('CROSS_TALK_BLOCKED', 'Host envelope identity does not match this module view')
    return
  }
  if (parsed.value.type !== 'message') {
    sendFailure('INVALID_ENVELOPE', 'Host channel only accepts message envelopes')
    return
  }

  for (const listener of [...listeners]) {
    try {
      listener(parsed.value.payload)
    } catch {
      sendFailure('LISTENER_FAILED', 'Module view message listener threw an exception')
    }
  }
})

const api = Object.freeze({
  version: MODULE_VIEW_TRANSPORT_VERSION,
  moduleId,
  viewInstanceId,
  send(payload: unknown): void {
    const envelope = createModuleViewMessageEnvelope(
      'module-to-host',
      moduleId,
      viewInstanceId,
      payload,
    )
    if (!envelope.ok) throw new TypeError(envelope.message)
    ipcRenderer.send(MODULE_VIEW_CHANNELS.TO_HOST, envelope.value)
  },
  onMessage(listener: MessageListener): () => void {
    if (typeof listener !== 'function') throw new TypeError('Module view listener must be a function')
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
})

contextBridge.exposeInMainWorld('simulatorModuleView', api)

ipcRenderer.send(MODULE_VIEW_CHANNELS.TO_HOST, {
  version: MODULE_VIEW_TRANSPORT_VERSION,
  direction: 'module-to-host',
  moduleId,
  viewInstanceId,
  type: 'ready',
})
