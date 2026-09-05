import { describe, expect, it } from 'vitest'

import {
  CROP_SURFACE_DESKTOP_MAX_HEIGHT_PX,
  CROP_SURFACE_MOBILE_MAX_HEIGHT_PX,
  createCropSurfaceStyle,
  createStageTransform,
  getCropSurfaceMaxWidthPx,
  getCropSurfaceMaxWidthRem,
} from './stage'

describe('editor stage presentation helpers', () => {
  it('rotates before applying a horizontal flip in final display axes', () => {
    expect(createStageTransform(90, true, false)).toBe(
      'translate(-50%, -50%) scaleX(-1) scaleY(1) rotate(90deg)',
    )
  })

  it('rotates before applying a vertical flip in final display axes', () => {
    expect(createStageTransform(90, false, true)).toBe(
      'translate(-50%, -50%) scaleX(1) scaleY(-1) rotate(90deg)',
    )
  })

  it('calculates the portrait max width from the height cap', () => {
    expect(getCropSurfaceMaxWidthRem({ width: 16, height: 32 })).toBe(21)
    expect(createCropSurfaceStyle({ width: 16, height: 32 })).toEqual({
      aspectRatio: '16 / 32',
      maxWidth: '21rem',
      marginInline: 'auto',
    })
  })

  it('calculates the landscape width from the desktop height cap', () => {
    expect(getCropSurfaceMaxWidthPx({ width: 16, height: 9 }, CROP_SURFACE_DESKTOP_MAX_HEIGHT_PX)).toBeCloseTo(320 * 16 / 9)
  })

  it('calculates a panorama width without applying a container cap', () => {
    expect(getCropSurfaceMaxWidthPx({ width: 10, height: 1 }, CROP_SURFACE_DESKTOP_MAX_HEIGHT_PX)).toBe(3200)
    expect(getCropSurfaceMaxWidthPx({ width: 10, height: 1 }, CROP_SURFACE_MOBILE_MAX_HEIGHT_PX)).toBe(2000)
  })

  it('calculates the portrait width from the mobile height cap', () => {
    expect(getCropSurfaceMaxWidthPx({ width: 16, height: 32 }, CROP_SURFACE_MOBILE_MAX_HEIGHT_PX)).toBe(100)
  })

  it.each([
    [{ width: 0, height: 16 }, 320],
    [{ width: 16, height: 0 }, 320],
    [{ width: -1, height: 16 }, 320],
    [{ width: 16, height: -1 }, 320],
    [{ width: Number.NaN, height: 16 }, 320],
    [{ width: 16, height: Number.POSITIVE_INFINITY }, 320],
    [{ width: 16, height: 9 }, 0],
    [{ width: 16, height: 9 }, Number.NaN],
  ])('rejects invalid crop surface dimensions or height caps', (displaySize, heightCap) => {
    expect(() => getCropSurfaceMaxWidthPx(displaySize, heightCap)).toThrow(
      'Crop surface dimensions and height cap must be positive numbers.',
    )
  })
})
