import { expect, test } from 'bun:test'

import type { MessagingSessionManager } from '../contracts'

const sessionManager = {
  getSessions: () => [],
  getSession: async () => null,
  createSession: async () => {
    throw new Error('not used')
  },
  sendMessage: async () => {},
  cancelProcessing: async () => {},
  respondToPermission: () => true,
  setPendingPlanExecution: async () => {},
  clearPendingPlanExecution: async () => {},
  acceptPlan: async () => {},
} satisfies MessagingSessionManager

test('MessagingSessionManager is implementable without server-core internals', () => {
  expect(sessionManager.getSessions()).toEqual([])
})
