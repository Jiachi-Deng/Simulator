import type { OpenDesignModuleViewBounds } from '../../shared/open-design-module-ipc'

/** Inner-round a DOM rectangle so a native view cannot spill over its Host-owned slot. */
export function toOpenDesignViewBounds(
  rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>,
): OpenDesignModuleViewBounds | null {
  if (rect.left < 0 || rect.top < 0) return null
  const x = Math.ceil(rect.left)
  const y = Math.ceil(rect.top)
  const right = Math.floor(rect.right)
  const bottom = Math.floor(rect.bottom)
  const width = right - x
  const height = bottom - y
  if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}
