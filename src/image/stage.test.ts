import { describe, expect, it } from 'vitest'

import {
  fitView,
  zoomView,
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

it('keeps the pixel under the cursor stationary while zooming and clamps scale', () => {
  const view = { zoom: 1, x: 30, y: -20 }, point = { x: 100, y: 80 }
  const next = zoomView(view, -200, point)
  expect((point.x-next.x)/next.zoom).toBeCloseTo((point.x-view.x)/view.zoom)
  expect((point.y-next.y)/next.zoom).toBeCloseTo((point.y-view.y)/view.zoom)
  expect(zoomView({ ...view, zoom: 16 }, -1000, point).zoom).toBe(16)
  expect(zoomView({ ...view, zoom: 0.01 }, 1000, point).zoom).toBe(0.01)
})

it('fits portrait, landscape and cropped images without clipping or limiting small images to 100 percent', () => {
  for (const [image, viewport, zoom] of [
    [{ width: 4000, height: 3000 }, { width: 1280, height: 900 }, 0.3],
    [{ width: 1000, height: 600 }, { width: 390, height: 844 }, 0.39],
    [{ width: 600, height: 1000 }, { width: 820, height: 1180 }, 1.18],
    [{ width: 16, height: 32 }, { width: 1280, height: 900 }, 28.125],
  ] as const) {
    expect(fitView(image, viewport)).toEqual({ zoom, x: 0, y: 0 })
  }
  for (const zoom of [28.125, 0.005]) {
    const fitted = { zoom, x: 0, y: 0 }, point = { x: 0, y: 0 }
    const delta = zoom > 16 ? 100 : -100
    const next = zoomView(fitted, delta, point, zoom)
    expect(next.zoom).toBeCloseTo(zoom * Math.exp(-delta * 0.002))
    expect(zoomView(next, -delta, point, zoom).zoom).toBeCloseTo(zoom)
  }
})
