import { describe, expect, it } from 'bun:test'
import { toOpenDesignViewBounds } from './open-design-view-bounds'

describe('toOpenDesignViewBounds', () => {
  it('inner-rounds fractional DOM coordinates', () => {
    expect(toOpenDesignViewBounds({ left: 220.2, top: 48.1, right: 1200.9, bottom: 800.8 }))
      .toEqual({ x: 221, y: 49, width: 979, height: 751 })
  })

  it('rejects empty or negative Host slots', () => {
    expect(toOpenDesignViewBounds({ left: -0.1, top: 48, right: 1200, bottom: 800 })).toBeNull()
    expect(toOpenDesignViewBounds({ left: 220.2, top: 48, right: 220.8, bottom: 800 })).toBeNull()
  })
})
