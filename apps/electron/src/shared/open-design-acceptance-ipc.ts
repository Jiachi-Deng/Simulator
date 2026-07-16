export const OPEN_DESIGN_ACCEPTANCE_CHANNELS = Object.freeze({
  IS_AVAILABLE: 'open-design-acceptance:is-available',
  GET_STATE: 'open-design-acceptance:get-state',
  UPDATE_TO_RC: 'open-design-acceptance:update-to-rc',
  ROLLBACK: 'open-design-acceptance:rollback',
})

export type OpenDesignAcceptanceStatus = 'ready' | 'busy' | 'error'
export type OpenDesignAcceptanceAction = 'updateToRc' | 'rollback'

export interface OpenDesignAcceptanceOperationEvidence {
  readonly operationId: string
  readonly kind: 'update' | 'rollback'
  readonly ok: boolean
}

/** Deliberately narrow, non-secret evidence returned only by the gated acceptance surface. */
export interface OpenDesignAcceptanceState {
  readonly status: OpenDesignAcceptanceStatus
  readonly hostVersion: '0.12.0'
  readonly activeVersion: string | null
  readonly lastKnownGoodVersion: string | null
  readonly installedVersions: readonly string[]
  readonly action?: OpenDesignAcceptanceAction
  readonly operation?: OpenDesignAcceptanceOperationEvidence
  readonly errorCode?: string
}

/** No method accepts renderer-controlled release, URL, hash, module, or operation identifiers. */
export interface OpenDesignAcceptanceFacade {
  getState(): Promise<OpenDesignAcceptanceState>
  updateToRc(): Promise<OpenDesignAcceptanceState>
  rollback(): Promise<OpenDesignAcceptanceState>
}
