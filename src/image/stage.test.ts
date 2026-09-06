import { describe, expect, it } from 'vitest'

import {
  createCropSurfaceStyle,
  createStageTransform,
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

  it('returns the display aspect ratio with a responsive height-bound width', () => {
    expect(createCropSurfaceStyle({ width: 16, height: 32 })).toEqual({
      aspectRatio: '16 / 32',
      maxWidth: 'min(100%, calc(100cqh * 0.5))',
      marginInline: 'auto',
    })
  })

  it.each([
    [{ width: 0, height: 16 }],
    [{ width: 16, height: 0 }],
    [{ width: -1, height: 16 }],
    [{ width: 16, height: -1 }],
    [{ width: Number.NaN, height: 16 }],
    [{ width: 16, height: Number.POSITIVE_INFINITY }],
  ])('rejects invalid crop surface dimensions', (displaySize) => {
    expect(() => createCropSurfaceStyle(displaySize)).toThrow(
      'Crop surface dimensions must be positive numbers.',
    )
  })
})
