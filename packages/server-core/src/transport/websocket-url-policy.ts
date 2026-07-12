export type WebSocketUrlPolicyErrorCode =
  | 'INVALID_WEBSOCKET_URL'
  | 'WEBSOCKET_URL_USERINFO_NOT_ALLOWED'
  | 'INSECURE_WEBSOCKET_URL'

export interface WebSocketUrlPolicyError {
  code: WebSocketUrlPolicyErrorCode
  message: string
}

export interface WebSocketUrlPolicyResult {
  diagnosticUrl: string
  error?: WebSocketUrlPolicyError
  isLoopback: boolean
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/** Validate an outbound WebSocket URL and derive its credential-free diagnostic form. */
export function evaluateWebSocketUrl(url: string): WebSocketUrlPolicyResult {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return {
      diagnosticUrl: '',
      isLoopback: false,
      error: {
        code: 'INVALID_WEBSOCKET_URL',
        message: 'Invalid WebSocket server URL',
      },
    }
  }

  const diagnosticUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  const isLoopback = isLoopbackHostname(parsed.hostname)

  if (parsed.username || parsed.password) {
    return {
      diagnosticUrl,
      isLoopback,
      error: {
        code: 'WEBSOCKET_URL_USERINFO_NOT_ALLOWED',
        message: 'WebSocket server URL must not include userinfo',
      },
    }
  }

  if (parsed.protocol === 'wss:' || (parsed.protocol === 'ws:' && isLoopback)) {
    return { diagnosticUrl, isLoopback }
  }

  return {
    diagnosticUrl,
    isLoopback,
    error: {
      code: 'INSECURE_WEBSOCKET_URL',
      message: parsed.protocol === 'ws:'
        ? 'Unencrypted WebSocket connections are restricted to loopback hosts; use wss:// for remote servers'
        : 'WebSocket server URL must use wss://, or ws:// for a loopback host',
    },
  }
}
