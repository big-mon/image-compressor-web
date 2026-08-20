import { describe, expect, it } from 'vitest'

import {
  createCropSurfaceStyle,
  createStageTransform,
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
})
