import { describe, expect, it } from 'vitest'

import {
  calculateImageGeometry,
  constrainCrop,
  createEditState,
  rotateEditState,
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
