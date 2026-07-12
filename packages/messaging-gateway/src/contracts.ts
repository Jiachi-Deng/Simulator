import type {
  CreateSessionOptions,
  FileAttachment,
  PermissionResponseOptions,
  SendMessageOptions,
  Session,
} from '@craft-agent/shared/protocol'
import type { StoredAttachment } from '@craft-agent/core/types'

import type {
  MessagingPlatformRuntimeInfo,
  PlatformAccessMode,
  PlatformOwner,
} from './types'

/**
 * Session-manager surface consumed by the messaging package.
 *
 * Keep this structural boundary local: importing server-core's broad handler
 * contract pulls its concrete SessionManager implementation into this package's
 * TypeScript program.
 */
export interface MessagingSessionManager {
  getSessions(workspaceId?: string): Session[]
  getSession(sessionId: string): Promise<Session | null>
  createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session>
  sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
  ): Promise<void>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: PermissionResponseOptions,
  ): boolean
  setPendingPlanExecution(
    sessionId: string,
    planPath: string,
    draftInputSnapshot?: string,
  ): Promise<void>
  clearPendingPlanExecution(sessionId: string): Promise<void>
  acceptPlan(sessionId: string, planPath?: string): Promise<void>
  setAutomationBinder?(
    fn: (input: { workspaceId: string; sessionId: string; topicName: string }) => Promise<void>,
  ): void
}

export interface MessagingBindingInfo {
  id: string
  workspaceId: string
  sessionId: string
  platform: string
  channelId: string
  threadId?: number
  channelName?: string
  enabled: boolean
  createdAt: number
  accessMode?: 'inherit' | 'allow-list' | 'open'
  allowedSenderIds?: string[]
}

export interface MessagingConfigInfo {
  enabled: boolean
  platforms: Record<
    string,
    | {
        enabled: boolean
        supergroup?: { chatId: string; title: string; capturedAt: number }
        accessMode?: PlatformAccessMode
        owners?: PlatformOwner[]
      }
    | undefined
  >
  runtime: Record<string, MessagingPlatformRuntimeInfo | undefined>
}
