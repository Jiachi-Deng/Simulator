import { describe, expect, it } from 'bun:test'
import {
  buildCompoundRoute,
  buildRouteFromNavigationState,
  parseCompoundRoute,
  parseRouteToNavigationState,
} from '../route-parser'
import { routes } from '../routes'

describe('Module routes', () => {
  it('round-trips the Module Center route', () => {
    expect(routes.view.modules()).toBe('modules')
    expect(parseCompoundRoute('modules')).toEqual({ navigator: 'modules', details: null })
    expect(parseRouteToNavigationState('modules')).toEqual({ navigator: 'modules', details: null })
    expect(buildRouteFromNavigationState({ navigator: 'modules', details: null })).toBe('modules')
  })

  it('round-trips the fixed OpenDesign stage and rejects unknown Modules', () => {
    const parsed = parseCompoundRoute('modules/open-design')
    expect(routes.view.modules('open-design')).toBe('modules/open-design')
    expect(parsed).toEqual({ navigator: 'modules', details: { type: 'module', id: 'open-design' } })
    expect(buildCompoundRoute(parsed!)).toBe('modules/open-design')
    expect(parseRouteToNavigationState('modules/open-design')).toEqual({
      navigator: 'modules',
      details: { type: 'module', moduleId: 'open-design' },
    })
    expect(parseCompoundRoute('modules/unknown')).toBeNull()
  })
})
