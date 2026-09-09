import { describe, expect, it } from 'vitest'

import {
  createCropSurfaceStyle,
  placeCropHandle,
  createStageTransform,
} from './stage'

describe('editor stage presentation helpers', () => {
  it('shares the straightening scale and angle before final-axis flips', () => {
    expect(createStageTransform(90, true, false, { degrees: -12.5, scale: 1.4 })).toBe(
      'translate(-50%, -50%) scaleX(-1) scaleY(1) scale(1.4) rotate(77.5deg)',
    )
  })
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

describe('crop handle placement', () => {
  it('keeps the nearest corner position when no control covers it', () => {
    expect(placeCropHandle({ x: 200, y: 300 }, { width: 800, height: 600 }, 44, [])).toEqual({ left: 156, top: 256 })
  })

  it('avoids the switch, compression and bottom panels with the whole tap target', () => {
    const controls = [
      { x: 300, y: 60, width: 180, height: 52 },
      { x: 460, y: 200, width: 320, height: 230 },
      { x: 8, y: 450, width: 600, height: 142 },
    ]
    for (const corner of [{ x: 400, y: 80 }, { x: 600, y: 350 }, { x: 420, y: 580 }]) {
      const p = placeCropHandle(corner, { width: 800, height: 600 }, 44, controls)
      expect(p.left).toBeGreaterThanOrEqual(0)
      expect(p.top).toBeGreaterThanOrEqual(0)
      expect(p.left + 44).toBeLessThanOrEqual(800)
      expect(p.top + 44).toBeLessThanOrEqual(600)
      for (const r of controls) expect(p.left + 44 <= r.x || p.left >= r.x + r.width || p.top + 44 <= r.y || p.top >= r.y + r.height).toBe(true)
    }
    expect(placeCropHandle({ x: 420, y: 580 }, { width: 800, height: 600 }, 44, [])).toEqual({ left: 376, top: 536 })
  })
})
