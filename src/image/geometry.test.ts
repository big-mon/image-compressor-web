import { describe, expect, it } from 'vitest'

import {
  applyZoomAndPan,
  calculateImageGeometry,
  calculateStraightening,
  constrainCrop,
  createEditState,
  resizeCropFromBottomRight,
  rotateEditState,
  translateCrop,
  type ImageEditState,
} from './geometry'

describe('image geometry', () => {
  it('starts with the full image in the normalized display orientation', () => {
    const sourceSize = { width: 400, height: 300 }

    const geometry = calculateImageGeometry(sourceSize, createEditState(sourceSize))

    expect(geometry.displaySize).toEqual({ width: 400, height: 300 })
    expect(geometry.crop).toEqual({ x: 0, y: 0, width: 400, height: 300 })
    expect(geometry.outputSize).toEqual({ width: 400, height: 300 })
  })

  it.each([90, 270] as const)('swaps the display dimensions for a %d-degree rotation', (rotation) => {
    const sourceSize = { width: 400, height: 300 }
    const state: ImageEditState = {
      ...createEditState(sourceSize),
      rotation,
      crop: { x: 0, y: 0, width: 300, height: 400 },
    }

    const geometry = calculateImageGeometry(sourceSize, state)

    expect(geometry.displaySize).toEqual({ width: 300, height: 400 })
    expect(geometry.sourceCrop).toEqual({ x: 0, y: 0, width: 400, height: 300 })
    expect(geometry.outputSize).toEqual({ width: 300, height: 400 })
  })

  it('maps a final-display crop through a horizontal flip', () => {
    const sourceSize = { width: 400, height: 300 }
    const state: ImageEditState = {
      ...createEditState(sourceSize),
      flipHorizontal: true,
      aspectRatio: 'free',
      crop: { x: 50, y: 40, width: 200, height: 100 },
    }

    const geometry = calculateImageGeometry(sourceSize, state)

    expect(geometry.sourceCrop).toEqual({ x: 150, y: 40, width: 200, height: 100 })
  })

  it('maps a final-display crop through a vertical flip', () => {
    const sourceSize = { width: 400, height: 300 }
    const state: ImageEditState = {
      ...createEditState(sourceSize),
      flipVertical: true,
      aspectRatio: 'free',
      crop: { x: 50, y: 40, width: 200, height: 100 },
    }

    const geometry = calculateImageGeometry(sourceSize, state)

    expect(geometry.sourceCrop).toEqual({ x: 50, y: 160, width: 200, height: 100 })
  })

  it('locks a crop to 1:1 inside the final display bounds', () => {
    const crop = constrainCrop(
      { x: 40, y: 20, width: 260, height: 120 },
      { width: 400, height: 300 },
      '1:1',
    )

    expect(crop).toEqual({ x: 110, y: 20, width: 120, height: 120 })
  })

  it('locks a crop to 4:3', () => {
    const crop = constrainCrop(
      { x: 40, y: 40, width: 200, height: 120 },
      { width: 400, height: 300 },
      '4:3',
    )

    expect(crop.width / crop.height).toBeCloseTo(4 / 3)
    expect(crop).toEqual({ x: 60, y: 40, width: 160, height: 120 })
  })

  it('locks a crop to 3:4', () => {
    const crop = constrainCrop(
      { x: 40, y: 40, width: 200, height: 120 },
      { width: 400, height: 300 },
      '3:4',
    )

    expect(crop.width / crop.height).toBeCloseTo(3 / 4)
    expect(crop).toEqual({ x: 95, y: 40, width: 90, height: 120 })
  })

  it('locks a crop to 3:2', () => {
    const crop = constrainCrop(
      { x: 40, y: 40, width: 200, height: 120 },
      { width: 400, height: 300 },
      '3:2',
    )

    expect(crop.width / crop.height).toBeCloseTo(3 / 2)
    expect(crop).toEqual({ x: 50, y: 40, width: 180, height: 120 })
  })

  it('locks a crop to 2:3', () => {
    const crop = constrainCrop(
      { x: 40, y: 40, width: 200, height: 120 },
      { width: 400, height: 300 },
      '2:3',
    )

    expect(crop.width / crop.height).toBeCloseTo(2 / 3)
    expect(crop).toEqual({ x: 100, y: 40, width: 80, height: 120 })
  })

  it('locks a crop to 16:9', () => {
    const crop = constrainCrop(
      { x: 40, y: 40, width: 200, height: 120 },
      { width: 400, height: 300 },
      '16:9',
    )

    expect(crop.width / crop.height).toBeCloseTo(16 / 9)
    expect(crop.width).toBe(200)
    expect(crop.height).toBeCloseTo(112.5)
    expect(crop.x).toBe(40)
    expect(crop.y).toBeCloseTo(43.75)
  })

  it('locks a crop to 9:16', () => {
    const crop = constrainCrop(
      { x: 40, y: 40, width: 200, height: 120 },
      { width: 400, height: 300 },
      '9:16',
    )

    expect(crop.width / crop.height).toBeCloseTo(9 / 16)
    expect(crop.width).toBeCloseTo(67.5)
    expect(crop.height).toBe(120)
    expect(crop.x).toBeCloseTo(106.25)
    expect(crop.y).toBe(40)
  })

  it('locks the original preset to the final display aspect ratio', () => {
    const crop = constrainCrop(
      { x: 40, y: 40, width: 200, height: 120 },
      { width: 400, height: 300 },
      'original',
    )

    expect(crop).toEqual({ x: 60, y: 40, width: 160, height: 120 })
  })

  it('calculates final crop dimensions from the locked display crop', () => {
    const sourceSize = { width: 400, height: 300 }
    const state: ImageEditState = {
      ...createEditState(sourceSize),
      aspectRatio: '1:1',
      crop: { x: 40, y: 20, width: 240, height: 100 },
    }

    const geometry = calculateImageGeometry(sourceSize, state)

    expect(geometry.crop).toEqual({ x: 110, y: 20, width: 100, height: 100 })
    expect(geometry.croppedSize).toEqual({ width: 100, height: 100 })
    expect(geometry.outputSize).toEqual({ width: 100, height: 100 })
  })

  it('resizes the output by width without changing the crop aspect ratio', () => {
    const sourceSize = { width: 400, height: 300 }
    const state: ImageEditState = {
      ...createEditState(sourceSize),
      resize: { width: 200 },
    }

    const geometry = calculateImageGeometry(sourceSize, state)

    expect(geometry.croppedSize).toEqual({ width: 400, height: 300 })
    expect(geometry.outputSize).toEqual({ width: 200, height: 150 })
  })

  it('resizes the output by height without changing the crop aspect ratio', () => {
    const sourceSize = { width: 400, height: 300 }
    const state: ImageEditState = {
      ...createEditState(sourceSize),
      resize: { height: 100 },
    }

    const geometry = calculateImageGeometry(sourceSize, state)

    expect(geometry.outputSize).toEqual({ width: 133, height: 100 })
  })

  it('bounds a free crop even when its position and size exceed the display', () => {
    const crop = constrainCrop(
      { x: -40, y: 260, width: 600, height: 100 },
      { width: 400, height: 300 },
      'free',
    )

    expect(crop).toEqual({ x: 0, y: 200, width: 400, height: 100 })
  })

  it.each([
    ['right', { x: 600, y: 0 }, { x: 600, y: 0 }],
    ['bottom', { x: 0, y: 300 }, { x: 0, y: 300 }],
    ['left', { x: -600, y: 0 }, { x: 0, y: 0 }],
    ['top', { x: 0, y: -300 }, { x: 0, y: 0 }],
  ] as const)('translates a crop to the %s display bound', (_edge, delta, expectedPosition) => {
    const crop = translateCrop(
      { x: 0, y: 0, width: 400, height: 300 },
      delta,
      { width: 1000, height: 600 },
      'free',
    )

    expect(crop).toEqual({ ...expectedPosition, width: 400, height: 300 })
  })

  it('translates the effective crop for an off-center zoomed frame', () => {
    const sourceSize = { width: 1000, height: 600 }
    const state: ImageEditState = {
      ...createEditState(sourceSize),
      aspectRatio: 'free',
      crop: { x: 100, y: 50, width: 400, height: 300 },
      zoom: 2,
      panX: 0.25,
      panY: -0.4,
    }

    const effectiveCrop = calculateImageGeometry(sourceSize, state).crop

    expect(effectiveCrop).toEqual({ x: 350, y: 75, width: 200, height: 150 })
    expect(translateCrop(
      effectiveCrop,
      { x: 600, y: 490 },
      sourceSize,
      'free',
    )).toEqual({ x: 800, y: 450, width: 200, height: 150 })
  })

  it.each([
    ['left', -1, 0, 0, 50],
    ['right', 1, 0, 600, 50],
    ['top', 0, -1, 100, 0],
    ['bottom', 0, 1, 100, 300],
  ] as const)('reaches the off-center %s edge at a normalized pan endpoint', (_edge, panX, panY, expectedX, expectedY) => {
    expect(applyZoomAndPan(
      { x: 100, y: 50, width: 400, height: 300 },
      { width: 1000, height: 600 },
      1,
      panX,
      panY,
    )).toEqual({ x: expectedX, y: expectedY, width: 400, height: 300 })
  })

  it.each([
    ['negative X', -0.25, 0, 75, 50],
    ['positive X', 0.25, 0, 225, 50],
    ['negative Y', 0, -0.4, 100, 30],
    ['positive Y', 0, 0.4, 100, 150],
  ] as const)('interpolates an off-center crop for an intermediate %s pan', (_axis, panX, panY, expectedX, expectedY) => {
    expect(applyZoomAndPan(
      { x: 100, y: 50, width: 400, height: 300 },
      { width: 1000, height: 600 },
      1,
      panX,
      panY,
    )).toEqual({ x: expectedX, y: expectedY, width: 400, height: 300 })
  })

  it('interpolates from the zoomed neutral origin to each edge', () => {
    expect(applyZoomAndPan(
      { x: 100, y: 50, width: 400, height: 300 },
      { width: 1000, height: 600 },
      2,
      0.25,
      -0.4,
    )).toEqual({ x: 350, y: 75, width: 200, height: 150 })
  })

  it('keeps the only origin when the effective crop has zero travel', () => {
    expect(applyZoomAndPan(
      { x: 0, y: 0, width: 1000, height: 600 },
      { width: 1000, height: 600 },
      1,
      -1,
      1,
    )).toEqual({ x: 0, y: 0, width: 1000, height: 600 })
  })

  it('preserves the selected aspect ratio when resizing the effective crop', () => {
    const crop = constrainCrop(
      { x: 300, y: 35, width: 320, height: 260 },
      { width: 1000, height: 600 },
      '4:3',
    )

    expect(crop).toEqual({ x: 300, y: 45, width: 320, height: 240 })
    expect(crop.width / crop.height).toBeCloseTo(4 / 3)
  })

  describe('bottom-right anchored crop resizing', () => {
    it('keeps the top-left fixed for free horizontal, vertical, and diagonal drags', () => {
      const crop = { x: 40, y: 30, width: 100, height: 100 }
      const displaySize = { width: 400, height: 300 }

      expect(resizeCropFromBottomRight(crop, { x: 60, y: 0 }, displaySize, 'free')).toEqual({
        x: 40,
        y: 30,
        width: 160,
        height: 100,
      })
      expect(resizeCropFromBottomRight(crop, { x: 0, y: 60 }, displaySize, 'free')).toEqual({
        x: 40,
        y: 30,
        width: 100,
        height: 160,
      })
      expect(resizeCropFromBottomRight(crop, { x: 60, y: 40 }, displaySize, 'free')).toEqual({
        x: 40,
        y: 30,
        width: 160,
        height: 140,
      })
    })

    it('projects horizontal and vertical pointer movement onto a fixed ratio', () => {
      const crop = { x: 40, y: 30, width: 120, height: 90 }
      const displaySize = { width: 400, height: 300 }

      const horizontal = resizeCropFromBottomRight(crop, { x: 60, y: 0 }, displaySize, '4:3')
      expect(horizontal.x).toBe(40)
      expect(horizontal.y).toBe(30)
      expect(horizontal.width).toBeCloseTo(158.4)
      expect(horizontal.height).toBeCloseTo(118.8)

      const vertical = resizeCropFromBottomRight(crop, { x: 0, y: 60 }, displaySize, '4:3')
      expect(vertical.x).toBe(40)
      expect(vertical.y).toBe(30)
      expect(vertical.width).toBeCloseTo(148.8)
      expect(vertical.height).toBeCloseTo(111.6)
    })

    it('keeps mixed-sign fixed-ratio pointer movement continuous', () => {
      const crop = { x: 40, y: 30, width: 100, height: 100 }
      const displaySize = { width: 400, height: 300 }
      const before = resizeCropFromBottomRight(crop, { x: 49, y: -50 }, displaySize, '1:1')
      const after = resizeCropFromBottomRight(crop, { x: 50, y: -50 }, displaySize, '1:1')

      expect(before.width).toBeCloseTo(99.5)
      expect(after.width).toBeCloseTo(100)
      expect(Math.abs(after.width - before.width)).toBeLessThan(2)
    })

    it('keeps the anchor while clamping expansion and shrinkage to valid bounds', () => {
      const crop = { x: 280, y: 190, width: 100, height: 80 }
      const displaySize = { width: 400, height: 300 }

      expect(resizeCropFromBottomRight(crop, { x: 500, y: 500 }, displaySize, 'free')).toEqual({
        x: 280,
        y: 190,
        width: 120,
        height: 110,
      })
      expect(resizeCropFromBottomRight(crop, { x: -500, y: -500 }, displaySize, 'free')).toEqual({
        x: 280,
        y: 190,
        width: 1,
        height: 1,
      })

      const fixed = resizeCropFromBottomRight(
        { x: 250, y: 150, width: 100, height: 100 },
        { x: 500, y: 500 },
        displaySize,
        '1:1',
      )
      expect(fixed).toEqual({ x: 250, y: 150, width: 150, height: 150 })
    })

    it('uses the effective crop anchor after rotation and zoom/pan', () => {
      const sourceSize = { width: 1000, height: 600 }
      const state: ImageEditState = {
        ...createEditState(sourceSize),
        rotation: 90,
        aspectRatio: 'free',
        crop: { x: 80, y: 50, width: 400, height: 300 },
        zoom: 2,
        panX: 0.25,
        panY: -0.4,
      }
      const geometry = calculateImageGeometry(sourceSize, state)
      const resized = resizeCropFromBottomRight(
        geometry.crop,
        { x: 40, y: 20 },
        geometry.displaySize,
        state.aspectRatio,
      )

      expect(resized.x).toBe(geometry.crop.x)
      expect(resized.y).toBe(geometry.crop.y)
      expect(resized.width).toBe(geometry.crop.width + 40)
      expect(resized.height).toBe(geometry.crop.height + 20)
    })
  })

  it('applies zoom and clamps normalized pan inside the display bounds', () => {
    const sourceSize = { width: 400, height: 300 }
    const state: ImageEditState = {
      ...createEditState(sourceSize),
      aspectRatio: 'free',
      zoom: 2,
      panX: 4,
      panY: -4,
    }

    const geometry = calculateImageGeometry(sourceSize, state)

    expect(geometry.crop).toEqual({ x: 200, y: 0, width: 200, height: 150 })
  })

  it('rotates a non-full crop through canonical dimensions on four right turns', () => {
    const sourceSize = { width: 400, height: 300 }
    let state: ImageEditState = {
      ...createEditState(sourceSize),
      aspectRatio: 'free',
      crop: { x: 0, y: 40, width: 300, height: 200 },
    }

    const expectedStates = [
      {
        rotation: 90,
        displaySize: { width: 300, height: 400 },
        crop: { x: 40, y: 100, width: 200, height: 300 },
      },
      {
        rotation: 180,
        displaySize: { width: 400, height: 300 },
        crop: { x: 100, y: 60, width: 300, height: 200 },
      },
      {
        rotation: 270,
        displaySize: { width: 300, height: 400 },
        crop: { x: 60, y: 0, width: 200, height: 300 },
      },
      {
        rotation: 0,
        displaySize: { width: 400, height: 300 },
        crop: { x: 0, y: 40, width: 300, height: 200 },
      },
    ] as const

    for (const expected of expectedStates) {
      state = rotateEditState(sourceSize, state, 90)
      expect(state.rotation).toBe(expected.rotation)
      expect(calculateImageGeometry(sourceSize, state).displaySize).toEqual(expected.displaySize)
      expect(state.crop).toEqual(expected.crop)
    }
  })

  it('rotates a non-full crop through canonical dimensions on four left turns', () => {
    const sourceSize = { width: 400, height: 300 }
    let state: ImageEditState = {
      ...createEditState(sourceSize),
      aspectRatio: 'free',
      crop: { x: 0, y: 40, width: 300, height: 200 },
    }

    const expectedStates = [
      {
        rotation: 270,
        displaySize: { width: 300, height: 400 },
        crop: { x: 60, y: 0, width: 200, height: 300 },
      },
      {
        rotation: 180,
        displaySize: { width: 400, height: 300 },
        crop: { x: 100, y: 60, width: 300, height: 200 },
      },
      {
        rotation: 90,
        displaySize: { width: 300, height: 400 },
        crop: { x: 40, y: 100, width: 200, height: 300 },
      },
      {
        rotation: 0,
        displaySize: { width: 400, height: 300 },
        crop: { x: 0, y: 40, width: 300, height: 200 },
      },
    ] as const

    for (const expected of expectedStates) {
      state = rotateEditState(sourceSize, state, -90)
      expect(state.rotation).toBe(expected.rotation)
      expect(calculateImageGeometry(sourceSize, state).displaySize).toEqual(expected.displaySize)
      expect(state.crop).toEqual(expected.crop)
    }
  })

  it('preserves flips and other edit semantics while resetting effective framing', () => {
    const sourceSize = { width: 400, height: 300 }
    const state: ImageEditState = {
      ...createEditState(sourceSize),
      aspectRatio: '3:2',
      flipHorizontal: true,
      flipVertical: true,
      crop: { x: 20, y: 30, width: 260, height: 180 },
      zoom: 2,
      panX: 0.5,
      panY: -0.25,
      resize: { width: 200 },
    }

    const rotated = rotateEditState(sourceSize, state, 90)

    expect(rotated).toMatchObject({
      rotation: 90,
      flipHorizontal: true,
      flipVertical: true,
      aspectRatio: '3:2',
      resize: { width: 200 },
      zoom: 1,
      panX: 0,
      panY: 0,
    })
  })
})


describe('straightening', () => {
  it.each([NaN, Infinity, -Infinity, 45.1, -45.1])('rejects invalid angle %s', degrees => {
    expect(() => calculateStraightening({ width: 400, height: 300 }, degrees)).toThrow(/Straightening/)
  })

  it.each([{ width: 400, height: 300 }, { width: 300, height: 400 }, { width: 1000, height: 100 }])('covers every corner without changing the frame: %j', size => {
    for (const rotation of [0, 90, 180, 270] as const) {
      for (const straighten of [-45, -17.3, 0, 17.3, 45]) {
        for (const flipHorizontal of [false, true]) {
          for (const flipVertical of [false, true]) {
            const state = { ...createEditState(size), rotation, straighten, flipHorizontal, flipVertical, aspectRatio: 'free' as const,
              crop: { x: 0, y: 0, width: 10000, height: 10000 } }
            const geometry = calculateImageGeometry(size, state)
            const zero = calculateImageGeometry(size, { ...state, straighten: 0 })
            expect(geometry.crop).toEqual(zero.crop)
            expect(geometry.outputSize).toEqual(zero.outputSize)
            // Bounding all four inverse-mapped corners also bounds every interior point.
            expect(geometry.sourceCrop.x).toBeGreaterThanOrEqual(-1e-9)
            expect(geometry.sourceCrop.y).toBeGreaterThanOrEqual(-1e-9)
            expect(geometry.sourceCrop.x + geometry.sourceCrop.width).toBeLessThanOrEqual(size.width + 1e-9)
            expect(geometry.sourceCrop.y + geometry.sourceCrop.height).toBeLessThanOrEqual(size.height + 1e-9)
            const touchesEdge = Math.min(Math.abs(geometry.sourceCrop.x), Math.abs(geometry.sourceCrop.y))
            expect(touchesEdge).toBeLessThan(1e-9)
          }
        }
      }
    }
  })

  it('inverts a non-centered crop through scale, angle and final-axis flip', () => {
    const size = { width: 400, height: 300 }
    const state = { ...createEditState(size), straighten: 30, flipHorizontal: true, aspectRatio: 'free' as const, crop: { x: 240, y: 50, width: 40, height: 60 } }
    const geometry = calculateImageGeometry(size, state)
    const radians = -Math.PI / 6
    const points = ([[240, 50], [280, 50], [240, 110], [280, 110]] as const).map(([x, y]) => {
      const dx = (400 - x - 200) / geometry.straightening.scale
      const dy = (y - 150) / geometry.straightening.scale
      return { x: 200 + dx * Math.cos(radians) - dy * Math.sin(radians), y: 150 + dx * Math.sin(radians) + dy * Math.cos(radians) }
    })
    expect(geometry.sourceCrop.x).toBeCloseTo(Math.min(...points.map(p => p.x)))
    expect(geometry.sourceCrop.y).toBeCloseTo(Math.min(...points.map(p => p.y)))
    expect(calculateImageGeometry(size, createEditState(size)).straightening).toEqual({ degrees: 0, scale: 1 })
  })
})
